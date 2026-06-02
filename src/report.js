(function () {
  var DATA = window.__COPILOT_DATA__;
  var PALETTE = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#84cc16'];

  function fmt(n) { return typeof n === 'number' ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'; }
  function fmtCredits(n) { if (typeof n !== 'number') return '—'; return state.showDollars ? '$' + (n * 0.01).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : fmt(n) + ' credits'; }
  function toChartVal(credits) { return state.showDollars ? Math.round(credits * 0.01 * 100) / 100 : Math.round(credits * 1000) / 1000; }
  function fmtDate(ts) { return ts ? new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  var state = { dateFrom: null, dateTo: null, selectedProjects: new Set(), showDollars: false };
  var charts = {};

  function filteredProjects() {
    return DATA.projects
      .filter(function (p) { return state.selectedProjects.size === 0 || state.selectedProjects.has(p.project); })
      .map(function (p) {
        var sessions = p.sessions.map(function (s) {
          var reqs = s.requests.filter(function (r) {
            if (!r.timestamp) return true;
            if (state.dateFrom && r.timestamp < state.dateFrom) return false;
            if (state.dateTo && r.timestamp > state.dateTo) return false;
            return true;
          });
          return Object.assign({}, s, { requests: reqs });
        }).filter(function (s) { return s.requests.length > 0; });
        var totalCredits = Math.round(sessions.reduce(function (a, s) { return a + s.requests.reduce(function (b, r) { return b + (r.credits || 0); }, 0); }, 0) * 1000) / 1000;
        return Object.assign({}, p, { sessions: sessions, totalCredits: totalCredits });
      })
      .filter(function (p) { return p.sessions.length > 0; });
  }

  function allRequests(projects) {
    return projects.reduce(function (acc, p) { return acc.concat(p.sessions.reduce(function (a, s) { return a.concat(s.requests); }, [])); }, []);
  }

  function destroyChart(key) { if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

  function render() {
    var projects = filteredProjects();
    var requests = allRequests(projects);
    var grandTotal = Math.round(projects.reduce(function (a, p) { return a + p.totalCredits; }, 0) * 1000) / 1000;
    var promptTokens = requests.reduce(function (a, r) { return a + (r.promptTokens || 0); }, 0);
    var outputTokens = requests.reduce(function (a, r) { return a + (r.outputTokens || 0); }, 0);

    document.getElementById('app').innerHTML =
      buildHeader() +
      buildFilters() +
      buildKpis(grandTotal, projects.length, requests.length, promptTokens, outputTokens) +
      buildChartSlots() +
      buildTable(projects) +
      buildDrillDown(projects) +
      '<div class="footer">copilot-credits &bull; data from VS Code workspaceStorage</div>';

    attachEvents();
    renderCharts(projects, requests);
  }

  function buildHeader() {
    return '<div class="header"><h1>Copilot Credits Report</h1><p class="meta">Generated ' + esc(fmtDate(new Date(DATA.generatedAt).getTime())) + '</p></div>';
  }

  function buildKpis(grandTotal, projectCount, requestCount, promptTokens, outputTokens) {
    function card(label, value, sub) {
      return '<div class="kpi-card"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="sub">' + sub + '</div></div>';
    }
    return '<div class="kpi-grid">' +
      card(state.showDollars ? 'Total Cost (est.)' : 'Total Credits', fmtCredits(grandTotal), projectCount + ' project' + (projectCount !== 1 ? 's' : '')) +
      card('Requests', fmt(requestCount), 'across all sessions') +
      card('Prompt Tokens', fmt(promptTokens), 'input') +
      card('Output Tokens', fmt(outputTokens), 'generated') +
      '</div>';
  }

  function buildFilters() {
    var opts = DATA.projects.map(function (p) {
      return '<option value="' + esc(p.project) + '"' + (state.selectedProjects.has(p.project) ? ' selected' : '') + '>' + esc(p.projectName) + '</option>';
    }).join('');
    function toVal(ts) { return ts ? new Date(ts).toISOString().slice(0, 10) : ''; }
    return '<div class="filters">' +
      '<div class="filter-group"><label for="f-from">From</label><input type="date" id="f-from" value="' + toVal(state.dateFrom) + '" /></div>' +
      '<div class="filter-group"><label for="f-to">To</label><input type="date" id="f-to" value="' + toVal(state.dateTo) + '" /></div>' +
      '<div class="filter-group"><label for="f-proj">Projects <span style="font-weight:400">(ctrl+click)</span></label><select id="f-proj" multiple>' + opts + '</select></div>' +
      '<div class="filter-group filter-group--toggle"><label class="toggle-label"><input type="checkbox" id="f-dollars"' + (state.showDollars ? ' checked' : '') + ' /><span>Show in $ <span class="toggle-disclaimer">(1 credit = $0.01)</span></span></label></div>' +
      '<button class="btn-reset" id="f-reset">Reset filters</button>' +
      '</div>';
  }

  function buildChartSlots() {
    var unit = state.showDollars ? 'Cost (est.)' : 'Credits';
    return '<div class="charts-grid">' +
      '<div class="chart-card"><h3>By Project</h3><div class="chart-wrap"><canvas id="chart-bar"></canvas></div></div>' +
      '<div class="chart-card"><h3>By Model</h3><div class="chart-wrap"><canvas id="chart-doughnut"></canvas></div></div>' +
      '<div class="chart-card wide"><h3>' + unit + ' Over Time</h3><div class="chart-wrap"><canvas id="chart-line"></canvas></div></div>' +
      '</div>';
  }

  function buildTable(projects) {
    if (!projects.length) return '<div class="empty">No data matches the current filters.</div>';
    var rows = projects.map(function (p) {
      var reqs = allRequests([p]);
      var pt = reqs.reduce(function (a, r) { return a + (r.promptTokens || 0); }, 0);
      var ot = reqs.reduce(function (a, r) { return a + (r.outputTokens || 0); }, 0);
      var models = Array.from(new Set(reqs.map(function (r) { return r.model; }).filter(Boolean))).join(', ');
      return '<tr><td>' + esc(p.projectName) + '</td><td class="num">' + fmtCredits(p.totalCredits) + '</td><td class="num">' + p.sessions.length + '</td><td class="num">' + fmt(pt) + '</td><td class="num">' + fmt(ot) + '</td><td style="color:var(--text2)">' + esc(models) + '</td></tr>';
    }).join('');
    return '<div class="section"><h2>Projects</h2><div class="table-wrap"><table><thead><tr><th>Project</th><th class="num">' + (state.showDollars ? 'Cost (est.)' : 'Credits') + '</th><th class="num">Sessions</th><th class="num">Prompt Tokens</th><th class="num">Output Tokens</th><th>Models</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  function buildDrillDown(projects) {
    if (!projects.length) return '';
    var items = projects.map(function (p) {
      var sessions = p.sessions.map(function (s) {
        var reqRows = s.requests.map(function (r) {
          return '<tr><td>' + esc(r.model || '—') + '</td><td class="num">' + fmtCredits(r.credits) + '</td><td class="num">' + fmt(r.promptTokens) + '</td><td class="num">' + fmt(r.outputTokens) + '</td><td style="color:var(--text2)">' + fmtDate(r.timestamp) + '</td></tr>';
        }).join('');
        return '<div class="session-header">Session: ' + esc(s.sessionId || s.chatFile) + ' &bull; ' + fmtCredits(s.totalCredits) + ' &bull; ' + s.requests.length + ' requests</div>' +
          '<div class="table-wrap"><table><thead><tr><th>Model</th><th class="num">' + (state.showDollars ? 'Cost (est.)' : 'Credits') + '</th><th class="num">Prompt Tokens</th><th class="num">Output Tokens</th><th>Timestamp</th></tr></thead><tbody>' + reqRows + '</tbody></table></div>';
      }).join('');
      return '<div class="accordion"><div class="accordion-header" data-accordion><span>' + esc(p.projectName) + ' <span class="proj-meta">' + fmtCredits(p.totalCredits) + '</span></span><i class="chevron">&#9654;</i></div><div class="accordion-body">' + sessions + '</div></div>';
    }).join('');
    return '<div class="section"><h2>Session Drill-Down</h2>' + items + '</div>';
  }

  function attachEvents() {
    var fromEl = document.getElementById('f-from');
    var toEl = document.getElementById('f-to');
    var projEl = document.getElementById('f-proj');
    var resetEl = document.getElementById('f-reset');
    if (fromEl) fromEl.addEventListener('change', function (e) { state.dateFrom = e.target.value ? new Date(e.target.value).getTime() : null; render(); });
    if (toEl) toEl.addEventListener('change', function (e) { state.dateTo = e.target.value ? new Date(e.target.value + 'T23:59:59').getTime() : null; render(); });
    if (projEl) projEl.addEventListener('change', function (e) { state.selectedProjects = new Set(Array.from(e.target.selectedOptions).map(function (o) { return o.value; })); render(); });
    var dollarsEl = document.getElementById('f-dollars');
    if (dollarsEl) dollarsEl.addEventListener('change', function (e) { state.showDollars = e.target.checked; render(); });
    if (resetEl) resetEl.addEventListener('click', function () { state = { dateFrom: null, dateTo: null, selectedProjects: new Set(), showDollars: state.showDollars }; render(); });
    document.querySelectorAll('[data-accordion]').forEach(function (h) {
      h.addEventListener('click', function () {
        h.classList.toggle('open');
        h.nextElementSibling && h.nextElementSibling.classList.toggle('open');
      });
    });
  }

  function renderCharts(projects, requests) {
    var textColor = cssVar('--text2') || '#6b7280';
    var gridColor = cssVar('--border') || '#e5e7eb';

    // Bar chart
    destroyChart('bar');
    var barCtx = document.getElementById('chart-bar');
    if (barCtx && projects.length) {
      var barUnit = state.showDollars ? 'Cost (est.)' : 'Credits';
      charts['bar'] = new Chart(barCtx, {
        type: 'bar',
        data: {
          labels: projects.map(function (p) { return p.projectName; }),
          datasets: [{ label: barUnit, data: projects.map(function (p) { return toChartVal(p.totalCredits); }), backgroundColor: projects.map(function (_, i) { return PALETTE[i % PALETTE.length] + 'cc'; }), borderColor: projects.map(function (_, i) { return PALETTE[i % PALETTE.length]; }), borderWidth: 1, borderRadius: 4 }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return ' ' + (state.showDollars ? '$' + c.parsed.y.toFixed(2) : c.parsed.y + ' credits'); } } } }, scales: { x: { ticks: { color: textColor }, grid: { color: gridColor } }, y: { ticks: { color: textColor, callback: function (v) { return state.showDollars ? '$' + v.toFixed(2) : v; } }, grid: { color: gridColor }, beginAtZero: true } } }
      });
    }

    // Doughnut chart
    destroyChart('doughnut');
    var doCtx = document.getElementById('chart-doughnut');
    if (doCtx && requests.length) {
      var byModel = {};
      requests.forEach(function (r) { var m = r.model || 'Unknown'; byModel[m] = (byModel[m] || 0) + (r.credits || 0); });
      var sorted = Object.entries(byModel).sort(function (a, b) { return b[1] - a[1]; });
      charts['doughnut'] = new Chart(doCtx, {
        type: 'doughnut',
        data: { labels: sorted.map(function (e) { return e[0]; }), datasets: [{ data: sorted.map(function (e) { return toChartVal(e[1]); }), backgroundColor: sorted.map(function (_, i) { return PALETTE[i % PALETTE.length] + 'cc'; }), borderColor: sorted.map(function (_, i) { return PALETTE[i % PALETTE.length]; }), borderWidth: 1 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: textColor, boxWidth: 12, padding: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: function (c) { return ' ' + (state.showDollars ? '$' + c.parsed.toFixed(2) : c.parsed + ' credits'); } } } } }
      });
    }

    // Line chart
    destroyChart('line');
    var lineCtx = document.getElementById('chart-line');
    if (lineCtx) {
      var byDay = {};
      requests.forEach(function (r) { if (!r.timestamp) return; var d = new Date(r.timestamp).toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + (r.credits || 0); });
      var days = Object.keys(byDay).sort();
      if (days.length === 0) {
        var card = lineCtx.closest('.chart-card');
        if (card) card.innerHTML = '<h3>Credits Over Time</h3><p style="color:var(--text2);padding:16px">No timestamp data available.</p>';
      } else {
        var lineLabel = state.showDollars ? 'Cost / day' : 'Credits / day';
        charts['line'] = new Chart(lineCtx, {
          type: 'line',
          data: { labels: days, datasets: [{ label: lineLabel, data: days.map(function (d) { return toChartVal(byDay[d]); }), borderColor: PALETTE[0], backgroundColor: PALETTE[0] + '33', fill: true, tension: 0.3, pointRadius: days.length > 30 ? 0 : 3 }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return ' ' + (state.showDollars ? '$' + c.parsed.y.toFixed(2) : c.parsed.y + ' credits'); } } } }, scales: { x: { ticks: { color: textColor, maxTicksLimit: 12 }, grid: { color: gridColor } }, y: { ticks: { color: textColor, callback: function (v) { return state.showDollars ? '$' + v.toFixed(2) : v; } }, grid: { color: gridColor }, beginAtZero: true } } }
        });
      }
    }
  }

  if (!DATA || !DATA.projects) {
    document.getElementById('app').innerHTML = '<div class="empty">No data available.</div>';
  } else {
    render();
  }
})();

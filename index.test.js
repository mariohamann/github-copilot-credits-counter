import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parseCreditsFromLine, parseCreditsFromRequestEntry, parseSession, detectStoragePath, aggregateProjects } from './index.js';

const FIXTURES_DIR = new URL('./fixtures/workspaceStorage', import.meta.url).pathname;
const fixtureLines = (workspace, session) =>
  fs.readFileSync(path.join(FIXTURES_DIR, workspace, 'chatSessions', session), 'utf8')
    .split('\n').filter(Boolean);

// ---------------------------------------------------------------------------
// parseCreditsFromLine
// ---------------------------------------------------------------------------

describe('parseCreditsFromLine', () => {
  test('returns null for a line without details', () => {
    const line = JSON.stringify({ kind: 0, v: { version: 3, requests: [] } });
    assert.equal(parseCreditsFromLine(line), null);
  });

  test('returns null for a kind:1 result line without credits in details', () => {
    const line = JSON.stringify({
      kind: 1,
      k: ['requests', 0, 'result'],
      v: { details: 'Claude Sonnet 4.6', resolvedModel: 'claude-sonnet-4-6', sessionId: 's1', responseId: 'r1', metadata: {} },
    });
    assert.equal(parseCreditsFromLine(line), null);
  });

  test('returns null for invalid JSON', () => {
    assert.equal(parseCreditsFromLine('not json'), null);
  });

  test('parses a result line with integer-like credits', () => {
    const line = JSON.stringify({
      kind: 1,
      k: ['requests', 0, 'result'],
      v: {
        details: 'Claude Sonnet 4.6 • 38.0 credits',
        metadata: {
          promptTokens: 1000,
          outputTokens: 200,
          resolvedModel: 'claude-sonnet-4-6',
          sessionId: 'session-1',
          responseId: 'resp-1',
        },
      },
    });
    const result = parseCreditsFromLine(line);
    assert.deepEqual(result, {
      requestIndex: 0,
      model: 'Claude Sonnet 4.6',
      credits: 38.0,
      promptTokens: 1000,
      outputTokens: 200,
      sessionId: 'session-1',
      responseId: 'resp-1',
      resolvedModel: 'claude-sonnet-4-6',
    });
  });

  test('parses a result line with decimal credits', () => {
    const line = JSON.stringify({
      kind: 1,
      k: ['requests', 1, 'result'],
      v: {
        details: 'Claude Sonnet 4.6 • 4.9 credits',
        metadata: {
          promptTokens: 93952,
          outputTokens: 1245,
          resolvedModel: 'claude-sonnet-4-6',
          sessionId: 'session-2',
          responseId: 'resp-2',
        },
      },
    });
    const result = parseCreditsFromLine(line);
    assert.equal(result.credits, 4.9);
    assert.equal(result.requestIndex, 1);
    assert.equal(result.promptTokens, 93952);
    assert.equal(result.outputTokens, 1245);
    assert.equal(result.responseId, 'resp-2');
    assert.equal(result.sessionId, 'session-2');
  });

  test('returns null for a kind:1 line that is not a result (e.g. inputState patch)', () => {
    const line = JSON.stringify({
      kind: 1,
      k: ['inputState', 'inputText'],
      v: 'some text',
    });
    assert.equal(parseCreditsFromLine(line), null);
  });
});

// ---------------------------------------------------------------------------
// parseCreditsFromRequestEntry  (kind:2 request objects)
// ---------------------------------------------------------------------------

describe('parseCreditsFromRequestEntry', () => {
  test('returns null when entry has no result.details', () => {
    const entry = { requestId: 'r1', timestamp: 1700000000000, responseId: 'resp-1' };
    assert.equal(parseCreditsFromRequestEntry(entry), null);
  });

  test('returns null when result.details has no credits', () => {
    const entry = { requestId: 'r1', timestamp: 1700000000000, responseId: 'resp-1', result: { details: 'Claude Sonnet 4.6' } };
    assert.equal(parseCreditsFromRequestEntry(entry), null);
  });

  test('parses credits from result.details', () => {
    const entry = {
      requestId: 'r1',
      timestamp: 1700000001234,
      responseId: 'resp-1',
      result: {
        details: 'Claude Sonnet 4.6 • 5.7 credits',
        resolvedModel: 'claude-sonnet-4-6',
        sessionId: 'session-x',
        metadata: { promptTokens: 500, outputTokens: 100 },
      },
    };
    const result = parseCreditsFromRequestEntry(entry);
    assert.deepEqual(result, {
      model: 'Claude Sonnet 4.6',
      credits: 5.7,
      promptTokens: 500,
      outputTokens: 100,
      sessionId: 'session-x',
      responseId: 'resp-1',
      resolvedModel: 'claude-sonnet-4-6',
      timestamp: 1700000001234,
    });
  });
});

// ---------------------------------------------------------------------------
// parseSession
// ---------------------------------------------------------------------------

describe('parseSession', () => {
  const makeRequestLine = (requests) =>
    JSON.stringify({ kind: 2, k: ['requests'], v: requests });

  const makeResultLine = (index, credits, sessionId = 's1', responseId = 'r1') =>
    JSON.stringify({
      kind: 1,
      k: ['requests', index, 'result'],
      v: {
        details: `Claude Sonnet 4.6 • ${credits} credits`,
        metadata: { promptTokens: 100, outputTokens: 50, resolvedModel: 'claude-sonnet-4-6', sessionId, responseId },
      },
    });

  test('returns empty array for a session with no credit lines', () => {
    const lines = [
      JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }),
      JSON.stringify({ kind: 1, k: ['inputState', 'inputText'], v: 'hello' }),
    ];
    assert.deepEqual(parseSession(lines), []);
  });

  test('extracts a single credit entry with timestamp from kind:2 line', () => {
    const lines = [
      makeRequestLine([{ requestId: 'req-0', timestamp: 1700000000000, responseId: 'r1' }]),
      makeResultLine(0, 5.5),
    ];
    const results = parseSession(lines);
    assert.equal(results.length, 1);
    assert.equal(results[0].credits, 5.5);
    assert.equal(results[0].timestamp, 1700000000000);
  });

  test('correlates multiple requests by index', () => {
    const lines = [
      makeRequestLine([
        { requestId: 'req-0', timestamp: 1700000000000, responseId: 'r0' },
        { requestId: 'req-1', timestamp: 1700000001000, responseId: 'r1' },
      ]),
      makeResultLine(0, 10.0, 's1', 'r0'),
      makeResultLine(1, 4.9, 's1', 'r1'),
    ];
    const results = parseSession(lines);
    assert.equal(results.length, 2);
    assert.equal(results[0].credits, 10.0);
    assert.equal(results[0].timestamp, 1700000000000);
    assert.equal(results[1].credits, 4.9);
    assert.equal(results[1].timestamp, 1700000001000);
  });

  test('sets timestamp to null when no matching kind:2 line exists', () => {
    const lines = [makeResultLine(0, 7.0)];
    const results = parseSession(lines);
    assert.equal(results.length, 1);
    assert.equal(results[0].timestamp, null);
  });

  test('deduplicates by responseId when same response appears in both kind:1 and kind:2', () => {
    const resultLine = JSON.stringify({
      kind: 1,
      k: ['requests', 0, 'result'],
      v: {
        details: 'Claude Sonnet 4.6 • 38.0 credits',
        metadata: {
          promptTokens: 1000,
          outputTokens: 200,
          resolvedModel: 'claude-sonnet-4-6',
          sessionId: 's1',
          responseId: 'resp-A',
        },
      },
    });
    // kind:2 line that also contains the same responseId with different details
    const requestArrayLine = JSON.stringify({
      kind: 2,
      k: ['requests'],
      v: [
        {
          requestId: 'req-0',
          timestamp: 1700000000000,
          responseId: 'resp-A',
          result: {
            details: 'Claude Sonnet 4.6 • 5.7 credits',
            resolvedModel: 'claude-sonnet-4-6',
            sessionId: 's1',
            metadata: { promptTokens: 500, outputTokens: 100 },
          },
        },
      ],
    });
    const lines = [resultLine, requestArrayLine];
    const results = parseSession(lines);
    // Should have exactly 1 entry (deduplicated), keeping the kind:2 version (last write wins)
    assert.equal(results.length, 1);
    assert.equal(results[0].responseId, 'resp-A');
    assert.equal(results[0].credits, 5.7);
    assert.equal(results[0].timestamp, 1700000000000);
  });

  test('captures credits that only exist in kind:2 request array (no kind:1 result line)', () => {
    const requestArrayLine = JSON.stringify({
      kind: 2,
      k: ['requests'],
      v: [
        {
          requestId: 'req-0',
          timestamp: 1700000005000,
          responseId: 'resp-B',
          result: {
            details: 'Claude Sonnet 4.6 • 5.7 credits',
            resolvedModel: 'claude-sonnet-4-6',
            sessionId: 's1',
            metadata: { promptTokens: 800, outputTokens: 150 },
          },
        },
      ],
    });
    const lines = [requestArrayLine];
    const results = parseSession(lines);
    assert.equal(results.length, 1);
    assert.equal(results[0].credits, 5.7);
    assert.equal(results[0].timestamp, 1700000005000);
  });

  test('uses latest kind:2 line when multiple are present', () => {
    const lines = [
      // First kind:2: only 1 request
      makeRequestLine([{ requestId: 'req-0', timestamp: 1700000000000, responseId: 'r0' }]),
      // Second kind:2: updated with both requests
      makeRequestLine([
        { requestId: 'req-0', timestamp: 1700000000000, responseId: 'r0' },
        { requestId: 'req-1', timestamp: 1700000009999, responseId: 'r1' },
      ]),
      makeResultLine(1, 3.3, 's1', 'r1'),
    ];
    const results = parseSession(lines);
    assert.equal(results.length, 1);
    assert.equal(results[0].timestamp, 1700000009999);
  });
});

// ---------------------------------------------------------------------------
// detectStoragePath
// ---------------------------------------------------------------------------

describe('detectStoragePath', () => {
  test('returns a non-empty string for current platform', () => {
    const p = detectStoragePath();
    assert.equal(typeof p, 'string');
    assert.ok(p.length > 0);
    assert.ok(p.includes('workspaceStorage'), `Expected path to contain "workspaceStorage", got: ${p}`);
  });

  test('returns macOS path when platform is darwin', () => {
    const p = detectStoragePath('darwin');
    assert.ok(p.includes('Library/Application Support/Code/User/workspaceStorage'), `Got: ${p}`);
  });

  test('returns Windows path when platform is win32', () => {
    const p = detectStoragePath('win32');
    assert.ok(p.toLowerCase().includes('code\\user\\workspacestorage') || p.includes('Code/User/workspaceStorage'), `Got: ${p}`);
  });

  test('returns Linux path for linux platform', () => {
    const p = detectStoragePath('linux');
    assert.ok(p.includes('.config/Code/User/workspaceStorage'), `Got: ${p}`);
  });
});

// ---------------------------------------------------------------------------
// aggregateProjects
// ---------------------------------------------------------------------------

describe('aggregateProjects', () => {
  test('returns empty array for no input', () => {
    assert.deepEqual(aggregateProjects([]), []);
  });

  test('sums credits correctly for a single project', () => {
    const sessions = [
      {
        workspaceHash: 'hash1',
        project: 'file:///home/user/my-project',
        chatFile: 'chatSessions/abc.jsonl',
        sessionId: 's1',
        requests: [
          { credits: 10.0, requestIndex: 0, timestamp: 1700000000000, model: 'Claude Sonnet 4.6', promptTokens: 100, outputTokens: 50, sessionId: 's1', responseId: 'r0', resolvedModel: 'claude-sonnet-4-6' },
          { credits: 5.5, requestIndex: 1, timestamp: 1700000001000, model: 'Claude Sonnet 4.6', promptTokens: 200, outputTokens: 80, sessionId: 's1', responseId: 'r1', resolvedModel: 'claude-sonnet-4-6' },
        ],
      },
    ];
    const result = aggregateProjects(sessions);
    assert.equal(result.length, 1);
    assert.equal(result[0].project, 'file:///home/user/my-project');
    assert.equal(result[0].projectName, 'my-project');
    assert.equal(result[0].totalCredits, 15.5);
    assert.equal(result[0].sessions.length, 1);
    assert.equal(result[0].sessions[0].totalCredits, 15.5);
  });

  test('groups sessions from the same project together', () => {
    const sessions = [
      {
        workspaceHash: 'hash1',
        project: 'file:///home/user/my-project',
        chatFile: 'chatSessions/abc.jsonl',
        sessionId: 's1',
        requests: [{ credits: 10.0, requestIndex: 0, timestamp: null, model: 'M', promptTokens: 0, outputTokens: 0, sessionId: 's1', responseId: 'r0', resolvedModel: 'm' }],
      },
      {
        workspaceHash: 'hash2',
        project: 'file:///home/user/my-project',
        chatFile: 'chatSessions/def.jsonl',
        sessionId: 's2',
        requests: [{ credits: 3.0, requestIndex: 0, timestamp: null, model: 'M', promptTokens: 0, outputTokens: 0, sessionId: 's2', responseId: 'r0', resolvedModel: 'm' }],
      },
    ];
    const result = aggregateProjects(sessions);
    assert.equal(result.length, 1);
    assert.equal(result[0].totalCredits, 13.0);
    assert.equal(result[0].sessions.length, 2);
  });

  test('creates separate entries for different projects', () => {
    const sessions = [
      {
        workspaceHash: 'hash1',
        project: 'file:///home/user/project-a',
        chatFile: 'chatSessions/a.jsonl',
        sessionId: 's1',
        requests: [{ credits: 5.0, requestIndex: 0, timestamp: null, model: 'M', promptTokens: 0, outputTokens: 0, sessionId: 's1', responseId: 'r0', resolvedModel: 'm' }],
      },
      {
        workspaceHash: 'hash2',
        project: 'file:///home/user/project-b',
        chatFile: 'chatSessions/b.jsonl',
        sessionId: 's2',
        requests: [{ credits: 8.0, requestIndex: 0, timestamp: null, model: 'M', promptTokens: 0, outputTokens: 0, sessionId: 's2', responseId: 'r0', resolvedModel: 'm' }],
      },
    ];
    const result = aggregateProjects(sessions);
    assert.equal(result.length, 2);
    const totals = result.map((r) => r.totalCredits).sort();
    assert.deepEqual(totals, [5.0, 8.0]);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — fixture workspaceStorage
// ---------------------------------------------------------------------------

describe('integration: fixture workspaceStorage', () => {
  test('session-aaa: captures kind:1 entry + kind:2-only entry (no double-counting)', () => {
    const lines = fixtureLines('abc123abc123abc123abc123abc123ab', 'session-aaa.jsonl');
    const requests = parseSession(lines);
    assert.equal(requests.length, 2);
    const credits = requests.map((r) => r.credits).sort((a, b) => a - b);
    assert.deepEqual(credits, [8.3, 12.5]);
    const total = Math.round(requests.reduce((s, r) => s + r.credits, 0) * 1000) / 1000;
    assert.equal(total, 20.8);
  });

  test('session-aaa: kind:1 entry has correct timestamp from kind:2 request line', () => {
    const lines = fixtureLines('abc123abc123abc123abc123abc123ab', 'session-aaa.jsonl');
    const requests = parseSession(lines);
    const req0 = requests.find((r) => r.responseId === 'resp-aaa-0001');
    assert.ok(req0, 'expected to find resp-aaa-0001');
    assert.equal(req0.timestamp, 1780300010000);
    assert.equal(req0.credits, 12.5);
  });

  test('session-aaa: kind:2-only entry has timestamp from its request object', () => {
    const lines = fixtureLines('abc123abc123abc123abc123abc123ab', 'session-aaa.jsonl');
    const requests = parseSession(lines);
    const req1 = requests.find((r) => r.responseId === 'resp-aaa-0002');
    assert.ok(req1, 'expected to find resp-aaa-0002');
    assert.equal(req1.timestamp, 1780300020000);
    assert.equal(req1.credits, 8.3);
  });

  test('session-bbb: dedup — kind:2 wins over kind:1 for same responseId', () => {
    const lines = fixtureLines('abc123abc123abc123abc123abc123ab', 'session-bbb.jsonl');
    const requests = parseSession(lines);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].responseId, 'resp-dedup-A');
    assert.equal(requests[0].credits, 28.5); // kind:2 value, not 30.0 from kind:1
    assert.equal(requests[0].timestamp, 1780310005000);
  });

  test('session-ccc: single kind:1-only entry', () => {
    const lines = fixtureLines('def456def456def456def456def456de', 'session-ccc.jsonl');
    const requests = parseSession(lines);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].credits, 5.0);
    assert.equal(requests[0].responseId, 'resp-ccc-0001');
    assert.equal(requests[0].sessionId, 'session-ccc-0001');
  });

  test('scanWorkspaceStorage: produces correct projects from fixture dir', () => {
    const output = execSync(
      `node index.js --path ${FIXTURES_DIR} --no-write`,
      { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' }
    );
    // project-alpha: 12.5 + 8.3 (session-aaa) + 28.5 (session-bbb) = 49.3
    assert.ok(output.includes('project-alpha'), 'expected project-alpha in output');
    assert.ok(output.includes('49.3'), `expected 49.3 for project-alpha, got:\n${output}`);
    // project-beta: 5.0 (session-ccc)
    assert.ok(output.includes('project-beta'), 'expected project-beta in output');
    assert.ok(output.includes('5'), `expected 5 for project-beta, got:\n${output}`);
    // skipped workspaces should not appear
    assert.ok(!output.includes('project-no-chats'), 'project-no-chats should be skipped (no chatSessions)');
    assert.ok(!output.includes('no-workspace-json'), 'no-workspace-json should be skipped');
  });
});


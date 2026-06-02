#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Pure parsing functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL line and return credit info, or null if the line does
 * not represent a completed request result with a credit cost.
 *
 * @param {string} line
 * @returns {{ requestIndex: number, model: string, credits: number, promptTokens: number, outputTokens: number, sessionId: string, responseId: string, resolvedModel: string } | null}
 */
export function parseCreditsFromLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  // Must be a kind:1 patch on ["requests", N, "result"]
  if (
    parsed.kind !== 1 ||
    !Array.isArray(parsed.k) ||
    parsed.k.length !== 3 ||
    parsed.k[0] !== 'requests' ||
    parsed.k[2] !== 'result'
  ) {
    return null;
  }

  const v = parsed.v;
  if (!v || typeof v.details !== 'string') return null;

  // Extract credit amount from e.g. "Claude Sonnet 4.6 • 4.9 credits"
  const creditsMatch = v.details.match(/([\d.]+)\s+credits/);
  if (!creditsMatch) return null;

  // Extract model name — everything before the bullet separator
  const modelMatch = v.details.match(/^(.+?)\s*•/);
  const model = modelMatch ? modelMatch[1].trim() : v.resolvedModel ?? '';

  const metadata = v.metadata ?? {};

  return {
    requestIndex: parsed.k[1],
    model,
    credits: parseFloat(creditsMatch[1]),
    promptTokens: metadata.promptTokens ?? null,
    outputTokens: metadata.outputTokens ?? null,
    sessionId: metadata.sessionId ?? v.sessionId ?? null,
    responseId: metadata.responseId ?? v.responseId ?? null,
    resolvedModel: metadata.resolvedModel ?? v.resolvedModel ?? null,
  };
}

/**
 * Parse credit info from a single request entry inside a kind:2 requests array.
 * These entries have the form: { requestId, timestamp, responseId, result: { details, ... } }
 *
 * @param {object} entry
 * @returns {{ model: string, credits: number, promptTokens: number|null, outputTokens: number|null, sessionId: string|null, responseId: string, resolvedModel: string|null, timestamp: number|null } | null}
 */
export function parseCreditsFromRequestEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const result = entry.result;
  if (!result || typeof result.details !== 'string') return null;

  const creditsMatch = result.details.match(/([\d.]+)\s+credits/);
  if (!creditsMatch) return null;

  const modelMatch = result.details.match(/^(.+?)\s*•/);
  const model = modelMatch ? modelMatch[1].trim() : result.resolvedModel ?? '';

  const metadata = result.metadata ?? {};

  return {
    model,
    credits: parseFloat(creditsMatch[1]),
    promptTokens: metadata.promptTokens ?? null,
    outputTokens: metadata.outputTokens ?? null,
    sessionId: result.sessionId ?? null,
    responseId: entry.responseId ?? null,
    resolvedModel: result.resolvedModel ?? null,
    timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : null,
  };
}


/**
 * Parse all lines from a chat session JSONL file.
 * Collects credit entries from:
 *   1. kind:1 lines with k = ["requests", N, "result"]
 *   2. kind:2 lines with k = ["requests"] — request array replacements
 * Deduplicates by responseId (kind:2 takes precedence when it appears after kind:1).
 *
 * @param {string[]} lines
 * @returns {Array<{ responseId: string|null, model: string, credits: number, promptTokens: number|null, outputTokens: number|null, sessionId: string|null, resolvedModel: string|null, timestamp: number|null, requestIndex: number|null }>}
 */
export function parseSession(lines) {
  // Map of requestIndex → timestamp, built from kind:2 lines (for correlating kind:1 entries)
  const timestampMap = new Map();
  // Map of responseId → credit entry from kind:2 request objects
  const fromKind2 = new Map();

  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (
      parsed.kind === 2 &&
      Array.isArray(parsed.k) &&
      parsed.k.length === 1 &&
      parsed.k[0] === 'requests' &&
      Array.isArray(parsed.v)
    ) {
      parsed.v.forEach((req, index) => {
        if (req && typeof req.timestamp === 'number') {
          timestampMap.set(index, req.timestamp);
        }
        const entry = parseCreditsFromRequestEntry(req);
        if (entry) {
          const key = entry.responseId ?? `__kind2_idx_${index}`;
          fromKind2.set(key, { ...entry, requestIndex: null });
        }
      });
    }
  }

  // Collect kind:1 result entries
  const fromKind1 = new Map();
  for (const line of lines) {
    const entry = parseCreditsFromLine(line);
    if (!entry) continue;
    const timestamp = timestampMap.get(entry.requestIndex) ?? null;
    const withTs = { ...entry, timestamp };
    // Use responseId as key, fall back to a stable synthetic key based on requestIndex
    const key = entry.responseId ?? `__idx_${entry.requestIndex}`;
    fromKind1.set(key, withTs);
  }

  // Merge: kind:1 base, kind:2 overwrites (last write wins)
  const merged = new Map([...fromKind1, ...fromKind2]);
  return Array.from(merged.values());
}


/**
 * Resolve the default VS Code workspaceStorage path for the given platform.
 *
 * @param {string} [platform] - Defaults to process.platform
 * @returns {string}
 */
export function detectStoragePath(platform = process.platform) {
  const home = os.homedir();
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User', 'workspaceStorage');
  }
  // Linux / other
  return path.join(home, '.config', 'Code', 'User', 'workspaceStorage');
}

/**
 * Given a flat list of parsed session objects (each with project + requests),
 * group them by project and compute totalCredits.
 *
 * @param {Array<{ workspaceHash: string, project: string, chatFile: string, sessionId: string, requests: any[] }>} sessions
 * @returns {Array<{ project: string, projectName: string, totalCredits: number, sessions: any[] }>}
 */
export function aggregateProjects(sessions) {
  const byProject = new Map();

  for (const session of sessions) {
    const key = session.project;
    if (!byProject.has(key)) {
      byProject.set(key, { project: key, projectName: projectName(key), totalCredits: 0, sessions: [] });
    }
    const entry = byProject.get(key);
    const sessionCredits = session.requests.reduce((sum, r) => sum + (r.credits ?? 0), 0);
    // Round to avoid floating point drift
    entry.totalCredits = Math.round((entry.totalCredits + sessionCredits) * 1000) / 1000;
    entry.sessions.push({
      sessionId: session.sessionId,
      workspaceHash: session.workspaceHash,
      chatFile: session.chatFile,
      totalCredits: Math.round(sessionCredits * 1000) / 1000,
      requests: session.requests,
    });
  }

  return Array.from(byProject.values());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectName(folderUri) {
  // "file:///home/user/my-project" → "my-project"
  const decoded = decodeURIComponent(folderUri);
  return path.basename(decoded.replace(/^file:\/\//, ''));
}

// ---------------------------------------------------------------------------
// File system scanning
// ---------------------------------------------------------------------------

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function scanWorkspaceStorage(storageDir) {
  const sessions = [];

  let entries;
  try {
    entries = fs.readdirSync(storageDir, { withFileTypes: true });
  } catch (err) {
    console.error(`Cannot read storage directory: ${storageDir}\n${err.message}`);
    process.exit(1);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = path.join(storageDir, entry.name);

    // Read workspace.json to identify the project
    const workspaceJson = readJsonSafe(path.join(workspaceDir, 'workspace.json'));
    if (!workspaceJson?.folder) continue;

    const project = workspaceJson.folder;
    const chatSessionsDir = path.join(workspaceDir, 'chatSessions');

    let sessionFiles;
    try {
      sessionFiles = fs.readdirSync(chatSessionsDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue; // no chatSessions dir — skip
    }

    for (const sessionFile of sessionFiles) {
      const filePath = path.join(chatSessionsDir, sessionFile);
      let lines;
      try {
        lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      } catch {
        continue;
      }

      const requests = parseSession(lines);
      if (requests.length === 0) continue; // no credit data — skip

      const sessionId = requests[0]?.sessionId ?? path.basename(sessionFile, '.jsonl');

      sessions.push({
        workspaceHash: entry.name,
        project,
        chatFile: path.join('chatSessions', sessionFile),
        sessionId,
        requests,
      });
    }
  }

  return sessions;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const pathIdx = args.findIndex((a) => a === '--path' || a === '-p');
  const customPath = pathIdx !== -1 && args[pathIdx + 1] ? args[pathIdx + 1] : null;
  const noWrite = args.includes('--no-write');
  // Positional: first non-flag argument
  const positional = args.find((a) => !a.startsWith('-')) ?? null;
  return { customPath: customPath ?? positional, noWrite };
}

async function main() {
  const { customPath, noWrite } = parseArgs(process.argv);
  let storageDir = customPath ?? detectStoragePath();

  // Expand ~ if present (e.g. user passed --path ~/custom)
  if (storageDir.startsWith('~')) {
    storageDir = path.join(os.homedir(), storageDir.slice(1));
  }

  console.log(`Scanning: ${storageDir}`);

  const sessions = scanWorkspaceStorage(storageDir);
  const projects = aggregateProjects(sessions);

  if (projects.length === 0) {
    console.log('No credit data found.');
    return;
  }

  const outputDir = path.join(process.cwd(), 'output');
  if (!noWrite) fs.mkdirSync(outputDir, { recursive: true });

  let grandTotal = 0;

  for (const project of projects) {
    grandTotal = Math.round((grandTotal + project.totalCredits) * 1000) / 1000;
    console.log(`  ${project.projectName}: ${project.totalCredits} credits`);
    if (!noWrite) {
      // Use the workspace hash from the first session for the filename
      const workspaceHash = project.sessions[0]?.workspaceHash ?? project.projectName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const outFile = path.join(outputDir, `${workspaceHash}.json`);
      fs.writeFileSync(outFile, JSON.stringify(project, null, 2), 'utf8');
      console.log(`    → ${outFile}`);
    }
  }

  console.log(`\nTotal across all projects: ${grandTotal} credits`);
  if (!noWrite) console.log(`Output written to: ${outputDir}`);
}

// Run only when executed directly (not when imported by tests)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', ''));
if (isMain) {
  main();
}

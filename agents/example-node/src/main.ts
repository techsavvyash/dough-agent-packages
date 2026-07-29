// example-node — a node-runtime dough agent.
//
// The worker spawns this file with `bun src/main.ts` inside the VM. Unlike a
// claude/codex agent (which is a prompt handed to an LLM CLI), a node agent
// IS the program: deterministic control flow, direct filesystem/API access,
// its own exit code. This one scans the checked-out repo for cost-comment
// markers (TODO/FIXME/HACK/XXX) and writes a Markdown report.
//
// It depends on Node built-ins ONLY — an agent bundle never ships its
// node_modules (the packer strips it), so a self-contained entrypoint is the
// reliable shape. Need third-party libraries? Declare a `toolchains` map in
// agent.json and shell out to the provisioned runtime, or vendor the sources.
//
// The env contract the worker guarantees (dough-worker/src/runtime/env-contract.ts):
//   DOUGH_TASK_INPUT  — the task payload/prompt (may be empty)
//   DOUGH_WORKSPACE   — path to the checked-out repo (present iff needsWorkspace)
//   DOUGH_AGENT_DIR   — this bundle's unpacked dir (read your own assets here)
//   DOUGH_RESULT_FILE — write the result here; file content wins over stdout tail
//
// Contract: exit 0 = success (result = DOUGH_RESULT_FILE, else stdout tail);
// any non-zero exit = the task failed (stderr tail is surfaced to the operator).

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** A marker keyword scanned for as a whole word (case-sensitive by convention). */
type Marker = string;

/** Optional structured task input. Anything unparseable falls back to defaults. */
interface TaskConfig {
  /** Extra markers to scan for, on top of the defaults. */
  markers?: Marker[];
  /** Cap on individual hits listed in the report (counts are always complete). */
  maxResults?: number;
}

/** One marker occurrence. */
interface Hit {
  marker: Marker;
  /** Workspace-relative POSIX path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The trimmed, length-capped source line. */
  text: string;
}

/** A well-typed failure the top-level handler maps to a non-zero exit. */
class AgentError extends Error {
  override readonly name = 'AgentError';
}

const DEFAULT_MARKERS: readonly Marker[] = ['TODO', 'FIXME', 'HACK', 'XXX'];
const DEFAULT_MAX_RESULTS = 100;

/** Dirs never descended into — noise, VCS internals, build output. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'vendor',
  '.next',
  'coverage',
  '.turbo',
]);

const MAX_FILE_BYTES = 512 * 1024; // skip anything larger — likely generated/binary
const MAX_LINE_LEN = 200; // cap a single reported source line
const NUL = String.fromCharCode(0); // binary-file sentinel

/** Parse DOUGH_TASK_INPUT. Accepts a JSON object; ignores anything else so a
 *  free-text prompt degrades to defaults rather than failing the run. */
function parseConfig(raw: string | undefined): TaskConfig {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    const cfg = parsed as Record<string, unknown>;
    const markers = Array.isArray(cfg.markers)
      ? cfg.markers.filter((m): m is string => typeof m === 'string' && m.length > 0)
      : undefined;
    const maxResults =
      typeof cfg.maxResults === 'number' && Number.isFinite(cfg.maxResults) && cfg.maxResults > 0
        ? Math.floor(cfg.maxResults)
        : undefined;
    return { markers, maxResults };
  } catch {
    return {}; // not JSON — treat as a free-text prompt, use defaults
  }
}

/** Build one word-boundary regex matching any of the markers. Escapes each
 *  marker so a caller-supplied value can't smuggle regex metacharacters. */
function buildMarkerRegex(markers: readonly Marker[]): RegExp {
  const escaped = markers.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(${escaped.join('|')})\\b`);
}

/** Recursively collect regular-file paths under `root`, skipping SKIP_DIRS and
 *  oversized files. Deterministic: entries are sorted at every level. */
function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
      } else if (entry.isFile()) {
        try {
          if (statSync(abs).size <= MAX_FILE_BYTES) out.push(abs);
        } catch {
          // race/permission — skip this file, keep scanning.
        }
      }
    }
  };
  walk(root);
  return out;
}

/** Scan every file for marker hits. Binary files (NUL byte) are skipped. */
function scan(root: string, files: string[], re: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const abs of files) {
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue; // unreadable — skip
    }
    if (content.includes(NUL)) continue; // binary
    const rel = relative(root, abs).split('\\').join('/');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (m) {
        const text = lines[i].trim();
        hits.push({
          marker: m[1],
          file: rel,
          line: i + 1,
          text: text.length > MAX_LINE_LEN ? text.slice(0, MAX_LINE_LEN) + '…' : text,
        });
      }
    }
  }
  return hits;
}

/** Render the Markdown report. Counts cover ALL hits; the listing is capped. */
function report(hits: Hit[], markers: readonly Marker[], maxResults: number): string {
  const counts = new Map<Marker, number>(markers.map((m) => [m, 0]));
  for (const h of hits) counts.set(h.marker, (counts.get(h.marker) ?? 0) + 1);

  const lines: string[] = [];
  lines.push('# Marker scan report', '');
  lines.push(`Scanned workspace — found **${hits.length}** marker(s).`, '');

  lines.push('| Marker | Count |', '| --- | --- |');
  for (const m of markers) lines.push(`| ${m} | ${counts.get(m) ?? 0} |`);
  lines.push('');

  if (hits.length === 0) {
    lines.push('No markers found. 🎉');
    return lines.join('\n');
  }

  const shown = hits.slice(0, maxResults);
  lines.push(`## Occurrences${hits.length > shown.length ? ` (first ${shown.length})` : ''}`, '');
  for (const h of shown) lines.push(`- \`${h.file}:${h.line}\` **${h.marker}** — ${h.text}`);
  if (hits.length > shown.length) {
    lines.push('', `…and ${hits.length - shown.length} more (raise \`maxResults\` to see them).`);
  }
  return lines.join('\n');
}

function main(): void {
  const cfg = parseConfig(process.env.DOUGH_TASK_INPUT);
  const markers = [...new Set([...DEFAULT_MARKERS, ...(cfg.markers ?? [])])];
  const maxResults = cfg.maxResults ?? DEFAULT_MAX_RESULTS;

  // Prefer the checked-out workspace; fall back to cwd so the agent is also
  // runnable standalone (e.g. local dev, or a needsWorkspace=false variant).
  const root = process.env.DOUGH_WORKSPACE ?? process.cwd();
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new AgentError(`scan root '${root}' is not an accessible directory`);
  }

  const files = collectFiles(root);
  const hits = scan(root, files, buildMarkerRegex(markers));
  hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));

  const md = report(hits, markers, maxResults);

  const resultFile = process.env.DOUGH_RESULT_FILE;
  if (resultFile) {
    writeFileSync(resultFile, md, 'utf8');
    // A short stdout breadcrumb; the result-file content is what's returned.
    console.log(`scanned ${files.length} file(s), ${hits.length} marker(s) -> ${resultFile}`);
  } else {
    console.log(md);
  }
}

try {
  main();
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`example-node failed: ${msg}`);
  process.exit(1);
}

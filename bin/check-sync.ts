#!/usr/bin/env bun
// `check-sync` — drift detector between this repo's packages and the LIVE
// dough-gateway agent definitions.
//
// The repo is self-contained (tests validate against a pinned fixture copy of
// each gateway definition's systemPrompt — see test/fixtures), but the gateway
// definitions can still move underneath us until the gateway's `BUILTINS` are
// deleted (design §5). This script extracts the *current* systemPrompt from a
// checked-out dough-gateway working tree and diffs it against each package's
// prompt.md, so a prompt bump on the gateway side surfaces as a failable CI /
// pre-publish check rather than silent drift.
//
//   bun bin/check-sync.ts [--gateway <path>]
//
// Defaults --gateway to ../dough-gateway. Exits non-zero on any drift or if the
// gateway tree can't be read. This is a DEV/CI aid, not part of publish.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const AGENTS_DIR = join(import.meta.dir, '..', 'agents');

interface Args {
  gatewayPath: string;
}

function parseArgs(argv: string[]): Args {
  let gatewayPath = join(import.meta.dir, '..', '..', 'dough-gateway');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--gateway') {
      const next = argv[i + 1];
      if (!next) throw new Error('--gateway requires a path');
      gatewayPath = next;
      i++;
    }
  }
  return { gatewayPath };
}

/** The definitions we track and their exported const names in the gateway. */
const DEFINITION_EXPORTS: Record<string, string> = {
  'pr-reviewer': 'PR_REVIEWER_AGENT',
  'pr-reviewer-codex': 'PR_REVIEWER_CODEX_AGENT',
  coder: 'CODER_AGENT',
  'coder-codex': 'CODER_CODEX_AGENT',
  'fixer-codex': 'FIXER_CODEX_AGENT',
  default: 'DEFAULT_AGENT',
};

/**
 * Extract the live systemPrompt of every tracked definition by running a small
 * bun script INSIDE the gateway repo (so its @dough-gateway/domain path alias
 * resolves). Returns id → systemPrompt.
 */
function extractGatewayPrompts(gatewayPath: string): Record<string, string> {
  const defsDir = join(gatewayPath, 'src', 'agents', 'definitions');
  if (!existsSync(defsDir)) {
    throw new Error(
      `gateway definitions dir not found at ${defsDir} — is --gateway pointing at a dough-gateway checkout?`,
    );
  }

  const imports = Object.entries(DEFINITION_EXPORTS)
    .map(
      ([id, name]) =>
        `import { ${name} } from './src/agents/definitions/${id}.ts';`,
    )
    .join('\n');
  const body = Object.entries(DEFINITION_EXPORTS)
    .map(([id, name]) => `out[${JSON.stringify(id)}] = ${name}.systemPrompt;`)
    .join('\n');
  const script = `${imports}\nconst out = {};\n${body}\nprocess.stdout.write(JSON.stringify(out));\n`;

  // The script must run FROM the gateway root so its `@dough-gateway/domain`
  // path alias (tsconfig baseUrl+paths) resolves. Bun resolves import paths
  // relative to the script file's own location, so the script has to live at
  // the gateway root too — a system tmpdir wouldn't see the alias. Write a
  // uniquely-named throwaway there and always clean it up.
  const scriptPath = join(gatewayPath, `.dough-check-sync-${process.pid}-${Date.now()}.ts`);
  try {
    writeFileSync(scriptPath, script, 'utf8');
    const res = spawnSync('bun', [scriptPath], {
      cwd: gatewayPath,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(
        `extraction inside gateway failed (exit ${res.status}):\n${res.stderr}`,
      );
    }
    return JSON.parse(res.stdout) as Record<string, string>;
  } finally {
    rmSync(scriptPath, { force: true });
  }
}

function main(argv: string[]): number {
  const { gatewayPath } = parseArgs(argv);
  const livePrompts = extractGatewayPrompts(gatewayPath);

  const packages = readdirSync(AGENTS_DIR).sort();
  let drift = 0;
  for (const id of packages) {
    const manifest = JSON.parse(readFileSync(join(AGENTS_DIR, id, 'agent.json'), 'utf8')) as {
      kind?: unknown;
    };
    if (manifest.kind === 'app') {
      // App templates have no gateway builtin to drift from.
      console.log(`--  ${id}: app template`);
      continue;
    }
    const live = livePrompts[id];
    if (live === undefined) {
      // A package the gateway no longer defines — informational, not drift
      // (the gateway is being decoupled; new packages won't have a gateway
      // definition at all).
      console.log(`--  ${id}: no gateway definition (package-only)`);
      continue;
    }
    const promptPath = join(AGENTS_DIR, id, 'prompt.md');
    const local = readFileSync(promptPath, 'utf8');
    if (local === live) {
      console.log(`OK  ${id}`);
    } else {
      drift++;
      console.error(
        `DRIFT ${id}: prompt.md differs from gateway ${DEFINITION_EXPORTS[id]}.systemPrompt (local ${local.length}B vs gateway ${live.length}B)`,
      );
    }
  }

  // Gateway definitions not represented as a package here.
  for (const id of Object.keys(livePrompts)) {
    if (!packages.includes(id)) {
      drift++;
      console.error(`MISSING ${id}: gateway defines it but no package exists`);
    }
  }

  if (drift > 0) {
    console.error(`\n${drift} drift/missing issue(s) detected`);
    return 1;
  }
  console.log(`\nall ${packages.length} package(s) in sync with gateway`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error('check-sync failed:', err instanceof Error ? err.message : err);
    process.exit(2);
  }
}

export { extractGatewayPrompts, DEFINITION_EXPORTS };

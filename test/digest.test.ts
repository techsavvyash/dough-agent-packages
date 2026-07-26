// Manifest digest parity with the gateway (bin/digest.ts).
//
// The CLI's idempotency skip and its fail-fast on a would-409 both rest on the
// local digest equalling the gateway's `manifestDigest` byte-for-byte. These
// tests pin that in three layers:
//
//   1. GOLDEN digests — hardcoded sha256 values captured from a cross-repo
//      parity run against dough-gateway's authoritative `manifestDigest`
//      (registry-digest.ts) + `agentDefinitionSchema` parse. If bin/digest.ts
//      drifts, the golden string changes and the test fails, WITHOUT needing
//      the gateway checked out — the repo stays self-contained.
//   2. RELATION invariants — the parity RULES themselves (deprecated excluded,
//      version stripped, defaults materialized, top-level null == absent, null
//      inside clankerAgent preserved, key order irrelevant, arrays ordered).
//   3. LIVE cross-repo parity — when a sibling dough-gateway checkout is
//      present, import its real digest and assert equality on a battery. Skipped
//      (not failed) when the gateway isn't there, so CI in this repo alone is green.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  canonicalJson,
  canonicalManifestJson,
  manifestDigest,
  projectManifestForDigest,
} from '../bin/digest.ts';

type Raw = Record<string, unknown>;

const claude = (): Raw => ({
  id: 'demo',
  version: '1.0.0',
  description: 'd',
  runtime: 'claude',
  needsWorkspace: false,
  roles: ['chat'],
  systemPrompt: 'hi',
  hooks: [],
});
const node = (): Raw => ({
  id: 'n',
  version: '2.3.4',
  description: 'nd',
  runtime: 'node',
  needsWorkspace: false,
  roles: ['chat'],
  entrypoint: 'src/main.ts',
  toolchains: { node: '20' },
});
const clanker = (): Raw => ({
  id: 'c',
  version: '1.0.0',
  description: 'cd',
  runtime: 'clanker',
  needsWorkspace: false,
  roles: ['chat'],
  clankerAgent: { id: 'inner', instructions: 'go', extra: null, nested: { a: null, b: 1 } },
});

describe('golden digests (captured from cross-repo gateway parity)', () => {
  // These strings are the gateway's `manifestDigest` output for each fixture.
  // Do not hand-edit: regenerate only via a verified parity run.
  test('claude', () => {
    expect(manifestDigest(claude())).toBe(
      'sha256:dc8fd6970df94924d97c61635f31fc7f6d566244ac5e117aa88ffec28906d70f',
    );
  });
  test('node', () => {
    expect(manifestDigest(node())).toBe(
      'sha256:2bee97bb286898b5cbdc90fe63e7ed55b59252dde9fbf3e1fadd3d0ff8f6770e',
    );
  });
  test('clanker (with nulls inside clankerAgent)', () => {
    expect(manifestDigest(clanker())).toBe(
      'sha256:fda3859ea234f924bf6d62f9a04bff589e20f9a7b5d28f9a78ad19f1864e3184',
    );
  });

  test('canonical string projects to the parsed server shape (no version/promptFile)', () => {
    // version is stripped; keys sorted; defaults present.
    expect(canonicalManifestJson(claude())).toBe(
      '{"description":"d","hooks":[],"id":"demo","needsWorkspace":false,"roles":["chat"],"runtime":"claude","systemPrompt":"hi"}',
    );
  });
});

describe('parity rules', () => {
  test('deprecated true/false/string all digest identically to absent', () => {
    const base = manifestDigest(claude());
    expect(manifestDigest({ ...claude(), deprecated: true })).toBe(base);
    expect(manifestDigest({ ...claude(), deprecated: false })).toBe(base);
    expect(manifestDigest({ ...claude(), deprecated: 'gone' })).toBe(base);
  });

  test('version does not affect the digest (stripped as an unknown server-side)', () => {
    expect(manifestDigest({ ...claude(), version: '9.9.9' })).toBe(manifestDigest(claude()));
  });

  test('top-level model:null digests identically to omitting model', () => {
    expect(manifestDigest({ ...claude(), model: null })).toBe(manifestDigest(claude()));
  });

  test('a real model value DOES change the digest', () => {
    expect(manifestDigest({ ...claude(), model: 'claude-sonnet-5' })).not.toBe(
      manifestDigest(claude()),
    );
  });

  test('omitting runtime digests as claude (default materialized)', () => {
    const { runtime, ...noRuntime } = claude();
    void runtime;
    expect(manifestDigest(noRuntime)).toBe(manifestDigest(claude()));
  });

  test('omitting hooks digests as [] (default materialized)', () => {
    const { hooks, ...noHooks } = claude();
    void hooks;
    expect(manifestDigest(noHooks)).toBe(manifestDigest(claude()));
  });

  test('key order does not change the digest', () => {
    const permuted: Raw = {
      hooks: [],
      systemPrompt: 'hi',
      roles: ['chat'],
      needsWorkspace: false,
      runtime: 'claude',
      description: 'd',
      version: '1.0.0',
      id: 'demo',
    };
    expect(manifestDigest(permuted)).toBe(manifestDigest(claude()));
  });

  test('a null INSIDE clankerAgent is preserved and changes the digest', () => {
    const withoutInnerNull: Raw = {
      ...clanker(),
      clankerAgent: { id: 'inner', instructions: 'go', nested: { a: null, b: 1 } },
    };
    // Dropping the top-level `extra: null` inside clankerAgent is a real content
    // change (the opaque object is NOT null-stripped), so the digest differs.
    expect(manifestDigest(withoutInnerNull)).not.toBe(manifestDigest(clanker()));
  });

  test('array order is load-bearing (roles reorder changes the digest)', () => {
    const a = manifestDigest({ ...claude(), roles: ['reviewer', 'coder'] });
    const b = manifestDigest({ ...claude(), roles: ['coder', 'reviewer'] });
    expect(a).not.toBe(b);
  });

  test('projected shape drops authoring-only + deprecated keys', () => {
    const projected = projectManifestForDigest({
      ...claude(),
      promptFile: './p.md',
      readmeFile: './r.md',
      deprecated: 'x',
      surprise: true,
    });
    expect(projected).not.toHaveProperty('version');
    expect(projected).not.toHaveProperty('promptFile');
    expect(projected).not.toHaveProperty('readmeFile');
    expect(projected).not.toHaveProperty('deprecated');
    expect(projected).not.toHaveProperty('surprise');
    expect(projected).toHaveProperty('id', 'demo');
  });

  test('digest is sha256:<64 hex>', () => {
    expect(manifestDigest(claude())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('canonicalJson sorts nested keys, keeps null, drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson({ a: null, b: 1 })).toBe('{"a":null,"b":1}');
  });
});

// ── Live cross-repo parity (best-effort; skipped when gateway absent) ─────────
const GATEWAY_DIGEST = join(
  import.meta.dir,
  '..',
  '..',
  'dough-gateway',
  'src',
  'agents',
  'registry',
  'registry-digest.ts',
);
const GATEWAY_AGENT = join(
  import.meta.dir,
  '..',
  '..',
  'dough-gateway',
  'src',
  'domain',
  'agent.ts',
);
const gatewayPresent = existsSync(GATEWAY_DIGEST) && existsSync(GATEWAY_AGENT);

describe.if(gatewayPresent)('live gateway parity', () => {
  test('CLI digest equals the gateway digest for every fixture + rule case', async () => {
    const { manifestDigest: serverDigest } = (await import(GATEWAY_DIGEST)) as {
      manifestDigest: (m: unknown) => string;
    };
    const { agentDefinitionSchema } = (await import(GATEWAY_AGENT)) as {
      agentDefinitionSchema: { parse: (v: unknown) => unknown };
    };
    const cases: Raw[] = [
      claude(),
      node(),
      clanker(),
      { ...claude(), model: null },
      { ...claude(), deprecated: true },
      { ...claude(), deprecated: 'gone' },
      { ...claude(), version: '9.9.9' },
      { ...node(), toolchains: { node: '20', bun: '1' } },
    ];
    for (const raw of cases) {
      // The server digests the PARSED manifest — emulate the real publish path.
      const server = serverDigest(agentDefinitionSchema.parse(raw));
      expect(manifestDigest(raw)).toBe(server);
    }
  });
});

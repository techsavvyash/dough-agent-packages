// Extraction fidelity: every builtin package's prompt.md must be byte-equal
// to the systemPrompt that was extracted from the corresponding gateway
// definition. The gateway value is PINNED into test/fixtures/gateway-prompts
// so this repo is self-contained (no dependency on a dough-gateway checkout at
// test time — that drift check lives in bin/check-sync.ts).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadPackage, resolveManifest } from '../bin/resolve.ts';

const ROOT = join(import.meta.dir, '..');
const AGENTS = join(ROOT, 'agents');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'gateway-prompts');

const BUILTINS = [
  'pr-reviewer',
  'pr-reviewer-codex',
  'coder',
  'coder-codex',
  'fixer-codex',
  'concierge',
  'default',
] as const;

describe('extraction fidelity', () => {
  for (const id of BUILTINS) {
    test(`${id} prompt.md is byte-equal to the pinned gateway systemPrompt`, () => {
      const promptMd = readFileSync(join(AGENTS, id, 'prompt.md'), 'utf8');
      const pinned = readFileSync(join(FIXTURES, `${id}.prompt.md`), 'utf8');
      expect(promptMd).toBe(pinned);
      expect(promptMd.length).toBeGreaterThan(0);
    });

    test(`${id} resolves promptFile → systemPrompt losslessly`, () => {
      const def = resolveManifest(loadPackage(join(AGENTS, id)));
      const pinned = readFileSync(join(FIXTURES, `${id}.prompt.md`), 'utf8');
      expect(def.systemPrompt).toBe(pinned);
      // *File keys are stripped from the resolved wire object.
      expect((def as Record<string, unknown>).promptFile).toBeUndefined();
      expect((def as Record<string, unknown>).readmeFile).toBeUndefined();
      // readme is inlined and non-empty.
      expect(def.readme?.length ?? 0).toBeGreaterThan(0);
    });

    test(`${id} prompt contains no unresolved \${} interpolation`, () => {
      // The gateway prompts use escaped backticks, not template interpolation.
      // A literal ${ in the runtime string would mean a source-extraction bug.
      const promptMd = readFileSync(join(AGENTS, id, 'prompt.md'), 'utf8');
      expect(promptMd.includes('${')).toBe(false);
    });
  }

  test('every builtin package validates', () => {
    for (const id of BUILTINS) {
      const def = resolveManifest(loadPackage(join(AGENTS, id)));
      expect(def.id).toBe(id);
      expect(def.roles.length).toBeGreaterThan(0);
    }
  });
});

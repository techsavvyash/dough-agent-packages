// Manifest resolution edge cases: promptFile/readmeFile inlining, path-escape
// rejection, double-set rejection, missing-file and bad-JSON errors.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PackageIoError, loadPackage, resolveManifest } from '../bin/resolve.ts';

function pkgDir(): string {
  return mkdtempSync(join(tmpdir(), 'dough-resolve-'));
}

function writePkg(dir: string, manifest: Record<string, unknown>): void {
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(manifest), 'utf8');
}

const CLAUDE_BASE = {
  id: 'demo',
  version: '1.0.0',
  description: 'd',
  runtime: 'claude',
  needsWorkspace: false,
};

describe('resolveManifest inlining', () => {
  test('promptFile → systemPrompt and readmeFile → readme, *File stripped', () => {
    const dir = pkgDir();
    try {
      writePkg(dir, { ...CLAUDE_BASE, promptFile: './p.md', readmeFile: './r.md' });
      writeFileSync(join(dir, 'p.md'), 'the prompt body');
      writeFileSync(join(dir, 'r.md'), '# readme body');
      const def = resolveManifest(loadPackage(dir));
      expect(def.systemPrompt).toBe('the prompt body');
      expect(def.readme).toBe('# readme body');
      expect((def as Record<string, unknown>).promptFile).toBeUndefined();
      expect((def as Record<string, unknown>).readmeFile).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a promptFile that resolves empty fails schema (systemPrompt min 1)', () => {
    const dir = pkgDir();
    try {
      writePkg(dir, { ...CLAUDE_BASE, promptFile: './p.md' });
      writeFileSync(join(dir, 'p.md'), '');
      expect(() => resolveManifest(loadPackage(dir))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('both promptFile and systemPrompt set is rejected', () => {
    const dir = pkgDir();
    try {
      writePkg(dir, { ...CLAUDE_BASE, promptFile: './p.md', systemPrompt: 'inline' });
      writeFileSync(join(dir, 'p.md'), 'file');
      expect(() => resolveManifest(loadPackage(dir))).toThrow(PackageIoError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a promptFile escaping the package dir is rejected', () => {
    const dir = pkgDir();
    try {
      writePkg(dir, { ...CLAUDE_BASE, promptFile: '../secret.md' });
      writeFileSync(join(dir, '..', 'secret.md'), 'leak');
      expect(() => resolveManifest(loadPackage(dir))).toThrow(PackageIoError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an absolute promptFile is rejected', () => {
    const dir = pkgDir();
    try {
      writePkg(dir, { ...CLAUDE_BASE, promptFile: '/etc/passwd' });
      expect(() => resolveManifest(loadPackage(dir))).toThrow(PackageIoError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing promptFile is a PackageIoError', () => {
    const dir = pkgDir();
    try {
      writePkg(dir, { ...CLAUDE_BASE, promptFile: './nope.md' });
      expect(() => resolveManifest(loadPackage(dir))).toThrow(PackageIoError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadPackage errors', () => {
  test('missing agent.json', () => {
    const dir = pkgDir();
    try {
      expect(() => loadPackage(dir)).toThrow(PackageIoError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('non-JSON agent.json', () => {
    const dir = pkgDir();
    try {
      writeFileSync(join(dir, 'agent.json'), 'not json {');
      expect(() => loadPackage(dir)).toThrow(PackageIoError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('agent.json that is a JSON array (not object)', () => {
    const dir = pkgDir();
    try {
      writeFileSync(join(dir, 'agent.json'), '[]');
      expect(() => loadPackage(dir)).toThrow(PackageIoError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a node package with a nested src resolves readmeFile only', () => {
    const dir = pkgDir();
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'main.ts'), 'export {}');
      writePkg(dir, {
        id: 'n',
        version: '1.0.0',
        description: 'd',
        runtime: 'node',
        needsWorkspace: false,
        entrypoint: 'src/main.ts',
        readmeFile: './README.md',
      });
      writeFileSync(join(dir, 'README.md'), '# n');
      const def = resolveManifest(loadPackage(dir));
      expect(def.readme).toBe('# n');
      expect(def.entrypoint).toBe('src/main.ts');
      expect((def as Record<string, unknown>).systemPrompt).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveManifest kind', () => {
  test('kind "task" is accepted and stripped from the wire object', () => {
    const dir = pkgDir();
    try {
      writePkg(dir, { ...CLAUDE_BASE, kind: 'task', promptFile: './p.md' });
      writeFileSync(join(dir, 'p.md'), 'prompt');
      const def = resolveManifest(loadPackage(dir));
      expect('kind' in def).toBe(false);
      expect(def.systemPrompt).toBe('prompt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('any other kind is not a registry agent', () => {
    const dir = pkgDir();
    try {
      writePkg(dir, { ...CLAUDE_BASE, kind: 'app', promptFile: './p.md' });
      writeFileSync(join(dir, 'p.md'), 'prompt');
      expect(() => resolveManifest(loadPackage(dir))).toThrow(
        'has kind "app" — only "task" (or no kind) is a registry agent',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

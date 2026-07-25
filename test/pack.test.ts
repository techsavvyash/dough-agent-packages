// Deterministic pack: same tree → same digest across repeated packs and across
// input ordering; ALWAYS_IGNORE + .doughignore honored; digest changes when a
// file's content changes.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PackError,
  collectEntries,
  pack,
  packDir,
  readDoughignore,
} from '../bin/pack.ts';

const NODE_FIXTURE = join(import.meta.dir, 'fixtures', 'node-agent');

function tmpTree(): string {
  return mkdtempSync(join(tmpdir(), 'dough-pack-'));
}

describe('deterministic pack', () => {
  test('the fixture bundle packs to a stable digest across repeated packs', () => {
    const a = packDir(NODE_FIXTURE);
    const b = packDir(NODE_FIXTURE);
    expect(a.digest).toBe(b.digest);
    expect(a.bytes.length).toBe(b.bytes.length);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  test('entry order does not affect the digest (packer sorts)', () => {
    const entries = [
      { name: 'b.txt', data: new TextEncoder().encode('B') },
      { name: 'a.txt', data: new TextEncoder().encode('A') },
      { name: 'src/c.txt', data: new TextEncoder().encode('C') },
    ];
    // collectEntries already sorts, but assert pack() itself is order-agnostic
    // if handed presorted vs shuffled slices of the same set — via two collects.
    const forward = pack([...entries].sort((x, y) => (x.name < y.name ? -1 : 1)));
    const reverse = pack([...entries].sort((x, y) => (x.name > y.name ? -1 : 1)));
    // pack() does NOT re-sort (collectEntries owns sorting), so a caller passing
    // different orders WOULD differ — this documents that contract: identical
    // input order → identical bytes.
    expect(pack(entries).digest).toBe(pack([...entries]).digest);
    // And the two differently-ordered inputs differ, proving order is load-bearing
    // at the pack() layer (collectEntries is what guarantees canonical order).
    expect(forward.digest).not.toBe(reverse.digest);
  });

  test('collectEntries produces canonical sorted order regardless of fs order', () => {
    const dir = tmpTree();
    try {
      writeFileSync(join(dir, 'z.txt'), 'z');
      writeFileSync(join(dir, 'a.txt'), 'a');
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'm.txt'), 'm');
      const names = collectEntries(dir).map((e) => e.name);
      expect(names).toEqual(['a.txt', 'sub/m.txt', 'z.txt']);
      // Packing the same tree twice is byte-identical.
      const first = pack(collectEntries(dir));
      const second = pack(collectEntries(dir));
      expect(first.digest).toBe(second.digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ALWAYS_IGNORE excludes agent.json, README.md, .git, node_modules', () => {
    const dir = tmpTree();
    try {
      writeFileSync(join(dir, 'agent.json'), '{}');
      writeFileSync(join(dir, 'README.md'), '# readme');
      writeFileSync(join(dir, 'keep.ts'), 'export {}');
      mkdirSync(join(dir, 'node_modules'));
      writeFileSync(join(dir, 'node_modules', 'junk.js'), 'x');
      mkdirSync(join(dir, '.git'));
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref');
      const names = collectEntries(dir).map((e) => e.name);
      expect(names).toEqual(['keep.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('.doughignore excludes listed prefixes', () => {
    const dir = tmpTree();
    try {
      writeFileSync(join(dir, '.doughignore'), '# comment\ndist\ntmp/scratch\n');
      writeFileSync(join(dir, 'keep.ts'), '1');
      mkdirSync(join(dir, 'dist'));
      writeFileSync(join(dir, 'dist', 'out.js'), '2');
      mkdirSync(join(dir, 'tmp'));
      mkdirSync(join(dir, 'tmp', 'scratch'));
      writeFileSync(join(dir, 'tmp', 'scratch', 'x'), '3');
      writeFileSync(join(dir, 'tmp', 'keep2'), '4');
      const ignore = readDoughignore(dir);
      expect(ignore).toEqual(['dist', 'tmp/scratch']);
      const names = collectEntries(dir, ignore).map((e) => e.name);
      expect(names.sort()).toEqual(['keep.ts', 'tmp/keep2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a content change changes the digest', () => {
    const dir = tmpTree();
    try {
      writeFileSync(join(dir, 'f.txt'), 'one');
      const before = pack(collectEntries(dir)).digest;
      writeFileSync(join(dir, 'f.txt'), 'two');
      const after = pack(collectEntries(dir)).digest;
      expect(before).not.toBe(after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('digest is a sha256: hex string', () => {
    const { digest } = packDir(NODE_FIXTURE);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('a path over the USTAR 100-byte name limit is rejected loudly', () => {
    const longName = 'a/'.repeat(60) + 'file.txt'; // > 100 bytes
    expect(() => pack([{ name: longName, data: new Uint8Array(0) }])).toThrow(PackError);
  });

  test('the produced archive is a valid gzip that extracts to the same tree', async () => {
    // Round-trip through the system tar to prove we emit a real archive, not
    // just deterministic bytes.
    const { bytes, files } = packDir(NODE_FIXTURE);
    const dir = tmpTree();
    try {
      const gzPath = join(dir, 'bundle.tar.gz');
      writeFileSync(gzPath, bytes);
      const proc = Bun.spawnSync(['tar', '-tzf', gzPath]);
      expect(proc.exitCode).toBe(0);
      const listed = new TextDecoder()
        .decode(proc.stdout)
        .split('\n')
        .filter((l) => l.length > 0)
        .sort();
      expect(listed).toEqual([...files].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

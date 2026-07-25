// Deterministic tar.gz packing for `node`-runtime agent bundles.
//
// The registry content-addresses bundles by SHA256 (design §2, same
// reproducibility rules as the P1.2 toolchain layers): two packs of the same
// tree on any machine at any time MUST produce the same digest, so republishing
// an unchanged package is a no-op rather than a spurious digest-mismatch error.
//
// To get that we normalise every source of nondeterminism a tar carries:
//   - entries sorted by path (lexicographic on the UTF-8 bytes)
//   - mtime zeroed, uid/gid zeroed, uname/gname empty
//   - fixed mode (0644 files / 0755 dirs), type flag normalised
//   - gzip with no mtime/OS/name in the header
//
// We emit a plain POSIX USTAR archive by hand (no external tar dep) so the
// byte layout is fully under our control, then gzip it deterministically.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

/** One resolved file to include in the archive. `name` is the archive-relative
 *  POSIX path (always forward slashes); `data` is the exact bytes. */
export interface PackEntry {
  name: string;
  data: Uint8Array;
}

export interface PackResult {
  /** The gzipped tar bytes. */
  bytes: Uint8Array;
  /** sha256 of `bytes`, hex, prefixed `sha256:` (registry digest form). */
  digest: string;
  /** Archive-relative paths included, sorted — for logging/inspection. */
  files: string[];
}

const BLOCK = 512;

/** Files/dirs never included in a bundle regardless of `.doughignore`. */
const ALWAYS_IGNORE = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  'agent.json',
  'README.md',
  // build-control file, not agent content — never ships in the bundle.
  '.doughignore',
]);

/**
 * Walk a package directory into a sorted list of PackEntry, honoring
 * ALWAYS_IGNORE and an optional set of extra ignore prefixes (from
 * `.doughignore`). Returns entries sorted by archive name for determinism.
 */
export function collectEntries(dir: string, extraIgnore: string[] = []): PackEntry[] {
  const entries: PackEntry[] = [];
  const ignorePrefixes = extraIgnore.map((p) => p.replace(/\/+$/, ''));

  const walk = (abs: string): void => {
    for (const name of readdirSync(abs).sort()) {
      if (ALWAYS_IGNORE.has(name)) continue;
      const childAbs = join(abs, name);
      const rel = relative(dir, childAbs).split(sep).join('/');
      if (ignorePrefixes.some((p) => rel === p || rel.startsWith(p + '/'))) continue;
      const st = statSync(childAbs);
      if (st.isDirectory()) {
        walk(childAbs);
      } else if (st.isFile()) {
        entries.push({ name: rel, data: readFileSync(childAbs) });
      }
      // symlinks / devices / fifos are intentionally skipped — a bundle is
      // regular files only.
    }
  };
  walk(dir);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

/** Read `.doughignore` (one glob-free prefix per line, `#` comments) if present. */
export function readDoughignore(dir: string): string[] {
  try {
    const raw = readFileSync(join(dir, '.doughignore'), 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/** Build a single 512-byte USTAR header for a regular file. */
function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const enc = new TextEncoder();

  const writeStr = (offset: number, len: number, value: string): void => {
    const bytes = enc.encode(value);
    if (bytes.length > len) {
      throw new PackError(`tar field overflow at offset ${offset}: "${value}"`);
    }
    header.set(bytes, offset);
  };
  // Octal numeric field, NUL-terminated, left-zero-padded to len-1 digits.
  const writeOctal = (offset: number, len: number, value: number): void => {
    const str = value.toString(8).padStart(len - 1, '0');
    writeStr(offset, len, str);
  };

  // USTAR splits long names into name(100) + prefix(155). We keep bundle paths
  // short by construction; guard against overflow rather than silently truncate.
  if (name.length > 100) {
    throw new PackError(`bundle path exceeds 100 bytes (USTAR name limit): ${name}`);
  }
  writeStr(0, 100, name); // name
  writeOctal(100, 8, 0o644); // mode
  writeOctal(108, 8, 0); // uid
  writeOctal(116, 8, 0); // gid
  writeOctal(124, 12, size); // size
  writeOctal(136, 12, 0); // mtime — zeroed for determinism
  // checksum (156-163) — filled with spaces first, computed below
  header.fill(0x20, 148, 156);
  header[156] = 0x30; // typeflag '0' = regular file
  // linkname (157-256) left zero
  writeStr(257, 6, 'ustar'); // magic
  writeStr(263, 2, '00'); // version
  // uname/gname (265-296) left empty for determinism
  writeOctal(329, 8, 0); // devmajor
  writeOctal(337, 8, 0); // devminor
  // prefix (345-499) left empty (name <= 100)

  // checksum = sum of all header bytes (with the checksum field as spaces)
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i]!;
  const chk = sum.toString(8).padStart(6, '0');
  header.set(enc.encode(chk), 148);
  header[154] = 0; // NUL
  header[155] = 0x20; // space
  return header;
}

/** Pack entries into a deterministic tar.gz + digest. */
export function pack(entries: PackEntry[]): PackResult {
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    chunks.push(tarHeader(e.name, e.data.length));
    chunks.push(e.data);
    const rem = e.data.length % BLOCK;
    if (rem !== 0) chunks.push(new Uint8Array(BLOCK - rem)); // pad to block
  }
  // Two trailing zero blocks mark end-of-archive.
  chunks.push(new Uint8Array(BLOCK * 2));

  const tarBytes = concat(chunks);
  // gzip level 9. Node's zlib writes mtime=0 and no filename in the gzip header
  // for buffer input (it only stamps mtime when streaming through a real file),
  // so buffer-in gzip is deterministic — the pack-determinism test pins this.
  const gz = gzipSync(tarBytes, { level: 9 });
  const digest = 'sha256:' + createHash('sha256').update(gz).digest('hex');
  return { bytes: gz, digest, files: entries.map((e) => e.name) };
}

/** Convenience: collect a dir (honoring .doughignore) and pack it. */
export function packDir(dir: string): PackResult {
  const entries = collectEntries(dir, readDoughignore(dir));
  return pack(entries);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** A deterministic-pack failure (field overflow, path too long, …). */
export class PackError extends Error {
  override readonly name = 'PackError';
}

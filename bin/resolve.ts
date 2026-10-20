// Manifest resolution: read agent.json from a package dir, inline the
// authoring-convenience file refs (promptFile → systemPrompt, readmeFile →
// readme), strip the *File keys, and produce the wire object the registry
// stores (design §2 step 1).
//
// Resolution is deliberately separate from validation: `validate` resolves
// first (so promptFile emptiness is caught as a systemPrompt error), then
// validates the resolved object. `publish` reuses the same resolved object
// as the PUT body.

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { type AgentManifest, parseManifest } from './manifest.ts';

/** A package on disk: its directory and the raw parsed agent.json. */
export interface LoadedPackage {
  dir: string;
  raw: Record<string, unknown>;
}

/** Read + JSON-parse agent.json from a package directory. */
export function loadPackage(dir: string): LoadedPackage {
  const manifestPath = join(dir, 'agent.json');
  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch (cause) {
    throw new PackageIoError(`no agent.json found in ${dir}`, { cause });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new PackageIoError(`agent.json in ${dir} is not valid JSON`, { cause });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PackageIoError(`agent.json in ${dir} must be a JSON object`);
  }
  return { dir, raw: raw as Record<string, unknown> };
}

/**
 * Resolve a loaded package into the wire manifest: inline file refs, strip
 * the *File keys, then validate the result. The returned object is exactly
 * what gets PUT to the registry (and POSTed to /validate).
 */
export function resolveManifest(pkg: LoadedPackage): AgentManifest {
  const { dir, raw } = pkg;
  const merged: Record<string, unknown> = { ...raw };

  // `kind` tells registry agents ("task", the default) from app templates
  // (bin/agent-template.ts); it is not part of the registry wire object.
  if (raw.kind !== undefined) {
    if (raw.kind !== 'task') {
      throw new PackageIoError(
        `${dir}/agent.json has kind ${JSON.stringify(raw.kind)} — only "task" (or no kind) is a registry agent`,
      );
    }
    delete merged.kind;
  }

  const promptFile = raw.promptFile;
  if (promptFile !== undefined) {
    if (typeof promptFile !== 'string') {
      throw new PackageIoError(`promptFile in ${dir}/agent.json must be a string`);
    }
    if ('systemPrompt' in raw) {
      throw new PackageIoError(
        `${dir}/agent.json sets both promptFile and systemPrompt — use one`,
      );
    }
    merged.systemPrompt = readRefFile(dir, promptFile, 'promptFile');
    delete merged.promptFile;
  }

  const readmeFile = raw.readmeFile;
  if (readmeFile !== undefined) {
    if (typeof readmeFile !== 'string') {
      throw new PackageIoError(`readmeFile in ${dir}/agent.json must be a string`);
    }
    if ('readme' in raw) {
      throw new PackageIoError(
        `${dir}/agent.json sets both readmeFile and readme — use one`,
      );
    }
    merged.readme = readRefFile(dir, readmeFile, 'readmeFile');
    delete merged.readmeFile;
  }

  return parseManifest(dir, merged);
}

/** Read a package-relative file ref. Rejects absolute paths and escapes so a
 *  manifest can't pull in files outside its own directory. */
function readRefFile(dir: string, ref: string, field: string): string {
  if (isAbsolute(ref)) {
    throw new PackageIoError(`${field} must be a relative path, got "${ref}"`);
  }
  const resolved = join(dir, ref);
  // join collapses `..`; ensure the result stays within dir.
  const dirWithSep = dir.endsWith('/') ? dir : dir + '/';
  if (!resolved.startsWith(dirWithSep)) {
    throw new PackageIoError(
      `${field} "${ref}" escapes the package directory ${dir}`,
    );
  }
  try {
    return readFileSync(resolved, 'utf8');
  } catch (cause) {
    throw new PackageIoError(`${field} "${ref}" could not be read in ${dir}`, {
      cause,
    });
  }
}

/** Filesystem / JSON error while loading a package. */
export class PackageIoError extends Error {
  override readonly name = 'PackageIoError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

// Client-side mirror of the gateway's canonical manifest digest.
//
// The registry addresses each stored (id, version) by a sha256 over the
// CANONICAL JSON of the PARSED dough manifest and uses it as the immutability
// anchor: republishing id@version with a differing digest is a 409, an
// identical digest is a no-op. `dough agent publish` MUST compute the exact
// same digest locally so its idempotency check (skip identical, fail-fast on a
// real conflict BEFORE the network PUT) agrees with the server byte-for-byte.
//
// The authoritative server implementation lives in dough-gateway at
// src/agents/registry/registry-digest.ts + src/domain/agent.ts. This file
// mirrors it EXACTLY; the rules that matter, and why a naive
// `sha256(JSON.stringify(manifest))` is WRONG, are:
//
//   1. The digest is taken over the PARSED `AgentDefinition`, not the authored
//      manifest. On the server the manifest passes through
//      `agentDefinitionSchema.parse` before digesting, and a plain (non-strict)
//      zod object STRIPS unknown keys. So the authoring-only fields the CLI
//      manifest carries — `version` (there is no `version` on the domain
//      schema), `promptFile`/`readmeFile` (already resolved away), and the
//      `repository.ref` convenience — are ABSENT from the digested value. If
//      the CLI digested its raw manifest it would include `version` and never
//      match. We therefore project the manifest into the server's parsed shape
//      first (see PARSED_MANIFEST_KEYS).
//
//   2. `deprecated` is EXCLUDED from the canonical form (mutable metadata):
//      deprecating/undeprecating a version must not fork content identity, so a
//      deprecated-only republish is digest-equal and takes the metadata path.
//
//   3. Schema DEFAULTS are materialized before digesting, exactly as the parse
//      would: `runtime` defaults to 'claude', `hooks` defaults to []. A manifest
//      that omits `runtime` and one that writes `"runtime":"claude"` are the
//      same content and MUST share a digest.
//
//   4. Top-level `null`-valued keys are STRIPPED (treated as absent), mirroring
//      the server's `stripManifestNulls` z.preprocess — `{ "model": null }`
//      digests identically to omitting `model`. This stripping is TOP-LEVEL
//      ONLY: a `null` nested inside the opaque `clankerAgent` object is
//      semantically meaningful, is PRESERVED, and DOES affect the digest.
//
//   5. Canonicalization is deterministic and explicit about null-vs-absent:
//      object keys recursively sorted; an `undefined` property is DROPPED; a
//      `null` property is KEPT; array order preserved; sha256 over the
//      whitespace-free JSON, prefixed `sha256:`.

import { createHash } from 'node:crypto';

import { AgentRuntime, type AgentManifest } from './manifest.ts';

/**
 * The keys the server's `agentDefinitionSchema` retains on the parsed
 * `AgentDefinition` — i.e. the exact field set the manifest digest is taken
 * over. Authoring-only keys (`version`, `promptFile`, `readmeFile`) and the
 * mutable `deprecated` are deliberately NOT here: the first three never reach
 * the parsed value server-side (stripped as unknowns / already resolved) and
 * `deprecated` is excluded from the digest by policy.
 *
 * Kept as an explicit allow-list (rather than a deny-list) so a NEW authoring
 * convenience added to the CLI manifest can't silently leak into the digest and
 * desync from the server — a field only counts once it's added here, matching a
 * corresponding field on the domain schema.
 */
const PARSED_MANIFEST_KEYS = [
  'id',
  'systemPrompt',
  'runtime',
  'model',
  'maxTurns',
  'needsWorkspace',
  'workspaceMode',
  'hooks',
  'description',
  'modalities',
  'entrypoint',
  'clankerAgent',
  'toolchains',
  'author',
  'maintainers',
  'license',
  'keywords',
  'homepage',
  'repository',
  'readme',
] as const;

/**
 * Project a resolved CLI manifest into the value the SERVER digests: the parsed
 * `AgentDefinition`. Applies the schema defaults the server's parse applies
 * (runtime → 'claude', hooks → []), keeps only {@link PARSED_MANIFEST_KEYS},
 * and drops top-level `null`/`undefined` values (mirroring `stripManifestNulls`
 * plus zod's optional-omission). Nested objects (notably `clankerAgent`) are
 * passed through UNTOUCHED so an inner null survives into the digest.
 *
 * The input is `unknown`-friendly (a raw record) so tests can feed hand-built
 * fixtures — including ones carrying authoring-only keys — and assert they
 * project to the same digested value.
 */
export function projectManifestForDigest(manifest: Record<string, unknown>): Record<string, unknown> {
  const withDefaults: Record<string, unknown> = { ...manifest };
  if (withDefaults.runtime === undefined || withDefaults.runtime === null) {
    withDefaults.runtime = AgentRuntime.Claude;
  }
  if (withDefaults.hooks === undefined || withDefaults.hooks === null) {
    withDefaults.hooks = [];
  }

  const projected: Record<string, unknown> = {};
  for (const key of PARSED_MANIFEST_KEYS) {
    const value = withDefaults[key];
    // Top-level null → absent (stripManifestNulls); undefined → absent (zod
    // optional omission). Present-and-non-null keys are kept verbatim.
    if (value === undefined || value === null) continue;
    projected[key] = value;
  }
  return projected;
}

/**
 * Recursively rebuild `value` with object keys sorted and `undefined`
 * object-property values dropped. A `null` property is KEPT (present null is
 * distinct from an absent key); arrays preserve order; primitives pass through.
 * This is the CLI twin of the server's `canonicalize`.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const propValue = record[key];
      if (propValue === undefined) continue; // absent, not "null"
      sorted[key] = canonicalize(propValue);
    }
    return sorted;
  }
  return value;
}

/**
 * Deterministic JSON of an arbitrary value: object keys recursively sorted,
 * array order preserved, no whitespace, `undefined` properties omitted, `null`
 * properties kept. Exposed for tests that assert the canonical string directly.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * The canonical string the manifest digest is taken over: the server-shape
 * projection (defaults applied, authoring/`deprecated` fields dropped),
 * canonicalized. Exposed so a parity test can diff the string, not just the
 * hash.
 */
export function canonicalManifestJson(manifest: Record<string, unknown>): string {
  return canonicalJson(projectManifestForDigest(manifest));
}

/**
 * `"sha256:" + hex sha256` of the canonical manifest — the value the registry
 * stores on the version row and compares on republish. Byte-for-byte equal to
 * the gateway's `manifestDigest` for structurally-equal content.
 */
export function manifestDigest(manifest: AgentManifest | Record<string, unknown>): string {
  const hash = createHash('sha256')
    .update(canonicalManifestJson(manifest as Record<string, unknown>), 'utf8')
    .digest('hex');
  return `sha256:${hash}`;
}

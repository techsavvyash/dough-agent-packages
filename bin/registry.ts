// Registry HTTP client + idempotency logic for `dough agent publish`.
//
// Publish protocol (design §2):
//   1. POST /v1/agents/validate  (dry-run; fall back gracefully on 404 — the
//      endpoint lands in a later gateway task)
//   2. GET  /v1/agents/:id/:version  — idempotency check:
//        - 404            → new version, publish
//        - 200 + same digest  → already published identically, skip
//        - 200 + diff digest  → HARD ERROR (immutability; design §3)
//   3. PUT  /v1/agents/:id/:version  with the resolved definition
//
// Auth: Bearer ${AGENT_REGISTRY_PUBLISH_TOKEN} (the existing operator token).

import { createHash } from 'node:crypto';

import type { AgentManifest } from './manifest.ts';

export interface RegistryClientOptions {
  baseUrl: string;
  token: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type PublishOutcome =
  | { kind: 'published'; id: string; version: string }
  | { kind: 'skipped'; id: string; version: string; reason: 'identical' };

export class RegistryClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RegistryClientOptions) {
    // Normalise trailing slash so `${base}/v1/...` never doubles up.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Dry-run validation against the server's authoritative schema. Returns
   * `true` if the server validated OK, `false` if the endpoint is absent
   * (404 — pre-validate-endpoint gateway), throwing on a real validation
   * rejection or transport error.
   */
  async validate(def: AgentManifest): Promise<{ validated: boolean }> {
    const url = `${this.baseUrl}/v1/agents/validate`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(def),
      });
    } catch (cause) {
      throw new RegistryError(`validate request to ${url} failed`, { cause });
    }
    if (res.status === 404) return { validated: false };
    if (res.ok) return { validated: true };
    throw new RegistryError(
      `server rejected ${def.id}@${def.version}: ${res.status} ${await safeBody(res)}`,
    );
  }

  /**
   * Idempotency check. Returns the existing version's stored digest, or null
   * if the version doesn't exist yet.
   */
  async fetchExistingDigest(id: string, version: string): Promise<string | null> {
    const url = `${this.baseUrl}/v1/agents/${encodeURIComponent(id)}/${encodeURIComponent(version)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers: this.authHeaders() });
    } catch (cause) {
      throw new RegistryError(`GET ${url} failed`, { cause });
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new RegistryError(`GET ${url} returned ${res.status} ${await safeBody(res)}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      throw new RegistryError(`GET ${url} returned non-JSON body`, { cause });
    }
    // The registry stores the definition under a top-level `definition` field
    // (matching the public catalog shape). We digest the definition it echoes
    // back so the comparison is apples-to-apples with what we're about to PUT.
    const existingDef = extractDefinition(body);
    return definitionDigest(existingDef);
  }

  /** PUT the resolved definition. */
  async put(def: AgentManifest): Promise<void> {
    const url = `${this.baseUrl}/v1/agents/${encodeURIComponent(def.id)}/${encodeURIComponent(def.version)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'PUT',
        headers: this.authHeaders(),
        body: JSON.stringify(def),
      });
    } catch (cause) {
      throw new RegistryError(`PUT ${url} failed`, { cause });
    }
    if (res.ok) return;
    if (res.status === 409) {
      throw new ImmutabilityError(def.id, def.version, await safeBody(res));
    }
    throw new RegistryError(`PUT ${url} returned ${res.status} ${await safeBody(res)}`);
  }

  /**
   * Full publish of one resolved definition: validate → idempotency check →
   * PUT. `validate` is best-effort (skipped-with-warning on 404); the caller
   * decides whether to surface the warning.
   */
  async publish(
    def: AgentManifest,
    onWarn: (msg: string) => void = () => {},
  ): Promise<PublishOutcome> {
    const { validated } = await this.validate(def);
    if (!validated) {
      onWarn(
        `server /v1/agents/validate not available (404) — skipping server-side pre-validation for ${def.id}@${def.version}`,
      );
    }

    const outgoingDigest = definitionDigest(def);
    const existingDigest = await this.fetchExistingDigest(def.id, def.version);
    if (existingDigest !== null) {
      if (existingDigest === outgoingDigest) {
        return { kind: 'skipped', id: def.id, version: def.version, reason: 'identical' };
      }
      throw new ImmutabilityError(
        def.id,
        def.version,
        `already published with a different digest (existing ${existingDigest}, local ${outgoingDigest})`,
      );
    }

    await this.put(def);
    return { kind: 'published', id: def.id, version: def.version };
  }
}

/**
 * Canonical content digest of a resolved definition. Uses stable-key JSON so
 * key order in the source agent.json never affects the digest — the digest is
 * over MEANING, not byte layout. This is the local mirror of the immutability
 * comparison the gateway performs server-side.
 */
export function definitionDigest(def: unknown): string {
  const canonical = canonicalJson(def);
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Deterministic JSON: object keys sorted recursively, arrays order-preserving. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys
    // Drop undefined-valued keys so an explicit `undefined` and an absent key
    // digest identically (JSON.stringify would drop them anyway).
    .filter((k) => obj[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]));
  return '{' + parts.join(',') + '}';
}

/** Pull the stored definition out of a registry GET body, tolerating either a
 *  `{ definition: {...} }` envelope or a bare definition object. */
function extractDefinition(body: unknown): unknown {
  if (body !== null && typeof body === 'object' && 'definition' in body) {
    return (body as { definition: unknown }).definition;
  }
  return body;
}

async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<unreadable body>';
  }
}

/** A transport / non-2xx registry error. */
export class RegistryError extends Error {
  override readonly name = 'RegistryError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Publishing an existing id@version with different content (design §3). */
export class ImmutabilityError extends Error {
  override readonly name = 'ImmutabilityError';
  constructor(
    readonly id: string,
    readonly version: string,
    detail: string,
  ) {
    super(`refusing to republish ${id}@${version}: ${detail}`);
  }
}

// Registry HTTP client + publish orchestration for `dough agent publish`.
//
// Publish protocol against the FINAL gateway contract
// (docs/design/agent-packages.md §2; dough-gateway AgentsController):
//
//   1. POST /v1/agents/validate            (publish-token-gated; ALWAYS 200)
//        → { valid, errors[], warnings[] }. errors[] are fatal; warnings[] are
//          printed (a would-conflict warning means the real publish would 409).
//   2. GET  /v1/agents/:id/:version         idempotency check:
//        → 200 { manifest, digest, deprecated, bundle? } → compare digests:
//              equal     → skip (no-op)
//              different → HARD ERROR before publishing (would 409)
//        → 404 → new version, continue.
//   3. node runtime ONLY — upload the bundle first, content-addressed:
//        PUT /v1/agents/:id/:version/bundle  (raw application/gzip body)
//        → { digest, url, key, sizeBytes }. Assert the returned digest equals
//          the sha256 we packed locally (content-address integrity).
//   4. PUT  /v1/agents/:id/:version[?bundleDigest=sha256:<hex>]
//        node → bundleDigest REQUIRED (400 without); non-node → MUST be absent.
//
// Auth: Bearer ${AGENT_REGISTRY_PUBLISH_TOKEN} (the operator publish token).
//
// The manifest content digest is computed by ./digest.ts, which mirrors the
// gateway's canonical digest exactly (parsed-shape projection, deprecated
// excluded, top-level nulls stripped, defaults applied). The idempotency
// comparison and the "would conflict" fail-fast both rest on that parity.

import type { AgentManifest } from './manifest.ts';
import { manifestDigest } from './digest.ts';
import { type PackResult, packDir } from './pack.ts';

export interface RegistryClientOptions {
  baseUrl: string;
  token: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type PublishOutcome =
  | { kind: 'published'; id: string; version: string; digest: string; bundleDigest?: string }
  | { kind: 'skipped'; id: string; version: string; reason: 'identical' };

/** Server response of POST /v1/agents/validate. */
export interface ValidateResult {
  valid: boolean;
  errors: Array<{ path: string; message: string; code?: string }>;
  warnings: string[];
}

/** Server response of GET /v1/agents/:id/:version (existing version). */
interface ExistingVersion {
  digest: string;
}

/** Server response of PUT /v1/agents/:id/:version/bundle. */
interface BundleUploadResponse {
  digest: string;
  url: string;
  key: string;
  sizeBytes: number;
}

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

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  private versionUrl(id: string, version: string): string {
    return `${this.baseUrl}/v1/agents/${encodeURIComponent(id)}/${encodeURIComponent(version)}`;
  }

  /**
   * Prepublish validation (design §2 step 1). The endpoint is publish-token
   * gated and ALWAYS returns 200 with `{ valid, errors[], warnings[] }` — the
   * verdict is in the body, not the HTTP code. We surface `errors[]` as fatal
   * and hand `warnings[]` back to the caller to print. A non-200 (or transport
   * failure) is a real infrastructure error and throws.
   */
  async validate(def: AgentManifest): Promise<ValidateResult> {
    const url = `${this.baseUrl}/v1/agents/validate`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(def),
      });
    } catch (cause) {
      throw new RegistryError(`validate request to ${url} failed`, { cause });
    }
    if (!res.ok) {
      throw new RegistryError(`POST ${url} returned ${res.status} ${await safeBody(res)}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      throw new RegistryError(`POST ${url} returned a non-JSON body`, { cause });
    }
    return normalizeValidateResult(body);
  }

  /**
   * Idempotency check (design §2 step 2). GET /v1/agents/:id/:version returns
   * the existing version's stored MANIFEST digest, or null if the version does
   * not exist yet (404). The returned digest is the gateway's manifest content
   * digest — directly comparable to our local {@link manifestDigest}.
   */
  async fetchExistingDigest(id: string, version: string): Promise<string | null> {
    const url = this.versionUrl(id, version);
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
    const digest = extractExistingDigest(body);
    if (digest === null) {
      throw new RegistryError(
        `GET ${url} returned 200 without a usable digest field (got ${JSON.stringify(body).slice(0, 200)})`,
      );
    }
    return digest;
  }

  /**
   * Upload a node-agent bundle (raw tar.gz) content-addressed (design §2 step 3).
   * Returns the server-side digest, which we assert equals the digest we packed
   * locally — a mismatch means the bytes changed in flight and the subsequent
   * `?bundleDigest=` reference would bind the manifest to the wrong blob.
   */
  async uploadBundle(id: string, version: string, pack: PackResult): Promise<BundleUploadResponse> {
    const url = `${this.versionUrl(id, version)}/bundle`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'PUT',
        headers: this.authHeaders({ 'Content-Type': 'application/gzip' }),
        // Bun/undici accept a Uint8Array body verbatim (no re-encoding).
        body: pack.bytes,
      });
    } catch (cause) {
      throw new RegistryError(`PUT ${url} (bundle) failed`, { cause });
    }
    if (!res.ok) {
      throw new RegistryError(`PUT ${url} (bundle) returned ${res.status} ${await safeBody(res)}`);
    }
    let body: BundleUploadResponse;
    try {
      body = (await res.json()) as BundleUploadResponse;
    } catch (cause) {
      throw new RegistryError(`PUT ${url} (bundle) returned non-JSON body`, { cause });
    }
    if (body.digest !== pack.digest) {
      throw new RegistryError(
        `bundle digest mismatch for ${id}@${version}: packed ${pack.digest}, server returned ${body.digest}`,
      );
    }
    return body;
  }

  /**
   * PUT the manifest (design §2 step 4). `bundleDigest` is passed for node
   * runtime ONLY; the server 400s on a node manifest without it and on a
   * non-node manifest with it. A 409 here means the version exists with
   * different content (immutability) — normally caught earlier by the digest
   * check, but re-mapped to a typed error in case of a race.
   */
  async put(def: AgentManifest, bundleDigest?: string): Promise<void> {
    let url = this.versionUrl(def.id, def.version);
    if (bundleDigest !== undefined) {
      url += `?bundleDigest=${encodeURIComponent(bundleDigest)}`;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'PUT',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
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
   * Full publish of one resolved package: validate → idempotency check →
   * (node) pack+upload bundle → PUT manifest. `packDirImpl` is injectable so
   * tests drive the ordering without touching the filesystem.
   *
   *   - validate errors[]  → fatal (RegistryError), no GET/PUT attempted.
   *   - validate warnings[] → forwarded to `onWarn`, publish continues.
   *   - GET same digest     → skip (no-op).
   *   - GET different digest → ImmutabilityError BEFORE any upload/PUT.
   */
  async publish(
    def: AgentManifest,
    onWarn: (msg: string) => void = () => {},
    packDirImpl: (dir: string) => PackResult = packDir,
    packageDir?: string,
  ): Promise<PublishOutcome> {
    const result = await this.validate(def);
    for (const w of result.warnings) onWarn(w);
    if (!result.valid) {
      const detail = result.errors
        .map((e) => `${e.path || '(root)'}: ${e.message}`)
        .join('; ');
      throw new RegistryError(
        `server rejected ${def.id}@${def.version}: ${detail || 'validation failed'}`,
      );
    }

    const outgoingDigest = manifestDigest(def);
    const existingDigest = await this.fetchExistingDigest(def.id, def.version);
    if (existingDigest !== null) {
      if (existingDigest === outgoingDigest) {
        return { kind: 'skipped', id: def.id, version: def.version, reason: 'identical' };
      }
      throw new ImmutabilityError(
        def.id,
        def.version,
        `version exists with different content (existing ${existingDigest}, local ${outgoingDigest}) — bump the version`,
      );
    }

    // node runtime ships a bundle: pack → upload → reference by digest. Every
    // other runtime MUST NOT carry a bundleDigest (server 400s otherwise).
    let bundleDigest: string | undefined;
    if (def.runtime === 'node') {
      if (packageDir === undefined) {
        throw new RegistryError(
          `internal: publishing node agent ${def.id}@${def.version} without a package directory to pack`,
        );
      }
      const packed = packDirImpl(packageDir);
      const uploaded = await this.uploadBundle(def.id, def.version, packed);
      bundleDigest = uploaded.digest;
    }

    await this.put(def, bundleDigest);
    return {
      kind: 'published',
      id: def.id,
      version: def.version,
      digest: outgoingDigest,
      ...(bundleDigest !== undefined ? { bundleDigest } : {}),
    };
  }
}

/** Coerce a raw validate body into a well-typed {@link ValidateResult}. */
function normalizeValidateResult(body: unknown): ValidateResult {
  const obj = (body ?? {}) as Record<string, unknown>;
  const errors = Array.isArray(obj.errors)
    ? (obj.errors as unknown[]).map((e) => {
        const rec = (e ?? {}) as Record<string, unknown>;
        return {
          path: typeof rec.path === 'string' ? rec.path : '',
          message: typeof rec.message === 'string' ? rec.message : String(rec.message ?? ''),
          ...(typeof rec.code === 'string' ? { code: rec.code } : {}),
        };
      })
    : [];
  const warnings = Array.isArray(obj.warnings)
    ? (obj.warnings as unknown[]).filter((w): w is string => typeof w === 'string')
    : [];
  const valid = obj.valid === true && errors.length === 0;
  return { valid, errors, warnings };
}

/**
 * Pull the existing-version digest out of a GET /v1/agents/:id/:version body.
 * The final contract returns `{ manifest, digest, deprecated, bundle? }`; we
 * read the top-level `digest`. Returns null when no digest is present.
 */
function extractExistingDigest(body: unknown): string | null {
  if (body !== null && typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    if (typeof rec.digest === 'string') return rec.digest;
  }
  return null;
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

// Re-export the digest so existing importers (publish.ts, tests) keep a single
// entry point; the implementation now lives in ./digest.ts.
export { manifestDigest } from './digest.ts';
export { canonicalJson, canonicalManifestJson } from './digest.ts';

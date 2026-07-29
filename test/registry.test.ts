// RegistryClient publish orchestration against the FINAL gateway contract:
//   validate (always-200, errors[]/warnings[]) → GET idempotency → [node] pack
//   + bundle upload → PUT manifest (?bundleDigest for node only).
//
// Every case drives a MOCKED fetch that records method + url + headers + body,
// so the tests assert the exact route order, the Content-Type per call, and the
// request bodies — not just the outcome.

import { describe, expect, mock, test } from 'bun:test';

import type { AgentManifest } from '../bin/manifest.ts';
import { manifestDigest } from '../bin/digest.ts';
import type { PackResult } from '../bin/pack.ts';
import { ImmutabilityError, RegistryClient, RegistryError } from '../bin/registry.ts';

// ── fixtures ─────────────────────────────────────────────────────────────────

function claudeDef(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: 'demo',
    version: '1.0.0',
    description: 'd',
    runtime: 'claude',
    needsWorkspace: false,
    systemPrompt: 'hello',
    hooks: [],
    ...overrides,
  } as AgentManifest;
}

function nodeDef(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: 'echo-node',
    version: '0.1.0',
    description: 'echoes',
    runtime: 'node',
    needsWorkspace: false,
    entrypoint: 'src/main.ts',
    toolchains: { node: '20' },
    hooks: [],
    ...overrides,
  } as AgentManifest;
}

/** A deterministic fake pack result (no filesystem). */
function fakePack(bytes = new Uint8Array([1, 2, 3, 4])): PackResult {
  // Digest is arbitrary but stable — the upload mock echoes it back so the
  // integrity assertion in uploadBundle passes.
  return {
    bytes,
    digest: 'sha256:' + 'ab'.repeat(32),
    files: ['src/main.ts'],
  };
}

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Build a mock fetch that records calls and answers via `handler`. */
function recordingFetch(
  handler: (call: RecordedCall) => Response,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h) {
      for (const [k, v] of Object.entries(h as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers,
      body: init?.body ?? null,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
const OK_VALIDATE = { valid: true, errors: [], warnings: [] };

// ── validate gate ────────────────────────────────────────────────────────────

describe('validate gate', () => {
  test('errors[] are fatal — no GET/PUT attempted', async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) {
        return json(200, {
          valid: false,
          errors: [{ path: 'description', message: 'description is required', code: 'schema' }],
          warnings: [],
        });
      }
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    await expect(client.publish(claudeDef())).rejects.toBeInstanceOf(RegistryError);
    expect(calls.map((c) => c.method)).toEqual(['POST']); // validate only
    await expect(client.publish(claudeDef())).rejects.toThrow('description is required');
  });

  test('warnings[] are printed and publish continues', async () => {
    const warnings: string[] = [];
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) {
        return json(200, {
          valid: true,
          errors: [],
          warnings: ['demo@1.0.0 already exists with different content — bump the version'],
        });
      }
      if (call.method === 'GET') return new Response(null, { status: 404 });
      if (call.method === 'PUT') return json(200, { id: 'demo', version: '1.0.0' });
      throw new Error('unexpected');
    });
    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    const outcome = await client.publish(claudeDef(), (m) => warnings.push(m));
    expect(outcome.kind).toBe('published');
    expect(warnings.join(' ')).toContain('bump the version');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'PUT']);
  });

  test('validate non-200 (real infra failure) throws before any GET/PUT', async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) return json(500, { error: 'boom' });
      return json(200, {});
    });
    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    await expect(client.publish(claudeDef())).rejects.toBeInstanceOf(RegistryError);
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });
});

// ── publish ordering + headers + body shapes ─────────────────────────────────

describe('claude publish (no bundle)', () => {
  test('new version: POST validate → GET 404 → PUT manifest (no bundleDigest)', async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) return json(200, OK_VALIDATE);
      if (call.method === 'GET') return new Response(null, { status: 404 });
      if (call.method === 'PUT') return json(200, { id: 'demo', version: '1.0.0' });
      throw new Error('unexpected');
    });
    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    const def = claudeDef();
    const outcome = await client.publish(def);

    expect(outcome).toEqual({ kind: 'published', id: 'demo', version: '1.0.0', digest: manifestDigest(def) });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://gw/v1/agents/validate',
      'GET https://gw/v1/agents/demo/1.0.0',
      'PUT https://gw/v1/agents/demo/1.0.0',
    ]);
    // Auth on every call.
    for (const c of calls) expect(c.headers.authorization).toBe('Bearer t');
    // JSON content type on validate + PUT; the PUT carries NO ?bundleDigest.
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[2]!.headers['content-type']).toBe('application/json');
    expect(calls[2]!.url).not.toContain('bundleDigest');
    // PUT body is the resolved manifest.
    expect(JSON.parse(calls[2]!.body as string)).toMatchObject({ id: 'demo', runtime: 'claude' });
  });

  test('identical existing version → skip (GET digest matches, no PUT)', async () => {
    const def = claudeDef();
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) return json(200, OK_VALIDATE);
      if (call.method === 'GET') {
        return json(200, { manifest: def, digest: manifestDigest(def), deprecated: false });
      }
      throw new Error('unexpected PUT');
    });
    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    const outcome = await client.publish(def);
    expect(outcome).toEqual({ kind: 'skipped', id: 'demo', version: '1.0.0', reason: 'identical' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  test('existing version, different digest → ImmutabilityError before any PUT', async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) return json(200, OK_VALIDATE);
      if (call.method === 'GET') {
        return json(200, {
          manifest: { id: 'demo' },
          digest: 'sha256:' + '00'.repeat(32),
          deprecated: false,
        });
      }
      throw new Error('unexpected PUT');
    });
    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    await expect(client.publish(claudeDef())).rejects.toBeInstanceOf(ImmutabilityError);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  test('GET 200 without a digest field is a hard error', async () => {
    const { fetchImpl } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) return json(200, OK_VALIDATE);
      if (call.method === 'GET') return json(200, { manifest: { id: 'demo' } });
      throw new Error('unexpected');
    });
    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    await expect(client.publish(claudeDef())).rejects.toBeInstanceOf(RegistryError);
  });

  test('PUT 409 (race) surfaces as ImmutabilityError', async () => {
    const { fetchImpl } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) return json(200, OK_VALIDATE);
      if (call.method === 'GET') return new Response(null, { status: 404 });
      if (call.method === 'PUT') return json(409, { error: 'immutable' });
      throw new Error('unexpected');
    });
    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    await expect(client.publish(claudeDef())).rejects.toBeInstanceOf(ImmutabilityError);
  });
});

// ── node bundle upload flow ──────────────────────────────────────────────────

describe('node publish (bundle upload)', () => {
  test('new version: validate → GET 404 → PUT bundle → PUT manifest?bundleDigest', async () => {
    const packed = fakePack();
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) return json(200, OK_VALIDATE);
      if (call.method === 'GET') return new Response(null, { status: 404 });
      if (call.method === 'PUT' && call.url.endsWith('/bundle')) {
        return json(200, {
          digest: packed.digest,
          url: 'https://blob/x',
          key: 'agent-bundles/x.tar.gz',
          sizeBytes: packed.bytes.length,
        });
      }
      if (call.method === 'PUT') return json(200, { id: 'echo-node', version: '0.1.0' });
      throw new Error('unexpected');
    });
    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    const def = nodeDef();
    const outcome = await client.publish(def, () => {}, () => packed, '/pkg/echo-node');

    expect(outcome).toEqual({
      kind: 'published',
      id: 'echo-node',
      version: '0.1.0',
      digest: manifestDigest(def),
      bundleDigest: packed.digest,
    });
    // Exact route order: bundle BEFORE manifest.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://gw/v1/agents/validate',
      'GET https://gw/v1/agents/echo-node/0.1.0',
      'PUT https://gw/v1/agents/echo-node/0.1.0/bundle',
      `PUT https://gw/v1/agents/echo-node/0.1.0?bundleDigest=${encodeURIComponent(packed.digest)}`,
    ]);
    // The bundle PUT carries the raw gzip body + application/gzip content-type.
    const bundleCall = calls[2]!;
    expect(bundleCall.headers['content-type']).toBe('application/gzip');
    expect(bundleCall.body).toBe(packed.bytes); // raw bytes, not JSON
    // The manifest PUT is JSON.
    expect(calls[3]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[3]!.body as string)).toMatchObject({ runtime: 'node' });
  });

  test('server-returned bundle digest mismatch is a hard error (no manifest PUT)', async () => {
    const packed = fakePack();
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) return json(200, OK_VALIDATE);
      if (call.method === 'GET') return new Response(null, { status: 404 });
      if (call.url.endsWith('/bundle')) {
        return json(200, { digest: 'sha256:' + 'ff'.repeat(32), url: 'u', key: 'k', sizeBytes: 4 });
      }
      throw new Error('unexpected manifest PUT');
    });
    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    await expect(
      client.publish(nodeDef(), () => {}, () => packed, '/pkg/echo-node'),
    ).rejects.toThrow(/digest mismatch/);
    expect(calls.some((c) => c.url.endsWith('/0.1.0') && c.method === 'PUT')).toBe(false);
  });

  test('identical node version skips WITHOUT packing or uploading', async () => {
    const def = nodeDef();
    let packed = false;
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) return json(200, OK_VALIDATE);
      if (call.method === 'GET') {
        return json(200, { manifest: def, digest: manifestDigest(def), deprecated: false });
      }
      throw new Error('unexpected upload/PUT');
    });
    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    const outcome = await client.publish(
      def,
      () => {},
      () => {
        packed = true;
        return fakePack();
      },
      '/pkg/echo-node',
    );
    expect(outcome.kind).toBe('skipped');
    expect(packed).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/bundle'))).toBe(false);
  });

  test('node publish without a package dir is a hard error (nothing to pack)', async () => {
    const { fetchImpl } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) return json(200, OK_VALIDATE);
      if (call.method === 'GET') return new Response(null, { status: 404 });
      throw new Error('unexpected');
    });
    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    // packageDir omitted → cannot pack the required bundle.
    await expect(client.publish(nodeDef(), () => {}, () => fakePack())).rejects.toBeInstanceOf(
      RegistryError,
    );
  });
});

// ── url + header hygiene ─────────────────────────────────────────────────────

describe('client hygiene', () => {
  test('trailing slashes on baseUrl are normalised', async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) return json(200, OK_VALIDATE);
      if (call.method === 'GET') return new Response(null, { status: 404 });
      return json(200, {});
    });
    const client = new RegistryClient({ baseUrl: 'https://gw///', token: 't', fetchImpl });
    await client.publish(claudeDef());
    expect(calls.every((c) => !c.url.includes('gw//'))).toBe(true);
    expect(calls.map((c) => c.url)).toContain('https://gw/v1/agents/demo/1.0.0');
  });

  test('id/version are URL-encoded in the path', async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.url.endsWith('/validate')) return json(200, OK_VALIDATE);
      if (call.method === 'GET') return new Response(null, { status: 404 });
      return json(200, {});
    });
    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    await client.publish(claudeDef({ id: 'scope/name' } as Partial<AgentManifest>));
    expect(calls.find((c) => c.method === 'GET')!.url).toBe('https://gw/v1/agents/scope%2Fname/1.0.0');
  });
});

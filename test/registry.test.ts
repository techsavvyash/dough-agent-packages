// Registry client: canonical digest stability, publish idempotency (new /
// identical-skip / different-hard-error), validate 404 fallback, and
// server-rejection surfacing — all with a mock fetch (no network).

import { describe, expect, mock, test } from 'bun:test';

import type { AgentManifest } from '../bin/manifest.ts';
import {
  ImmutabilityError,
  RegistryClient,
  RegistryError,
  canonicalJson,
  definitionDigest,
} from '../bin/registry.ts';

function def(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: 'demo',
    version: '1.0.0',
    description: 'd',
    runtime: 'claude',
    needsWorkspace: false,
    roles: ['chat'],
    systemPrompt: 'hello',
    hooks: [],
    ...overrides,
  } as AgentManifest;
}

/** A tiny Response builder for the mock fetch. */
function res(status: number, body?: unknown): Response {
  const init: ResponseInit = { status };
  if (body === undefined) return new Response(null, init);
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('canonical digest', () => {
  test('key order does not change the digest', () => {
    const a = definitionDigest({ id: 'x', version: '1.0.0', roles: ['chat'] });
    const b = definitionDigest({ roles: ['chat'], version: '1.0.0', id: 'x' });
    expect(a).toBe(b);
  });

  test('array order DOES change the digest (arrays are meaningful)', () => {
    const a = definitionDigest({ hooks: ['a', 'b'] });
    const b = definitionDigest({ hooks: ['b', 'a'] });
    expect(a).not.toBe(b);
  });

  test('a value change changes the digest', () => {
    expect(definitionDigest(def())).not.toBe(definitionDigest(def({ description: 'e' })));
  });

  test('digest is sha256: hex', () => {
    expect(definitionDigest(def())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('canonicalJson sorts nested keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('publish idempotency', () => {
  test('new version: validate → GET 404 → PUT', async () => {
    const calls: { method: string; url: string }[] = [];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (url.endsWith('/v1/agents/validate')) return res(200, { ok: true });
      if (method === 'GET') return res(404);
      if (method === 'PUT') return res(200, { ok: true });
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch;

    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    const outcome = await client.publish(def());
    expect(outcome).toEqual({ kind: 'published', id: 'demo', version: '1.0.0' });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'PUT']);
  });

  test('identical existing version is skipped (no PUT)', async () => {
    const d = def();
    let putCalled = false;
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/v1/agents/validate')) return res(200, { ok: true });
      if (method === 'GET') return res(200, { definition: d });
      if (method === 'PUT') {
        putCalled = true;
        return res(200);
      }
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    const outcome = await client.publish(d);
    expect(outcome).toEqual({ kind: 'skipped', id: 'demo', version: '1.0.0', reason: 'identical' });
    expect(putCalled).toBe(false);
  });

  test('existing version with different content is a hard error (no PUT)', async () => {
    let putCalled = false;
    const stored = def({ description: 'OLD DESCRIPTION' });
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/v1/agents/validate')) return res(200, { ok: true });
      if (method === 'GET') return res(200, { definition: stored });
      if (method === 'PUT') {
        putCalled = true;
        return res(200);
      }
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    await expect(client.publish(def({ description: 'NEW DESCRIPTION' }))).rejects.toBeInstanceOf(
      ImmutabilityError,
    );
    expect(putCalled).toBe(false);
  });

  test('idempotency compares digest, tolerating a bare (unenveloped) GET body', async () => {
    const d = def();
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/v1/agents/validate')) return res(404); // no validate endpoint
      if (method === 'GET') return res(200, d); // bare definition, no envelope
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    const outcome = await client.publish(d);
    expect(outcome.kind).toBe('skipped');
  });
});

describe('validate fallback + errors', () => {
  test('validate 404 warns and continues to publish', async () => {
    const warnings: string[] = [];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/v1/agents/validate')) return res(404);
      if (method === 'GET') return res(404);
      if (method === 'PUT') return res(200);
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    const outcome = await client.publish(def(), (m) => warnings.push(m));
    expect(outcome.kind).toBe('published');
    expect(warnings.join(' ')).toContain('validate not available');
  });

  test('validate rejection (400) throws RegistryError before any GET/PUT', async () => {
    let sawGetOrPut = false;
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/v1/agents/validate')) return res(400, { error: 'bad roles' });
      sawGetOrPut = true;
      return res(200);
    }) as unknown as typeof fetch;

    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    await expect(client.publish(def())).rejects.toBeInstanceOf(RegistryError);
    expect(sawGetOrPut).toBe(false);
  });

  test('PUT 409 surfaces as ImmutabilityError', async () => {
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/v1/agents/validate')) return res(200, { ok: true });
      if (method === 'GET') return res(404);
      if (method === 'PUT') return res(409, { error: 'immutable' });
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    const client = new RegistryClient({ baseUrl: 'https://gw', token: 't', fetchImpl });
    await expect(client.publish(def())).rejects.toBeInstanceOf(ImmutabilityError);
  });

  test('base URL trailing slash is normalised', async () => {
    const urls: string[] = [];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      const method = init?.method ?? 'GET';
      if (String(input).endsWith('/v1/agents/validate')) return res(200);
      if (method === 'GET') return res(404);
      return res(200);
    }) as unknown as typeof fetch;

    const client = new RegistryClient({ baseUrl: 'https://gw///', token: 't', fetchImpl });
    await client.publish(def());
    expect(urls.every((u) => !u.includes('gw//'))).toBe(true);
    expect(urls).toContain('https://gw/v1/agents/demo/1.0.0');
  });
});

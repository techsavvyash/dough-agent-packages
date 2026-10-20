// The CLI dispatches each agents/ directory on agent.json `kind`: registry
// agents go through the registry protocol (/v1/agents), app templates are PUT
// to /v1/agent-templates. Driven against the real registry packages in this
// repo and the fixture app template (agents/ holds no app templates) with a
// recording fetch, so the assertions cover the exact routes per kind.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadTemplate, templateDigest } from '../bin/agent-template.ts';
import { cmdPack, cmdPublish, cmdValidate } from '../bin/publish.ts';

const AGENTS = join(import.meta.dir, '..', 'agents');
const TEMPLATE = join(import.meta.dir, 'fixtures', 'templates', 'example-assistant');
const DEFAULT = join(AGENTS, 'default');
const ENV = { gatewayUrl: 'https://gw.test', publishToken: 'tok' };

let logs: string[];
let errors: string[];
const spies: Array<{ mockRestore(): void }> = [];
const roots: string[] = [];

beforeEach(() => {
  logs = [];
  errors = [];
  spies.push(spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' '))));
  spies.push(spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' '))));
  spies.push(spyOn(console, 'warn').mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

/** A gateway double: registry endpoints answer "new version", templates answer `templateStatus`. */
function gateway(templateStatus: number, templatePayload?: unknown): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
    if (req.method === 'PUT' && path.endsWith('/bundle')) {
      // A node bundle (raw tar.gz): content-addressed like the real gateway.
      const bytes = new Uint8Array(await req.arrayBuffer());
      calls.push({ method: req.method, path, auth: req.headers.get('authorization'), body: undefined });
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      return json({ digest, url: `https://blobs.test${path}`, key: path, sizeBytes: bytes.length }, 201);
    }
    const text = await req.text();
    const body = text === '' ? undefined : JSON.parse(text);
    calls.push({ method: req.method, path, auth: req.headers.get('authorization'), body });
    if (path === '/v1/agents/validate') return json({ valid: true, errors: [], warnings: [] });
    if (path.startsWith('/v1/agents/') && req.method === 'GET') return json({}, 404);
    if (path.startsWith('/v1/agents/') && req.method === 'PUT') return json({}, 201);
    if (path.startsWith('/v1/agent-templates/')) {
      const b = body as Parameters<typeof templateDigest>[0];
      const outcome = templateStatus === 201 ? 'created' : 'unchanged';
      return json(templatePayload ?? { outcome, template: { digest: templateDigest(b) } }, templateStatus);
    }
    return json({ message: 'unexpected' }, 500);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('publish dispatch on kind', () => {
  test('a registry agent and an app template each go to their own endpoint', async () => {
    const { fetchImpl, calls } = gateway(201);
    const code = await cmdPublish([DEFAULT, TEMPLATE], ENV, fetchImpl);
    expect(code).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/agents/validate',
      'GET /v1/agents/default/1.2.0',
      'PUT /v1/agents/default/1.2.0',
      'PUT /v1/agent-templates/example-assistant/1.0.0',
    ]);
    expect(calls.every((c) => c.auth === 'Bearer tok')).toBe(true);
    const templateCall = calls[3]!;
    expect(templateCall.body).toEqual(loadTemplate(TEMPLATE));
    // The registry body never carries a kind; the template body is {template, files} only.
    expect(Object.keys(templateCall.body as object).sort()).toEqual(['files', 'template']);
    expect('kind' in (calls[2]!.body as object)).toBe(false);
    expect(logs.join('\n')).toContain(
      `PUBLISHED example-assistant@1.0.0 (app template)  digest=${templateDigest(loadTemplate(TEMPLATE))}`,
    );
    expect(logs.at(-1)).toContain('published 2, skipped 0, failed 0');
  });

  test('an identical template (200) is skipped', async () => {
    const { fetchImpl } = gateway(200);
    expect(await cmdPublish([TEMPLATE], ENV, fetchImpl)).toBe(0);
    expect(logs.join('\n')).toContain('SKIP      example-assistant@1.0.0 (app template)  (identical already published)');
    expect(logs.at(-1)).toContain('published 0, skipped 1, failed 0');
  });

  test('a deprecation-only update (200 deprecation-updated) counts as published', async () => {
    const digest = templateDigest(loadTemplate(TEMPLATE));
    const { fetchImpl } = gateway(200, { outcome: 'deprecation-updated', template: { digest } });
    expect(await cmdPublish([TEMPLATE], ENV, fetchImpl)).toBe(0);
    expect(logs.join('\n')).toContain('UPDATED   example-assistant@1.0.0 (app template)  (undeprecated; content unchanged)');
    expect(logs.at(-1)).toContain('published 1, skipped 0, failed 0');
  });

  test('a conflicting template (409) fails the run with a bump-the-version error', async () => {
    const { fetchImpl } = gateway(409, { statusCode: 409, message: 'conflict' });
    expect(await cmdPublish([TEMPLATE, DEFAULT], ENV, fetchImpl)).toBe(1);
    expect(errors.join('\n')).toContain(`bump "version" in ${TEMPLATE}/agent.json`);
    // The other package still publishes.
    expect(logs.at(-1)).toContain('published 1, skipped 0, failed 1');
  });

  test('missing env stops before any request', async () => {
    const { fetchImpl, calls } = gateway(201);
    expect(await cmdPublish([TEMPLATE], { gatewayUrl: undefined, publishToken: 'tok' }, fetchImpl)).toBe(2);
    expect(await cmdPublish([TEMPLATE], { gatewayUrl: 'https://gw.test', publishToken: undefined }, fetchImpl)).toBe(2);
    expect(calls).toEqual([]);
  });
});

describe('the real agents/ set', () => {
  // agents/* is what CI validates and publishes on main. A template removed
  // from the repo is simply not published again:
  // the CLI keeps no inventory of what was published before.
  const all = readdirSync(AGENTS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(AGENTS, e.name))
    .sort();

  test('validates clean', async () => {
    expect(all.length).toBeGreaterThan(0);
    expect(await cmdValidate(all)).toBe(0);
    expect(logs.join('\n')).not.toContain('(app template)');
    expect(logs.at(-1)).toBe(`\nall ${all.length} package(s) valid`);
    expect(errors).toEqual([]);
  });

  test('publishes with zero failures and never touches /v1/agent-templates', async () => {
    const { fetchImpl, calls } = gateway(201);
    expect(await cmdPublish(all, ENV, fetchImpl)).toBe(0);
    expect(calls.filter((c) => c.path.startsWith('/v1/agent-templates/'))).toEqual([]);
    // One manifest PUT per package, plus the bundle upload of example-node.
    const manifestPuts = calls.filter((c) => c.method === 'PUT' && !c.path.endsWith('/bundle'));
    expect(manifestPuts.length).toBe(all.length);
    expect(calls.filter((c) => c.path.endsWith('/bundle')).map((c) => c.path)).toEqual([
      expect.stringMatching(/^\/v1\/agents\/example-node\/[^/]+\/bundle$/),
    ]);
    expect(logs.at(-1)).toBe(`\npublished ${all.length}, skipped 0, failed 0`);
    expect(errors).toEqual([]);
  });
});

describe('validate and pack dispatch on kind', () => {
  test('validate accepts every package in this repo and prints the template digest', async () => {
    const dirs = [...['coder', 'default', 'example-node', 'pr-reviewer'].map((d) => join(AGENTS, d)), TEMPLATE];
    expect(await cmdValidate(dirs)).toBe(0);
    expect(logs.join('\n')).toContain(`OK  example-assistant@1.0.0 (app template)  digest=${templateDigest(loadTemplate(TEMPLATE))}`);
    expect(logs.join('\n')).toContain('OK  default@1.2.0 (claude)');
  });

  test('validate reports every issue of an invalid template and fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-cli-'));
    roots.push(root);
    const dir = join(root, 'broken');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({ kind: 'app', id: 'broken', version: '1.0.0', description: 'd', seed: { persona: 'persona.md' } }),
    );
    writeFileSync(join(dir, 'orphan.md'), 'x');
    expect(await cmdValidate([dir, DEFAULT])).toBe(1);
    const out = errors.join('\n');
    expect(out).toContain(`ERR ${dir}: invalid app template:`);
    expect(out).toContain('seed.persona references "persona.md", which is not in the template');
    expect(out).toContain('file "orphan.md" is not referenced by agent.json');
    expect(out).toContain('1 of 2 package(s) failed validation');
  });

  test('an unknown kind fails validation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-cli-'));
    roots.push(root);
    const raw = JSON.parse(readFileSync(join(DEFAULT, 'agent.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(root, 'agent.json'), JSON.stringify({ ...raw, kind: 'service' }));
    expect(await cmdValidate([root])).toBe(1);
    expect(errors.join('\n')).toContain('"kind" must be "task" or "app", got "service"');
  });

  test('pack skips app templates', async () => {
    expect(await cmdPack([TEMPLATE])).toBe(0);
    expect(errors.join('\n')).toContain('SKIP example-assistant@1.0.0 (app template): app templates ship no bundle');
  });
});

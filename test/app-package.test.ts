import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AppPackageBody,
  AppPackageError,
  AppPublishError,
  appPackageDigest,
  deployTokenFor,
  loadAppPackage,
  publishAppPackage,
  validateAppPackage,
} from '../bin/app-package.ts';

const roots: string[] = [];

/** Writes `files` into <tmp>/<appName> and returns that directory. */
function pkgDir(appName: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'app-pkg-'));
  roots.push(root);
  const dir = join(root, appName);
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppPackageError) return err.issues;
    throw err;
  }
  throw new Error('expected an AppPackageError');
}

const FULL_AGENT = {
  $schema: 'https://api.try-dough.com/v1/agent-package/schema',
  description: 'test agent',
  assistantName: 'Tess',
  model: 'gpt-6-luna',
  tools: { memory: true, tasks: true, agents: false, events: false, connections: true, webSearch: true },
  approvals: true,
  connectApps: ['google-calendar', 'gmail'],
  notes: 'notes.md',
  subAgents: [
    {
      id: 'worker',
      name: 'Worker',
      description: 'does tasks',
      instructions: 'worker.md',
      tools: { memory: true, connections: true, webSearch: false },
      default: true,
    },
  ],
};

describe('loadAppPackage', () => {
  test('loads a full package: $schema dropped, README ignored, files referenced', () => {
    const dir = pkgDir('tess', {
      'agent.json': JSON.stringify(FULL_AGENT),
      'persona.md': 'You are Tess.\n',
      'notes.md': '- be kind\n',
      'worker.md': 'You are a worker.\n',
      'README.md': '# docs only\n',
    });
    const { appName, body } = loadAppPackage(dir);
    expect(appName).toBe('tess');
    expect(body.persona).toBe('You are Tess.\n');
    expect(body.files).toEqual({ 'notes.md': '- be kind\n', 'worker.md': 'You are a worker.\n' });
    expect('$schema' in body.agent).toBe(false);
    expect(body.agent.subAgents?.[0]?.default).toBe(true);
  });

  test('a v1-shaped package has no files key at all', () => {
    const dir = pkgDir('plain', {
      'agent.json': JSON.stringify({ assistantName: 'Plain' }),
      'persona.md': 'Hi.',
    });
    const { body } = loadAppPackage(dir);
    expect(body).toEqual({ agent: { assistantName: 'Plain' }, persona: 'Hi.' });
  });

  test('rejects unknown agent.json keys (strict)', () => {
    const dir = pkgDir('typo', {
      'agent.json': JSON.stringify({ assistant_name: 'x' }),
      'persona.md': 'Hi.',
    });
    expect(issuesOf(() => loadAppPackage(dir)).join(' ')).toContain('assistant_name');
  });

  test('rejects missing persona, invalid JSON and stray files', () => {
    expect(issuesOf(() => loadAppPackage(pkgDir('a', { 'agent.json': '{}' })))).toEqual([
      'missing persona.md',
    ]);
    expect(
      issuesOf(() => loadAppPackage(pkgDir('b', { 'agent.json': '{', 'persona.md': 'x' })))[0],
    ).toStartWith('agent.json is not valid JSON');
    const stray = issuesOf(() =>
      loadAppPackage(pkgDir('c', { 'agent.json': '{}', 'persona.md': 'x', 'run.sh': 'echo' })),
    );
    expect(stray).toContain('unexpected file "run.sh" (only .md files are part of a package)');
  });

  test('rejects an unreferenced file and a dangling reference', () => {
    const issues = issuesOf(() =>
      loadAppPackage(
        pkgDir('refs', {
          'agent.json': JSON.stringify({ notes: 'notes.md' }),
          'persona.md': 'x',
          'extra.md': 'y',
        }),
      ),
    );
    expect(issues).toContain('notes references "notes.md", which is not in the package');
    expect(issues).toContain('file "extra.md" is not referenced by agent.json');
  });

  test('rejects a directory name that is not an app name', () => {
    const issues = issuesOf(() =>
      loadAppPackage(pkgDir('Bad_Name', { 'agent.json': '{}', 'persona.md': 'x' })),
    );
    expect(issues).toContain('directory name "Bad_Name" is not a valid app name');
  });
});

describe('validateAppPackage cross-field rules', () => {
  const base = (agent: AppPackageBody['agent'], files?: Record<string, string>): AppPackageBody => ({
    agent,
    persona: 'p',
    ...(files ? { files } : {}),
  });

  test('capabilities that need tasks are rejected when tasks is off', () => {
    const issues = validateAppPackage(
      base(
        {
          tools: { tasks: false, agents: true },
          approvals: true,
          subAgents: [{ id: 'w', name: 'W', description: 'd', instructions: 'w.md' }],
        },
        { 'w.md': 'x' },
      ),
      'app',
    );
    expect(issues).toEqual([
      'tools.agents requires tools.tasks',
      'approvals requires tools.tasks',
      'subAgents requires tools.tasks',
    ]);
  });

  test('connectApps needs connections', () => {
    expect(
      validateAppPackage(base({ tools: { connections: false }, connectApps: ['gmail'] }), 'app'),
    ).toEqual(['connectApps requires tools.connections']);
  });

  test('sub-agent ids: unique, not the app name; at most one default', () => {
    const sub = (id: string) => ({
      id,
      name: id,
      description: 'd',
      instructions: 'w.md',
      default: true,
    });
    const issues = validateAppPackage(
      base({ subAgents: [sub('app'), sub('w'), sub('w')] }, { 'w.md': 'x' }),
      'app',
    );
    expect(issues).toEqual([
      'subAgents[0].id "app" is the app\'s own agent id',
      'subAgents[2].id "w" is duplicated',
      'at most one sub-agent may be the default',
    ]);
  });

  test('"worker" is reserved unless it is the default sub-agent', () => {
    const worker = { id: 'worker', name: 'W', description: 'd', instructions: 'w.md' };
    expect(validateAppPackage(base({ subAgents: [worker] }, { 'w.md': 'x' }), 'app')).toEqual([
      'subAgents[0].id "worker" is reserved for the default worker; mark it default or rename it',
    ]);
    expect(
      validateAppPackage(base({ subAgents: [{ ...worker, default: true }] }, { 'w.md': 'x' }), 'app'),
    ).toEqual([]);
  });

  test('size limits and empty files', () => {
    const big = 'x'.repeat(64 * 1024 + 1);
    const issues = validateAppPackage(
      { agent: { notes: 'n.md' }, persona: big, files: { 'n.md': '' } },
      'app',
    );
    expect(issues).toContain('persona.md exceeds 65536 bytes');
    expect(issues).toContain('file "n.md" is empty');
  });

  test('a valid full package has no issues', () => {
    const { $schema: _s, ...agent } = FULL_AGENT;
    expect(
      validateAppPackage(base(agent, { 'notes.md': 'n', 'worker.md': 'w' }), 'tess'),
    ).toEqual([]);
  });
});

describe('appPackageDigest', () => {
  test('matches the gateway digest of a published v1 package (no files)', () => {
    // Prod concierge v1 on 2026-10-20 was sha256:fe1901aa…; this is the same
    // canonical form on a small package, pinned from the gateway algorithm.
    const body = { agent: { model: 'm', assistantName: 'A' }, persona: 'p' };
    const reordered = { persona: 'p', agent: { assistantName: 'A', model: 'm' } };
    expect(appPackageDigest(body)).toBe(appPackageDigest(reordered));
    expect(appPackageDigest(body)).toBe(
      `sha256:${new Bun.CryptoHasher('sha256').update('{"agent":{"assistantName":"A","model":"m"},"persona":"p"}').digest('hex')}`,
    );
  });

  test('empty files hash like no files; files change the digest', () => {
    const plain = { agent: {}, persona: 'p' };
    expect(appPackageDigest({ ...plain, files: {} })).toBe(appPackageDigest(plain));
    expect(appPackageDigest({ agent: { notes: 'n.md' }, persona: 'p', files: { 'n.md': 'x' } })).toBe(
      `sha256:${new Bun.CryptoHasher('sha256').update('{"agent":{"notes":"n.md"},"files":{"n.md":"x"},"persona":"p"}').digest('hex')}`,
    );
  });
});

describe('publishAppPackage', () => {
  const body: AppPackageBody = { agent: { assistantName: 'A' }, persona: 'p' };
  const digest = appPackageDigest(body);

  function fakeFetch(status: number, payload: unknown, seen: Request[] = []): typeof fetch {
    return (async (input: string, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response(JSON.stringify(payload), { status });
    }) as typeof fetch;
  }

  test('PUTs the body with the deploy token; 201 = published', async () => {
    const seen: Request[] = [];
    const out = await publishAppPackage({
      gatewayUrl: 'https://gw.test/',
      token: 'dpt_abc',
      appName: 'concierge',
      body,
      fetchImpl: fakeFetch(201, { version: { version: 7, digest }, deployed: false }, seen),
    });
    expect(out).toEqual({ status: 'published', version: 7, digest });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.url).toBe('https://gw.test/v1/apps/concierge/agent');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer dpt_abc');
    expect(await seen[0]!.json()).toEqual(body);
  });

  test('200 = already active', async () => {
    const out = await publishAppPackage({
      gatewayUrl: 'https://gw.test',
      token: 'dpt_abc',
      appName: 'concierge',
      body,
      fetchImpl: fakeFetch(200, { version: { version: 3, digest }, deployed: false }),
    });
    expect(out.status).toBe('unchanged');
  });

  test('surfaces gateway validation messages and digest mismatches', async () => {
    const rejected = publishAppPackage({
      gatewayUrl: 'https://gw.test',
      token: 'dpt_abc',
      appName: 'concierge',
      body,
      fetchImpl: fakeFetch(400, { statusCode: 400, message: ['a', 'b'], error: 'Bad Request' }),
    });
    await expect(rejected).rejects.toThrow('publishing concierge failed (HTTP 400): a; b');
    await expect(rejected).rejects.toBeInstanceOf(AppPublishError);

    await expect(
      publishAppPackage({
        gatewayUrl: 'https://gw.test',
        token: 'dpt_abc',
        appName: 'concierge',
        body,
        fetchImpl: fakeFetch(201, { version: { version: 1, digest: 'sha256:other' } }),
      }),
    ).rejects.toThrow('does not match the local');
  });
});

describe('deployTokenFor', () => {
  test('picks the app token from the JSON map', () => {
    expect(deployTokenFor('concierge', '{"concierge":"dpt_1","other":"dpt_2"}')).toBe('dpt_1');
  });

  test('fails clearly when unset, malformed or missing the app', () => {
    expect(() => deployTokenFor('x', undefined)).toThrow('DOUGH_DEPLOY_TOKENS is not set');
    expect(() => deployTokenFor('x', '{')).toThrow('not valid JSON');
    expect(() => deployTokenFor('x', '{"y":"dpt_1"}')).toThrow('no deploy token for "x"');
    expect(() => deployTokenFor('x', '{"x":"secret"}')).toThrow('no deploy token for "x"');
  });
});

describe('apps/ in this repo', () => {
  const APPS = join(import.meta.dir, '..', 'apps');

  test('every app package validates', () => {
    const names = readdirSync(APPS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(names).toContain('concierge');
    for (const name of names) {
      const { appName, body } = loadAppPackage(join(APPS, name));
      expect(appName).toBe(name);
      expect(body.persona.trim().length).toBeGreaterThan(0);
    }
  });

  test('concierge files have no trailing newline (the host uses them verbatim)', () => {
    // The host appends notes.md after its host notes and uses worker.md as the
    // worker prompt byte for byte; these files reproduce Dough's prompts
    // exactly as they ran before the package format took them over.
    const { body } = loadAppPackage(join(APPS, 'concierge'));
    for (const [name, text] of Object.entries(body.files ?? {})) {
      expect({ name, endsWithNewline: text.endsWith('\n') }).toEqual({ name, endsWithNewline: false });
    }
    expect(body.agent.subAgents?.map((s) => [s.id, s.default])).toEqual([['worker', true]]);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AgentTemplate,
  type AgentTemplateBody,
  AgentTemplateError,
  PackageKind,
  TemplatePublishError,
  agentTemplateJsonSchema,
  loadTemplate,
  packageKind,
  publishTemplate,
  templateDigest,
  validateTemplateFiles,
} from '../bin/agent-template.ts';
import { canonicalJson } from '../bin/digest.ts';

const roots: string[] = [];

/** Writes `files` into <tmp>/<dirName> and returns that directory. */
function templateDir(dirName: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-template-'));
  roots.push(root);
  const dir = join(root, dirName);
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
    if (err instanceof AgentTemplateError) return err.issues;
    throw err;
  }
  throw new Error('expected an AgentTemplateError');
}

/** The cross-field issues of a raw agent.json, as "path: message". */
function schemaIssues(raw: unknown): string[] {
  const parsed = agentTemplateJsonSchema.safeParse(raw);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

const FULL = {
  $schema: 'https://api.try-dough.com/v1/agent-template/schema',
  kind: 'app',
  id: 'tess',
  version: '1.2.0',
  description: 'test template',
  model: 'gpt-6-luna',
  tools: { memory: true, tasks: true, agents: false, events: false, connections: true, webSearch: true },
  approvals: true,
  subAgents: [
    {
      id: 'worker',
      name: 'Worker',
      description: 'does tasks',
      instructions: 'worker.md',
      tools: { memory: true, connections: true, webSearch: false },
      default: true,
    },
    { id: 'researcher', name: 'Researcher', description: 'looks things up', instructions: 'research.md' },
  ],
  seed: {
    persona: 'persona.md',
    notes: 'notes.md',
    assistantName: 'Tess',
    connectApps: ['google-calendar', 'gmail'],
  },
};

const FULL_FILES = {
  'persona.md': 'You are Tess.',
  'notes.md': '- be kind',
  'worker.md': 'You are a worker.',
  'research.md': 'You research.',
};

const MINIMAL = { kind: 'app', id: 'mini', version: '0.1.0', description: 'smallest template' };

describe('packageKind', () => {
  test('absent and "task" are registry agents, "app" is a template', () => {
    expect(packageKind({})).toBe(PackageKind.Task);
    expect(packageKind({ kind: 'task' })).toBe(PackageKind.Task);
    expect(packageKind({ kind: 'app' })).toBe(PackageKind.App);
  });

  test('an unknown kind is an error, not a guess', () => {
    expect(() => packageKind({ kind: 'apps' })).toThrow('"kind" must be "task" or "app", got "apps"');
    expect(() => packageKind({ kind: 1 })).toThrow('got 1');
  });
});

describe('loadTemplate', () => {
  test('loads a full template: $schema dropped, README ignored, every .md file sent verbatim', () => {
    const dir = templateDir('tess', {
      'agent.json': JSON.stringify(FULL),
      ...FULL_FILES,
      'README.md': '# catalog page\n',
    });
    const body = loadTemplate(dir);
    const { $schema: _s, ...expected } = FULL;
    expect(body.template).toEqual(expected as AgentTemplate);
    expect('$schema' in body.template).toBe(false);
    expect(body.files).toEqual(FULL_FILES);
  });

  test('a minimal template has no files and an empty files object', () => {
    const body = loadTemplate(templateDir('mini', { 'agent.json': JSON.stringify(MINIMAL) }));
    expect(body).toEqual({ template: MINIMAL as AgentTemplate, files: {} });
  });

  test('the directory name must be the template id', () => {
    const issues = issuesOf(() => loadTemplate(templateDir('other', { 'agent.json': JSON.stringify(MINIMAL) })));
    expect(issues).toEqual(['directory name "other" must equal the template id "mini"']);
  });

  test('missing or invalid agent.json', () => {
    expect(issuesOf(() => loadTemplate(templateDir('mini', {})))).toEqual(['missing agent.json']);
    expect(issuesOf(() => loadTemplate(templateDir('mini', { 'agent.json': '{' })))[0]).toStartWith(
      'agent.json is not valid JSON',
    );
  });

  test('rejects unknown keys at every level (strict)', () => {
    const issues = issuesOf(() =>
      loadTemplate(
        templateDir('mini', {
          'agent.json': JSON.stringify({
            ...MINIMAL,
            assistant_name: 'x',
            tools: { memry: true },
            seed: { persona: 'persona.md', persona_file: 'x' },
          }),
          'persona.md': 'p',
        }),
      ),
    );
    const joined = issues.join('\n');
    expect(joined).toContain('assistant_name');
    expect(joined).toContain('memry');
    expect(joined).toContain('persona_file');
  });

  test('rejects stray files and directories', () => {
    const dir = templateDir('mini', { 'agent.json': JSON.stringify(MINIMAL), 'run.sh': 'echo' });
    mkdirSync(join(dir, 'sub'));
    expect(issuesOf(() => loadTemplate(dir))).toEqual([
      'unexpected file "run.sh" (only .md files are part of a template)',
      'unexpected directory "sub"',
    ]);
  });

  test('rejects an unreferenced file and dangling references', () => {
    const issues = issuesOf(() =>
      loadTemplate(
        templateDir('mini', {
          'agent.json': JSON.stringify({
            ...MINIMAL,
            subAgents: [{ id: 'w', name: 'W', description: 'd', instructions: 'w.md' }],
            seed: { persona: 'persona.md', notes: 'notes.md' },
          }),
          'persona.md': 'p',
          'extra.md': 'y',
        }),
      ),
    );
    expect(issues).toEqual([
      'subAgents.0.instructions references "w.md", which is not in the template',
      'seed.notes references "notes.md", which is not in the template',
      'file "extra.md" is not referenced by agent.json',
    ]);
  });
});

describe('agent.json schema', () => {
  test('the full and minimal templates are valid', () => {
    expect(schemaIssues(FULL)).toEqual([]);
    expect(schemaIssues(MINIMAL)).toEqual([]);
  });

  test('identity: kind "app", slug id, strict semver, non-empty description', () => {
    expect(schemaIssues({ ...MINIMAL, kind: 'task' })[0]).toStartWith('kind: ');
    expect(schemaIssues({ ...MINIMAL, id: 'Bad_Id' })).toEqual([
      'id: must be lowercase letters, digits and "-"',
    ]);
    expect(schemaIssues({ ...MINIMAL, version: '1.0' })).toEqual([
      'version: version must be strict semver (e.g. 1.4.0 or 1.4.0-rc.1)',
    ]);
    expect(schemaIssues({ ...MINIMAL, description: '' })[0]).toStartWith('description: ');
    expect(schemaIssues({ ...MINIMAL, description: 'x'.repeat(501) })[0]).toStartWith('description: ');
    const { description: _d, ...noDescription } = MINIMAL;
    expect(schemaIssues(noDescription)).toEqual(['description: Required']);
  });

  test('model, assistantName and connectApps formats', () => {
    expect(schemaIssues({ ...MINIMAL, model: 'has space' })).toEqual(['model: must be a model id']);
    expect(schemaIssues({ ...MINIMAL, seed: { persona: 'p.md', assistantName: '   ' } })[0]).toStartWith(
      'seed.assistantName: ',
    );
    expect(schemaIssues({ ...MINIMAL, seed: { persona: 'p.md', connectApps: ['Gmail'] } })).toEqual([
      'seed.connectApps.0: must be lowercase letters, digits and "-"',
    ]);
    const tooMany = Array.from({ length: 21 }, (_, i) => `app-${i}`);
    expect(schemaIssues({ ...MINIMAL, seed: { persona: 'p.md', connectApps: tooMany } })[0]).toStartWith(
      'seed.connectApps: ',
    );
  });

  test('a seed needs a persona file; file references must be .md names', () => {
    expect(schemaIssues({ ...MINIMAL, seed: { notes: 'n.md' } })).toEqual(['seed.persona: Required']);
    expect(schemaIssues({ ...MINIMAL, seed: { persona: '../persona.md' } })[0]).toStartWith('seed.persona: must be a file name');
    expect(
      schemaIssues({
        ...MINIMAL,
        subAgents: [{ id: 'w', name: 'W', description: 'd', instructions: 'W.txt' }],
      })[0],
    ).toStartWith('subAgents.0.instructions: must be a file name');
  });

  test('capabilities that need tasks are rejected when the tasks ceiling is off', () => {
    expect(
      schemaIssues({
        ...MINIMAL,
        tools: { tasks: false, agents: true },
        approvals: true,
        subAgents: [{ id: 'w', name: 'W', description: 'd', instructions: 'w.md' }],
      }),
    ).toEqual([
      'tools.agents: requires tools.tasks (it is false)',
      'approvals: requires tools.tasks (it is false)',
      'subAgents: requires tools.tasks (it is false)',
    ]);
    // Off is fine as long as nothing depends on it.
    expect(schemaIssues({ ...MINIMAL, tools: { tasks: false, agents: false }, approvals: false })).toEqual([]);
  });

  test('seed.connectApps needs the connections ceiling', () => {
    expect(
      schemaIssues({ ...MINIMAL, tools: { connections: false }, seed: { persona: 'p.md', connectApps: ['gmail'] } }),
    ).toEqual(['seed.connectApps: requires tools.connections (it is false)']);
    expect(
      schemaIssues({ ...MINIMAL, tools: { connections: false }, seed: { persona: 'p.md', connectApps: [] } }),
    ).toEqual([]);
  });

  test('sub-agent ids: "worker" reserved unless default, unique, at most one default', () => {
    const sub = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: id,
      description: 'd',
      instructions: 'w.md',
      ...extra,
    });
    expect(schemaIssues({ ...MINIMAL, subAgents: [sub('worker')] })).toEqual([
      'subAgents.0.id: "worker" is reserved for the default worker; mark it default or rename it',
    ]);
    expect(schemaIssues({ ...MINIMAL, subAgents: [sub('worker', { default: true })] })).toEqual([]);
    expect(
      schemaIssues({
        ...MINIMAL,
        subAgents: [sub('a', { default: true }), sub('b'), sub('a', { default: true })],
      }),
    ).toEqual([
      'subAgents.2.id: duplicate sub-agent id "a" (also subAgents[0])',
      'subAgents: at most one sub-agent may be the default (subAgents 0, 2 are)',
    ]);
    expect(schemaIssues({ ...MINIMAL, subAgents: [sub('a', { tools: { tasks: true } })] })[0]).toContain(
      'tasks',
    );
  });

  test('at most 16 sub-agents', () => {
    const subAgents = Array.from({ length: 17 }, (_, i) => ({
      id: `s${i}`,
      name: 'S',
      description: 'd',
      instructions: 'w.md',
    }));
    expect(schemaIssues({ ...MINIMAL, subAgents })[0]).toStartWith('subAgents: ');
  });
});

describe('validateTemplateFiles', () => {
  const template = (seedFiles: string[]): AgentTemplate =>
    ({
      ...MINIMAL,
      subAgents: seedFiles.map((file, i) => ({ id: `s${i}`, name: 'S', description: 'd', instructions: file })),
    }) as AgentTemplate;

  test('names, empty files and per-file size (UTF-8 bytes)', () => {
    // 'é' is two bytes: 32768 of them are 64 KiB exactly, one more is over.
    const atLimit = 'é'.repeat(32 * 1024);
    const issues = validateTemplateFiles({
      template: template(['ok.md', 'empty.md', 'big.md', 'Bad.md']),
      files: { 'ok.md': atLimit, 'empty.md': '', 'big.md': `${atLimit}x`, 'Bad.md': 'x' },
    });
    expect(issues).toEqual([
      'file "empty.md" is empty',
      'file "big.md" exceeds 65536 bytes',
      'file "Bad.md": invalid name',
    ]);
  });

  test('at most 16 files and 256 KiB in total', () => {
    const names = Array.from({ length: 17 }, (_, i) => `f${i}.md`);
    const files = Object.fromEntries(names.map((n) => [n, 'x'.repeat(16 * 1024)]));
    const issues = validateTemplateFiles({ template: template(names), files });
    expect(issues).toEqual(['at most 16 files (got 17)', 'files exceed 262144 bytes in total (got 278528)']);

    const fiveBig = Object.fromEntries(
      ['a.md', 'b.md', 'c.md', 'd.md'].map((n) => [n, 'x'.repeat(64 * 1024)]),
    );
    expect(validateTemplateFiles({ template: template(Object.keys(fiveBig)), files: fiveBig })).toEqual([]);
    fiveBig['e.md'] = 'x';
    expect(validateTemplateFiles({ template: template(Object.keys(fiveBig)), files: fiveBig })).toEqual([
      'files exceed 262144 bytes in total (got 262145)',
    ]);
  });

  test('a file referenced twice is fine; persona.md is an ordinary file in a template', () => {
    const body: AgentTemplateBody = {
      template: { ...template(['w.md', 'w.md']), seed: { persona: 'persona.md' } },
      files: { 'w.md': 'x', 'persona.md': 'p' },
    };
    expect(validateTemplateFiles(body)).toEqual([]);
  });
});

describe('templateDigest', () => {
  const body: AgentTemplateBody = {
    template: { kind: 'app', id: 'mini', version: '0.1.0', description: 'd', seed: { persona: 'p.md' } },
    files: { 'p.md': 'hi' },
  };

  test('sha256 of the canonical JSON of {template, files}', () => {
    const expected = createHash('sha256')
      .update(
        '{"files":{"p.md":"hi"},"template":{"description":"d","id":"mini","kind":"app","seed":{"persona":"p.md"},"version":"0.1.0"}}',
        'utf8',
      )
      .digest('hex');
    expect(templateDigest(body)).toBe(`sha256:${expected}`);
  });

  test('key order never changes it; content always does', () => {
    const reordered: AgentTemplateBody = {
      files: { 'p.md': 'hi' },
      template: { seed: { persona: 'p.md' }, description: 'd', version: '0.1.0', id: 'mini', kind: 'app' },
    };
    expect(templateDigest(reordered)).toBe(templateDigest(body));
    expect(templateDigest({ ...body, files: { 'p.md': 'hi\n' } })).not.toBe(templateDigest(body));
    expect(templateDigest({ ...body, template: { ...body.template, version: '0.1.1' } })).not.toBe(
      templateDigest(body),
    );
  });

  test('$schema is not part of the digest (loadTemplate drops it)', () => {
    const files = { 'agent.json': JSON.stringify(MINIMAL) };
    const withSchema = { 'agent.json': JSON.stringify({ $schema: 'https://example.com/s', ...MINIMAL }) };
    expect(templateDigest(loadTemplate(templateDir('mini', withSchema)))).toBe(
      templateDigest(loadTemplate(templateDir('mini', files))),
    );
  });
});

describe('publishTemplate', () => {
  const body: AgentTemplateBody = {
    template: { kind: 'app', id: 'mini', version: '0.1.0', description: 'd' },
    files: {},
  };
  const digest = templateDigest(body);

  function fakeFetch(status: number, payload: unknown, seen: Request[] = []): typeof fetch {
    return (async (input: string, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response(JSON.stringify(payload), { status });
    }) as typeof fetch;
  }

  test('PUTs {template, files} with the publish token; 201 = published', async () => {
    const seen: Request[] = [];
    const out = await publishTemplate({
      gatewayUrl: 'https://gw.test/',
      token: 'tok',
      body,
      fetchImpl: fakeFetch(201, { id: 'mini', version: '0.1.0', digest }, seen),
    });
    expect(out).toEqual({ status: 'published', id: 'mini', version: '0.1.0', digest });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.url).toBe('https://gw.test/v1/agent-templates/mini/0.1.0');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer tok');
    expect(seen[0]!.headers.get('content-type')).toBe('application/json');
    expect(await seen[0]!.json()).toEqual(body);
  });

  test('200 = identical content already published; a nested digest is read too', async () => {
    const out = await publishTemplate({
      gatewayUrl: 'https://gw.test',
      token: 'tok',
      body,
      fetchImpl: fakeFetch(200, { template: { id: 'mini', version: '0.1.0', digest } }),
    });
    expect(out.status).toBe('unchanged');
    expect(out.digest).toBe(digest);
  });

  test('409 tells to bump the version', async () => {
    const conflict = publishTemplate({
      gatewayUrl: 'https://gw.test',
      token: 'tok',
      body,
      fetchImpl: fakeFetch(409, { statusCode: 409, message: 'conflict', digest: 'sha256:stored' }),
    });
    await expect(conflict).rejects.toBeInstanceOf(TemplatePublishError);
    await expect(conflict).rejects.toThrow(
      `template mini@0.1.0 is already published with different content (stored sha256:stored, local ${digest}) — templates are immutable: bump "version" in agents/mini/agent.json`,
    );
  });

  test('surfaces gateway validation messages', async () => {
    const rejected = publishTemplate({
      gatewayUrl: 'https://gw.test',
      token: 'tok',
      body,
      fetchImpl: fakeFetch(400, { statusCode: 400, message: ['a', 'b'], error: 'Bad Request' }),
    });
    await expect(rejected).rejects.toThrow('publishing template mini@0.1.0 failed (HTTP 400): a; b');
    try {
      await rejected;
    } catch (err) {
      expect((err as TemplatePublishError).status).toBe(400);
    }
  });

  test('a digest mismatch or a missing digest is an error', async () => {
    await expect(
      publishTemplate({
        gatewayUrl: 'https://gw.test',
        token: 'tok',
        body,
        fetchImpl: fakeFetch(201, { digest: 'sha256:other' }),
      }),
    ).rejects.toThrow(`server digest sha256:other does not match the local ${digest}`);
    await expect(
      publishTemplate({ gatewayUrl: 'https://gw.test', token: 'tok', body, fetchImpl: fakeFetch(201, {}) }),
    ).rejects.toThrow('response carries no digest');
  });

  test('a transport failure is a TemplatePublishError', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      publishTemplate({ gatewayUrl: 'https://gw.test', token: 'tok', body, fetchImpl: failing }),
    ).rejects.toThrow('publishing template mini@0.1.0: request failed: ECONNREFUSED');
  });
});

describe('app templates in this repo', () => {
  const AGENTS = join(import.meta.dir, '..', 'agents');
  const CONCIERGE = join(AGENTS, 'concierge');

  test('every kind "app" directory under agents/ is a valid template', () => {
    const templates = readdirSync(AGENTS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => packageKind(JSON.parse(readFileSync(join(AGENTS, name, 'agent.json'), 'utf8'))) === 'app');
    expect(templates).toEqual(['concierge']);
    for (const name of templates) expect(loadTemplate(join(AGENTS, name)).template.id).toBe(name);
  });

  test('concierge 1.0.0: worker sub-agent, every ceiling on, Dough seed', () => {
    const { template, files } = loadTemplate(CONCIERGE);
    expect(template.version).toBe('1.0.0');
    expect(template.model).toBe('gpt-6-luna');
    expect(template.tools).toEqual({
      memory: true,
      tasks: true,
      agents: true,
      events: true,
      connections: true,
      webSearch: true,
    });
    expect(template.approvals).toBe(true);
    expect(template.subAgents?.map((s) => [s.id, s.instructions, s.default])).toEqual([['worker', 'worker.md', true]]);
    expect(template.seed).toEqual({
      persona: 'persona.md',
      notes: 'notes.md',
      assistantName: 'Dough',
      connectApps: ['google-calendar', 'gmail', 'github', 'notion', 'linear'],
    });
    expect(Object.keys(files).sort()).toEqual(['notes.md', 'persona.md', 'worker.md']);
  });

  test('concierge files are verbatim: notes.md and worker.md keep no trailing newline', () => {
    // The host appends notes.md after its host notes and uses worker.md as the
    // worker prompt byte for byte; these reproduce Dough's prompts exactly.
    const { files } = loadTemplate(CONCIERGE);
    expect(files['notes.md']!.endsWith('\n')).toBe(false);
    expect(files['worker.md']!.endsWith('\n')).toBe(false);
    expect(files['persona.md']!.endsWith('\n')).toBe(true);
  });

  test('concierge template + seed reassemble the former apps/concierge package exactly', () => {
    // apps/concierge (main at c8619c5, the package CI published to the app)
    // hashed to this digest with the gateway's agentPackageDigest. Rebuilding
    // that package from the template proves the move kept every byte and field.
    const { template, files } = loadTemplate(CONCIERGE);
    const seed = template.seed!;
    const agent = {
      description: template.description,
      assistantName: seed.assistantName,
      model: template.model,
      notes: seed.notes,
      connectApps: seed.connectApps,
      subAgents: template.subAgents,
    };
    const content = {
      agent,
      files: { 'notes.md': files['notes.md'], 'worker.md': files['worker.md'] },
      persona: files['persona.md'],
    };
    const digest = `sha256:${createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex')}`;
    expect(digest).toBe('sha256:7b226e817eacd29f1576b319bf3dfbe550eb988783e7fb68aab3faad2ae5ee17');
  });

  test('concierge template digest is pinned (bump the version when this changes)', () => {
    expect(templateDigest(loadTemplate(CONCIERGE))).toBe(CONCIERGE_TEMPLATE_DIGEST);
  });
});

/**
 * concierge@1.0.0 as published. A change here means the template content
 * changed: the published 1.0.0 is immutable, so bump "version" too.
 */
const CONCIERGE_TEMPLATE_DIGEST = 'sha256:3b5aeacab4bb43b621e8ff16672eec07e98a2f8611f90f58fec9f40bb64b3b0a';

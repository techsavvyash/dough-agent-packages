// Template namespaces: platform templates have bare ids and publish with the
// operator token; team templates are "@<team-slug>/<name>" and publish with a
// team template token (tpt_…). Covers id parsing, the URL for each form, the
// token picked for each, and the CLI end to end against a recording gateway.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TemplateNamespace,
  TemplateTokenError,
  agentTemplateJsonSchema,
  loadTemplate,
  parseTemplateId,
  publishTemplate,
  selectTemplateToken,
  templateDigest,
  templateVersionUrl,
} from '../bin/agent-template.ts';
import { cmdPublish, cmdValidate } from '../bin/publish.ts';

const roots: string[] = [];
let logs: string[];
let errors: string[];
const spies: Array<{ mockRestore(): void }> = [];

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

/** Writes a minimal template `id` into <tmp>/<dirName>. */
function templateDir(id: string, dirName: string): string {
  const root = mkdtempSync(join(tmpdir(), 'namespace-'));
  roots.push(root);
  const dir = join(root, dirName);
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({ kind: 'app', id, version: '1.0.0', description: 'd', seed: { persona: 'persona.md' } }),
  );
  writeFileSync(join(dir, 'persona.md'), 'You help.');
  return dir;
}

describe('parseTemplateId', () => {
  test('bare ids are platform templates', () => {
    expect(parseTemplateId('concierge')).toEqual({ namespace: 'platform', name: 'concierge' });
    expect(parseTemplateId('a')).toEqual({ namespace: 'platform', name: 'a' });
    expect(parseTemplateId(`a${'b'.repeat(63)}`)?.namespace).toBe(TemplateNamespace.Platform);
  });

  test('"@<team-slug>/<name>" are team templates', () => {
    expect(parseTemplateId('@acme/support-bot')).toEqual({
      namespace: 'team',
      scope: 'acme',
      name: 'support-bot',
    });
    expect(parseTemplateId('@a/b')).toEqual({ namespace: 'team', scope: 'a', name: 'b' });
    // Team slugs: 1–48 chars, no leading or trailing "-".
    expect(parseTemplateId(`@a${'b'.repeat(46)}c/x`)?.namespace).toBe(TemplateNamespace.Team);
    expect(parseTemplateId('@team-42/x')?.namespace).toBe(TemplateNamespace.Team);
  });

  test('anything else is not a template id', () => {
    for (const id of [
      '',
      'Concierge',
      '-concierge',
      'con cierge',
      `a${'b'.repeat(64)}`, // name over 64
      '@acme',
      '@acme/',
      '@/bot',
      'acme/bot', // a scope needs its "@"
      '@Acme/bot',
      '@-acme/bot',
      '@acme-/bot',
      `@a${'b'.repeat(47)}c/bot`, // slug over 48
      '@acme/Bot',
      '@acme/bot/extra',
      '@acme/@bot',
      '@@acme/bot',
    ]) {
      expect({ id, ref: parseTemplateId(id) }).toEqual({ id, ref: undefined });
    }
  });

  test('the agent.json schema accepts exactly the ids parseTemplateId does', () => {
    const base = { kind: 'app', version: '1.0.0', description: 'd' };
    for (const id of ['concierge', '@acme/support-bot', 'acme/bot', '@acme/Bot', '@acme']) {
      expect(agentTemplateJsonSchema.safeParse({ ...base, id }).success).toBe(parseTemplateId(id) !== undefined);
    }
  });
});

describe('templateVersionUrl', () => {
  test('platform: /v1/agent-templates/<name>/<version>', () => {
    expect(templateVersionUrl('https://gw.test/', 'concierge', '1.0.0')).toBe(
      'https://gw.test/v1/agent-templates/concierge/1.0.0',
    );
  });

  test('team: /v1/agent-templates/@<scope>/<name>/<version> with "@" and "/" literal', () => {
    expect(templateVersionUrl('https://gw.test', '@acme/support-bot', '2.1.0-rc.1')).toBe(
      'https://gw.test/v1/agent-templates/@acme/support-bot/2.1.0-rc.1',
    );
    // The URL parser keeps it as three path segments under agent-templates.
    const path = new URL(templateVersionUrl('https://gw.test', '@acme/support-bot', '2.1.0')).pathname;
    expect(path.split('/').slice(3)).toEqual(['@acme', 'support-bot', '2.1.0']);
  });

  test('an invalid id never becomes a URL', () => {
    expect(() => templateVersionUrl('https://gw.test', 'acme/bot', '1.0.0')).toThrow(
      'template id "acme/bot" must be a template name',
    );
  });
});

describe('selectTemplateToken', () => {
  const both = { templateToken: 'tpt_team', publishToken: 'op_secret' };

  test('team templates take DOUGH_TEMPLATE_TOKEN, platform ones AGENT_REGISTRY_PUBLISH_TOKEN', () => {
    expect(selectTemplateToken('@acme/bot', both)).toBe('tpt_team');
    expect(selectTemplateToken('concierge', both)).toBe('op_secret');
    // Surrounding whitespace (a pasted secret) is not part of the token.
    expect(selectTemplateToken('@acme/bot', { templateToken: ' tpt_team\n' })).toBe('tpt_team');
  });

  test('a team template without a team token names DOUGH_TEMPLATE_TOKEN, even if the operator token is set', () => {
    for (const env of [{}, { publishToken: 'op_secret' }, { templateToken: '  ' }]) {
      expect(() => selectTemplateToken('@acme/bot', env)).toThrow(
        '@acme/bot is a team template: set DOUGH_TEMPLATE_TOKEN to a template publish token (tpt_…) of team "acme"',
      );
    }
  });

  test('a platform template without the operator token names AGENT_REGISTRY_PUBLISH_TOKEN, even if a team token is set', () => {
    for (const env of [{}, { templateToken: 'tpt_team' }]) {
      expect(() => selectTemplateToken('support-bot', env)).toThrow(
        'support-bot is a platform template: set AGENT_REGISTRY_PUBLISH_TOKEN (the operator token; only the dough operators publish bare ids — team templates are "@<team-slug>/support-bot")',
      );
    }
  });

  test('tokens in the wrong variable are refused locally', () => {
    expect(() => selectTemplateToken('@acme/bot', { templateToken: 'op_secret' })).toThrow(
      'DOUGH_TEMPLATE_TOKEN is not a template publish token (expected tpt_…)',
    );
    expect(() => selectTemplateToken('concierge', { publishToken: 'tpt_team' })).toThrow(
      'AGENT_REGISTRY_PUBLISH_TOKEN holds a team template token (tpt_…), which can never publish platform template concierge',
    );
    expect(() => selectTemplateToken('concierge', {})).toThrow(TemplateTokenError);
  });
});

describe('team templates on disk', () => {
  test('the directory is named after the name part of "@scope/name"', () => {
    const body = loadTemplate(templateDir('@acme/support-bot', 'support-bot'));
    expect(body.template.id).toBe('@acme/support-bot');
  });

  test('a directory named after the scope or the full id is refused', () => {
    expect(() => loadTemplate(templateDir('@acme/support-bot', 'acme'))).toThrow(
      'directory name "acme" must equal the template name "support-bot" (of id "@acme/support-bot")',
    );
  });

  test('the scope is not part of the digest: the same template under any namespace hashes alike', () => {
    const team = loadTemplate(templateDir('@acme/support-bot', 'support-bot'));
    const renamed = loadTemplate(templateDir('@acme-corp/support-bot', 'support-bot'));
    const platform = loadTemplate(templateDir('support-bot', 'support-bot'));
    // The body still carries the full id; only the digest drops the scope.
    expect(team.template.id).toBe('@acme/support-bot');
    expect(templateDigest(team)).toBe(templateDigest(renamed));
    expect(templateDigest(team)).toBe(templateDigest(platform));
    // Pinned: canonical {files, template} with the bare name.
    const expected = new Bun.CryptoHasher('sha256')
      .update(
        '{"files":{"persona.md":"You help."},"template":{"description":"d","id":"support-bot","kind":"app","seed":{"persona":"persona.md"},"version":"1.0.0"}}',
      )
      .digest('hex');
    expect(templateDigest(team)).toBe(`sha256:${expected}`);
    // The name still counts.
    const other = loadTemplate(templateDir('@acme/triage', 'triage'));
    expect(templateDigest(other)).not.toBe(templateDigest(team));
  });
});

describe('publishing each form', () => {
  interface Call {
    method: string;
    path: string;
    auth: string | null;
    body: unknown;
  }

  /** Answers every template PUT with `created` and the right digest; registry calls as a new version. */
  function gateway(): { fetchImpl: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const req = new Request(input, init);
      const text = await req.text();
      const body = text === '' ? undefined : JSON.parse(text);
      const path = new URL(req.url).pathname;
      calls.push({ method: req.method, path, auth: req.headers.get('authorization'), body });
      const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
      if (path.startsWith('/v1/agent-templates/')) {
        return json({ outcome: 'created', template: { digest: templateDigest(body) } }, 201);
      }
      if (path === '/v1/agents/validate') return json({ valid: true, errors: [], warnings: [] });
      if (req.method === 'GET') return json({}, 404);
      return json({}, 201);
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  test('publishTemplate PUTs a team template to its scoped URL', async () => {
    const { fetchImpl, calls } = gateway();
    const body = loadTemplate(templateDir('@acme/support-bot', 'support-bot'));
    const out = await publishTemplate({ gatewayUrl: 'https://gw.test', token: 'tpt_team', body, fetchImpl });
    expect(out.outcome).toBe('created');
    expect(out.id).toBe('@acme/support-bot');
    expect(calls).toEqual([
      { method: 'PUT', path: '/v1/agent-templates/@acme/support-bot/1.0.0', auth: 'Bearer tpt_team', body },
    ]);
  });

  test('a repo of team templates publishes with only DOUGH_TEMPLATE_TOKEN', async () => {
    const { fetchImpl, calls } = gateway();
    const dirs = [templateDir('@acme/support-bot', 'support-bot'), templateDir('@acme/triage', 'triage')];
    const code = await cmdPublish(
      dirs,
      { gatewayUrl: 'https://gw.test', publishToken: undefined, templateToken: 'tpt_team' },
      fetchImpl,
    );
    expect(code).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path} ${c.auth}`)).toEqual([
      'PUT /v1/agent-templates/@acme/support-bot/1.0.0 Bearer tpt_team',
      'PUT /v1/agent-templates/@acme/triage/1.0.0 Bearer tpt_team',
    ]);
    expect(logs.join('\n')).toContain('PUBLISHED @acme/support-bot@1.0.0 (app template)');
    expect(logs.at(-1)).toContain('published 2, skipped 0, failed 0');
  });

  test('each package gets its own token; one missing token fails only that package', async () => {
    const { fetchImpl, calls } = gateway();
    const team = templateDir('@acme/support-bot', 'support-bot');
    const platform = templateDir('helper', 'helper');
    const registry = join(import.meta.dir, '..', 'agents', 'default');

    // Only the team token: the platform template and the registry agent fail, each with its variable named.
    const teamOnly = await cmdPublish(
      [platform, team, registry],
      { gatewayUrl: 'https://gw.test', publishToken: undefined, templateToken: 'tpt_team' },
      fetchImpl,
    );
    expect(teamOnly).toBe(1);
    expect(calls.map((c) => c.path)).toEqual(['/v1/agent-templates/@acme/support-bot/1.0.0']);
    const out = errors.join('\n');
    expect(out).toContain(`ERR ${platform}: helper is a platform template: set AGENT_REGISTRY_PUBLISH_TOKEN`);
    expect(out).toContain(`ERR ${registry}: registry agent default@1.2.0 needs AGENT_REGISTRY_PUBLISH_TOKEN`);
    expect(logs.at(-1)).toContain('published 1, skipped 0, failed 2');

    // Only the operator token: the team template fails, the other two publish with the operator token.
    calls.length = 0;
    errors.length = 0;
    const operatorOnly = await cmdPublish(
      [platform, team, registry],
      { gatewayUrl: 'https://gw.test', publishToken: 'op_secret' },
      fetchImpl,
    );
    expect(operatorOnly).toBe(1);
    expect(calls.map((c) => `${c.method} ${c.path} ${c.auth}`)).toEqual([
      'PUT /v1/agent-templates/helper/1.0.0 Bearer op_secret',
      'POST /v1/agents/validate Bearer op_secret',
      'GET /v1/agents/default/1.2.0 Bearer op_secret',
      'PUT /v1/agents/default/1.2.0 Bearer op_secret',
    ]);
    expect(errors.join('\n')).toContain(`ERR ${team}: @acme/support-bot is a team template: set DOUGH_TEMPLATE_TOKEN`);
  });

  test('no token at all stops before any request', async () => {
    const { fetchImpl, calls } = gateway();
    const code = await cmdPublish(
      [templateDir('@acme/support-bot', 'support-bot')],
      { gatewayUrl: 'https://gw.test', publishToken: undefined, templateToken: undefined },
      fetchImpl,
    );
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(errors).toEqual(['publish: neither AGENT_REGISTRY_PUBLISH_TOKEN nor DOUGH_TEMPLATE_TOKEN is set']);
  });

  test('validate needs no token and prints the namespaced id', async () => {
    expect(await cmdValidate([templateDir('@acme/support-bot', 'support-bot')])).toBe(0);
    expect(logs.join('\n')).toContain('OK  @acme/support-bot@1.0.0 (app template)  digest=sha256:');
  });
});

describe('the reusable workflow', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'publish-templates.yml'), 'utf8'),
  ) as {
    on: { workflow_call: { inputs: Record<string, { default: string }>; secrets: Record<string, { required: boolean }> } };
    jobs: { templates: { steps: Array<{ name?: string; uses?: string; if?: string; with?: Record<string, string>; env?: Record<string, string>; run?: string }> } };
  };
  const steps = workflow.jobs.templates.steps;
  const step = (name: string) => steps.find((s) => s.name === name)!;

  test('is called with a path glob, a gateway URL and an optional team token', () => {
    // YAML 1.1 reads the bare key `on` as the boolean true; GitHub reads it as "on".
    const on = workflow.on ?? (workflow as unknown as Record<string, typeof workflow.on>)['true']!;
    const call = on.workflow_call;
    expect(call.inputs.path!.default).toBe('agents/*');
    expect(call.inputs['gateway-url']!.default).toBe('https://api.try-dough.com');
    expect(Object.keys(call.secrets)).toEqual(['DOUGH_TEMPLATE_TOKEN']);
    expect(call.secrets.DOUGH_TEMPLATE_TOKEN!.required).toBe(false);
  });

  test('runs this repo\'s CLI at the commit the caller pinned', () => {
    expect(step('Check out the publish CLI').with).toEqual({
      repository: '${{ job.workflow_repository }}',
      ref: '${{ job.workflow_sha }}',
      path: 'cli',
    });
    expect(step('Validate').run).toContain('bun ../cli/bin/publish.ts validate');
    expect(step('Publish').run).toContain('bun ../cli/bin/publish.ts publish');
  });

  test('validates always, publishes only on a push to the default branch, with the token only there', () => {
    expect(step('Validate').if).toBeUndefined();
    expect(step('Validate').env).toEqual({ TEMPLATE_GLOB: '${{ inputs.path }}' });
    expect(step('Publish').if).toBe(
      "github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    );
    expect(step('Publish').env).toEqual({
      TEMPLATE_GLOB: '${{ inputs.path }}',
      DOUGH_GATEWAY_URL: '${{ inputs.gateway-url }}',
      DOUGH_TEMPLATE_TOKEN: '${{ secrets.DOUGH_TEMPLATE_TOKEN }}',
    });
  });

  test('the glob expansion keeps directories only and fails when nothing matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-glob-'));
    roots.push(root);
    mkdirSync(join(root, 'agents', 'support-bot'), { recursive: true });
    mkdirSync(join(root, 'agents', 'triage'));
    writeFileSync(join(root, 'agents', 'README.md'), '#');
    // The Validate script, with the CLI call replaced by printing its arguments.
    const script = step('Validate').run!.replace('bun ../cli/bin/publish.ts validate', 'printf "%s\\n"');
    const run = (glob: string) =>
      Bun.spawnSync(['bash', '-c', script], { cwd: root, env: { ...process.env, TEMPLATE_GLOB: glob } });
    const ok = run('agents/*');
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString().trim().split('\n')).toEqual(['agents/support-bot', 'agents/triage']);
    const none = run('templates/*');
    expect(none.exitCode).toBe(1);
    expect(none.stderr.toString()).toContain("no template directories match 'templates/*'");
  });
});

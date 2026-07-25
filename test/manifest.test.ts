// Manifest schema accept/reject matrix — the per-runtime superRefine (design
// §1 shape table), the roles enum, workspace/hook coherence, and semver.

import { describe, expect, test } from 'bun:test';

import {
  ManifestValidationError,
  agentManifestSchema,
  parseManifest,
} from '../bin/manifest.ts';

/** A minimal valid claude manifest to spread + mutate per case. */
function baseClaude(): Record<string, unknown> {
  return {
    id: 'x',
    version: '1.0.0',
    description: 'd',
    runtime: 'claude',
    needsWorkspace: false,
    roles: ['chat'],
    systemPrompt: 'hi',
  };
}

function accepts(raw: Record<string, unknown>): void {
  const res = agentManifestSchema.safeParse(raw);
  if (!res.success) {
    throw new Error('expected accept but got: ' + JSON.stringify(res.error.issues, null, 2));
  }
  expect(res.success).toBe(true);
}

function rejects(raw: Record<string, unknown>, messageSubstring?: string): void {
  const res = agentManifestSchema.safeParse(raw);
  expect(res.success).toBe(false);
  if (!res.success && messageSubstring) {
    const joined = res.error.issues.map((i) => i.message).join(' | ');
    expect(joined).toContain(messageSubstring);
  }
}

describe('runtime shape matrix', () => {
  test('claude accepts systemPrompt, rejects entrypoint/clankerAgent/toolchains', () => {
    accepts(baseClaude());
    rejects({ ...baseClaude(), entrypoint: 'x' }, "claude runtime forbids 'entrypoint'");
    rejects(
      { ...baseClaude(), clankerAgent: { id: 'a', instructions: 'b' } },
      "claude runtime forbids 'clankerAgent'",
    );
    rejects({ ...baseClaude(), toolchains: { node: '20' } }, "claude runtime forbids 'toolchains'");
  });

  test('claude requires a prompt', () => {
    const { systemPrompt, ...noPrompt } = baseClaude();
    void systemPrompt;
    rejects(noPrompt, 'claude runtime requires a systemPrompt');
  });

  test('claude accepts promptFile as the prompt carrier', () => {
    const { systemPrompt, ...m } = baseClaude();
    void systemPrompt;
    accepts({ ...m, promptFile: './prompt.md' });
  });

  test('codex forbids maxTurns (per design table)', () => {
    const codex = { ...baseClaude(), runtime: 'codex', model: 'gpt-5.5' };
    accepts(codex);
    rejects({ ...codex, maxTurns: 30 }, "codex runtime forbids 'maxTurns'");
  });

  test('clanker requires clankerAgent and forbids prompt/entrypoint', () => {
    const clanker: Record<string, unknown> = {
      id: 'c',
      version: '1.0.0',
      description: 'd',
      runtime: 'clanker',
      needsWorkspace: false,
      roles: ['chat'],
      clankerAgent: { id: 'inner', instructions: 'do stuff', model: 'claude-sonnet-5' },
    };
    accepts(clanker);
    rejects({ ...clanker, clankerAgent: undefined }, 'clanker runtime requires a clankerAgent');
    rejects({ ...clanker, systemPrompt: 'x' }, "clanker runtime forbids 'systemPrompt'");
    rejects({ ...clanker, entrypoint: 'x' }, "clanker runtime forbids 'entrypoint'");
    rejects({ ...clanker, promptFile: './p.md' }, "clanker runtime forbids 'promptFile'");
  });

  test('node requires entrypoint, allows toolchains, forbids prompt/maxTurns/clankerAgent', () => {
    const node: Record<string, unknown> = {
      id: 'n',
      version: '1.0.0',
      description: 'd',
      runtime: 'node',
      needsWorkspace: false,
      roles: ['chat'],
      entrypoint: 'src/main.ts',
      toolchains: { node: '20' },
    };
    accepts(node);
    rejects({ ...node, entrypoint: undefined }, 'node runtime requires an entrypoint');
    rejects({ ...node, systemPrompt: 'x' }, "node runtime forbids 'systemPrompt'");
    rejects({ ...node, maxTurns: 5 }, "node runtime forbids 'maxTurns'");
    rejects(
      { ...node, clankerAgent: { id: 'a', instructions: 'b' } },
      "node runtime forbids 'clankerAgent'",
    );
  });

  test('clanker agent object requires id + instructions', () => {
    const base: Record<string, unknown> = {
      id: 'c',
      version: '1.0.0',
      description: 'd',
      runtime: 'clanker',
      needsWorkspace: false,
      roles: ['chat'],
    };
    rejects({ ...base, clankerAgent: { id: 'inner' } });
    rejects({ ...base, clankerAgent: { instructions: 'x' } });
    accepts({ ...base, clankerAgent: { id: 'inner', instructions: 'x' } });
  });
});

describe('roles enum', () => {
  test('accepts each valid role', () => {
    for (const role of ['reviewer', 'coder', 'fixer', 'chat']) {
      accepts({ ...baseClaude(), roles: [role] });
    }
  });
  test('rejects an unknown role', () => {
    rejects({ ...baseClaude(), roles: ['deployer'] });
  });
  test('rejects an empty roles array', () => {
    rejects({ ...baseClaude(), roles: [] });
  });
  test('rejects a missing roles field', () => {
    const { roles, ...noRoles } = baseClaude();
    void roles;
    rejects(noRoles);
  });
});

describe('workspace + hook coherence', () => {
  test('needsWorkspace=true requires workspaceMode', () => {
    rejects({ ...baseClaude(), needsWorkspace: true }, 'missing workspaceMode');
  });
  test('needsWorkspace=false forbids workspaceMode', () => {
    rejects({ ...baseClaude(), workspaceMode: 'branch' }, 'needsWorkspace=false');
  });
  test('open-pull-request requires branch mode', () => {
    rejects(
      {
        ...baseClaude(),
        needsWorkspace: true,
        workspaceMode: 'pr-head',
        roles: ['reviewer'],
        hooks: [{ event: 'after-agent', kind: 'open-pull-request' }],
      },
      "workspaceMode is not 'branch'",
    );
  });
  test('post-pr-review requires pr-head mode', () => {
    rejects(
      {
        ...baseClaude(),
        needsWorkspace: true,
        workspaceMode: 'branch',
        roles: ['reviewer'],
        hooks: [{ event: 'after-agent', kind: 'post-pr-review' }],
      },
      "workspaceMode is not 'pr-head'",
    );
  });
  test('hook (event,kind) mismatch is rejected', () => {
    rejects({
      ...baseClaude(),
      needsWorkspace: true,
      workspaceMode: 'branch',
      roles: ['coder'],
      // setup-workspace is a before-agent hook; binding to after-agent is invalid.
      hooks: [{ event: 'after-agent', kind: 'setup-workspace' }],
    });
  });
  test('a valid reviewer definition is accepted', () => {
    accepts({
      id: 'pr-reviewer',
      version: '1.3.0',
      description: 'reviews',
      runtime: 'claude',
      needsWorkspace: true,
      workspaceMode: 'pr-head',
      roles: ['reviewer'],
      systemPrompt: 'review the diff',
      hooks: [
        { event: 'before-agent', kind: 'setup-workspace' },
        { event: 'after-agent', kind: 'post-pr-review' },
        { event: 'on-operator-message', kind: 'steer-receive' },
        { event: 'on-turn-completed', kind: 'steer-continuation' },
      ],
    });
  });
});

describe('semver + strictness', () => {
  test('accepts strict semver incl. prerelease', () => {
    accepts({ ...baseClaude(), version: '1.4.0' });
    accepts({ ...baseClaude(), version: '2.0.0-rc.1' });
    accepts({ ...baseClaude(), version: '1.0.0+build.5' });
  });
  test('rejects non-semver versions', () => {
    rejects({ ...baseClaude(), version: '1.4' }, 'strict semver');
    rejects({ ...baseClaude(), version: 'v1.4.0' }, 'strict semver');
    rejects({ ...baseClaude(), version: 'latest' }, 'strict semver');
  });
  test('rejects unknown top-level keys (strict)', () => {
    rejects({ ...baseClaude(), surprise: true });
  });
  test('accepts model:null (explicit CLI default)', () => {
    accepts({ ...baseClaude(), model: null });
  });
  test('rejects empty model string', () => {
    rejects({ ...baseClaude(), model: '' });
  });
});

describe('parseManifest error surface', () => {
  test('throws a typed ManifestValidationError with issues', () => {
    let caught: unknown;
    try {
      parseManifest('/pkg/x', { id: 'x' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ManifestValidationError);
    const err = caught as ManifestValidationError;
    expect(err.dir).toBe('/pkg/x');
    expect(err.issues.length).toBeGreaterThan(0);
    expect(err.message).toContain('/pkg/x');
  });
});

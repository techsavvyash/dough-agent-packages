// The agent-package manifest schema.
//
// This mirrors the dough-gateway registry's `AgentDefinition` wire format
// (post gateway PR #24 — npm metadata + content-addressed bundles) extended
// per docs/design/agent-packages.md with the four-value runtime enum and the
// two authoring conveniences (`promptFile` / `readmeFile`).
//
// An agent package is PURE CAPABILITY (runtime, workspace, hooks, entrypoint,
// toolchains, modalities, metadata). What a repo an agent to review/code/fix is
// a per-repo BINDING on the gateway side — it is NOT a manifest field. There is
// deliberately no `roles` classification here.
//
// The GATEWAY stays authoritative: `dough agent publish` calls
// `POST /v1/agents/validate` for the server's real verdict. This local schema
// is a fast pre-flight that catches the obvious mistakes (bad runtime shape,
// a promptFile that resolves to an empty prompt) before a network round-trip —
// and lets `validate` run offline in CI.

import { z } from 'zod';

// ── Enums (kept as `as const` value objects + a derived z.enum so the string
//    literals are usable both as types and at runtime, matching the gateway
//    domain style). ────────────────────────────────────────────────────────

/** Which in-VM runtime an agent invokes. Extends the gateway's claude/codex
 *  pair with clanker (embedded clanker runtime) and node (arbitrary program
 *  bundle) per the agent-packages design. */
export const AgentRuntime = {
  Claude: 'claude',
  Codex: 'codex',
  Clanker: 'clanker',
  Node: 'node',
} as const;
export type AgentRuntime = (typeof AgentRuntime)[keyof typeof AgentRuntime];
export const agentRuntimeSchema = z.enum([
  AgentRuntime.Claude,
  AgentRuntime.Codex,
  AgentRuntime.Clanker,
  AgentRuntime.Node,
]);

/** How the worker prepares the git workspace (workspace-using agents only). */
export const AgentWorkspaceMode = {
  Branch: 'branch',
  PrHead: 'pr-head',
} as const;
export type AgentWorkspaceMode =
  (typeof AgentWorkspaceMode)[keyof typeof AgentWorkspaceMode];
export const agentWorkspaceModeSchema = z.enum([
  AgentWorkspaceMode.Branch,
  AgentWorkspaceMode.PrHead,
]);

/** Declared input modalities an agent accepts (mirrors the gateway's
 *  AgentModality). Absent = text-only; `image` marks a multimodal agent that
 *  consumes task attachments (e.g. a screenshot of a problem statement). */
export const AgentModality = {
  Text: 'text',
  Image: 'image',
} as const;
export type AgentModality = (typeof AgentModality)[keyof typeof AgentModality];
export const agentModalitySchema = z.enum([
  AgentModality.Text,
  AgentModality.Image,
]);

// ── Hook validation (mirrors dough-gateway worker-protocol) ─────────────────

export const hookEventSchema = z.enum([
  'before-agent',
  'after-agent',
  'on-handoff',
  'on-failure',
  'on-operator-message',
  'on-turn-completed',
]);
export type HookEvent = z.infer<typeof hookEventSchema>;

export const hookKindSchema = z.enum([
  'setup-workspace',
  'provision-from-config',
  'open-pull-request',
  'post-pr-review',
  'steer-receive',
  'steer-continuation',
]);
export type HookKind = z.infer<typeof hookKindSchema>;

/** Which events each HookKind may bind to — the local mirror of the gateway's
 *  HOOK_KIND_VALID_EVENTS. The gateway re-validates; this catches obvious
 *  (event, kind) drift at authoring time. */
export const HOOK_KIND_VALID_EVENTS: Record<HookKind, readonly HookEvent[]> = {
  'setup-workspace': ['before-agent'],
  'provision-from-config': ['before-agent'],
  'open-pull-request': ['after-agent'],
  'post-pr-review': ['after-agent'],
  'steer-receive': ['on-operator-message'],
  'steer-continuation': ['on-turn-completed'],
};

export const agentHookSchema = z
  .object({
    event: hookEventSchema,
    kind: hookKindSchema,
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((v, ctx) => {
    const allowed = HOOK_KIND_VALID_EVENTS[v.kind];
    if (!allowed.includes(v.event)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `hook kind '${v.kind}' is not valid for event '${v.event}' (allowed events: ${allowed.join(', ')})`,
        path: ['kind'],
      });
    }
  });
export type AgentHook = z.infer<typeof agentHookSchema>;

// ── npm-style metadata (mirrors gateway PR #24) ─────────────────────────────

// A person (author / maintainer) in npm's loose shape — a faithful mirror of
// the gateway's `agentPersonSchema`. `name` required; `email`/`url`/`github`
// are optional free-form handles (the gateway keeps them permissive: plain
// `z.string().min(1)`, NOT `.email()`/`.url()`). We match that permissiveness
// deliberately: a stricter local schema would reject a manifest the server
// accepts, turning a valid publish into a spurious local pre-flight failure.
export const agentPersonSchema = z.object({
  name: z.string().min(1),
  email: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  github: z.string().min(1).optional(),
});
export type AgentPerson = z.infer<typeof agentPersonSchema>;

// `author` and `maintainers[]` share the person shape (gateway parity — the
// gateway uses `agentPersonSchema` for both).
export const agentAuthorSchema = agentPersonSchema;
export type AgentAuthor = AgentPerson;
export const agentMaintainerSchema = agentPersonSchema;
export type AgentMaintainer = AgentPerson;

// Source repository — mirrors the gateway's `agentRepositorySchema`: `repo`
// (owner/name) plus optional `path` and `directory`. NOTE the gateway has no
// `ref` field; a client-only `ref` would be stripped server-side (unknown key)
// and must not be injected, so it is intentionally absent here.
export const agentSourceSchema = z.object({
  repo: z.string().min(1) /* "owner/name" */,
  path: z.string().min(1).optional(),
  directory: z.string().min(1).optional(),
});
export type AgentSource = z.infer<typeof agentSourceSchema>;

// ── Clanker agent shape (runtime: "clanker") ────────────────────────────────
//
// The design ships the author's clanker AgentDefinition through verbatim (no
// dough→clanker conversion). We don't re-implement clanker's full schema here
// — that lives in @techsavvyash/clanker and the gateway is authoritative — but
// we require the load-bearing fields so a malformed inline definition fails
// locally instead of at the worker. Unknown keys pass through (passthrough).
export const clankerAgentSchema = z
  .object({
    id: z.string().min(1),
    instructions: z.string().min(1),
    model: z.string().min(1).optional(),
  })
  .passthrough();
export type ClankerAgent = z.infer<typeof clankerAgentSchema>;

// ── Toolchains map (runtime: "node") — same vocabulary as .dough/config.yaml
//    (a map of toolchain name → version string). ──────────────────────────
export const toolchainsSchema = z.record(z.string().min(1), z.string().min(1));
export type Toolchains = z.infer<typeof toolchainsSchema>;

// ── The manifest (agent.json on disk) ───────────────────────────────────────
//
// Authoring form: carries `promptFile`/`readmeFile` (resolved away at publish)
// and does NOT carry `systemPrompt`/`readme` inline (those are the resolved
// output). The per-runtime superRefine below enforces the design's shape table.

/** Strict semver — registry agents and app templates are versioned alike. */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
export const SEMVER_MESSAGE = 'version must be strict semver (e.g. 1.4.0 or 1.4.0-rc.1)';

export const agentManifestSchema = z
  .object({
    id: z.string().min(1),
    /** Strict semver — the registry resolves `latest` by max semver (design §3). */
    version: z.string().regex(SEMVER_PATTERN, SEMVER_MESSAGE),
    description: z.string().min(1),

    runtime: agentRuntimeSchema.default(AgentRuntime.Claude),
    model: z.string().min(1).nullable().optional(),
    maxTurns: z.number().int().positive().optional(),
    needsWorkspace: z.boolean(),
    workspaceMode: agentWorkspaceModeSchema.optional(),
    hooks: z.array(agentHookSchema).default([]),

    // Declared input modalities (text-only when absent). Mirrors the gateway
    // schema; participates in the manifest digest (see PARSED_MANIFEST_KEYS).
    modalities: z.array(agentModalitySchema).nonempty().optional(),

    // npm metadata
    keywords: z.array(z.string().min(1)).optional(),
    author: agentAuthorSchema.optional(),
    maintainers: z.array(agentMaintainerSchema).optional(),
    license: z.string().min(1).optional(),
    // Gateway keeps homepage permissive (plain non-empty string, not `.url()`).
    homepage: z.string().min(1).optional(),
    repository: agentSourceSchema.optional(),
    // Gateway shape: `false`/absent = live; a string = the deprecation message.
    deprecated: z.union([z.string().min(1), z.boolean()]).optional(),

    // authoring conveniences (resolved + stripped at publish)
    promptFile: z.string().min(1).optional(),
    readmeFile: z.string().min(1).optional(),

    // resolved fields — normally absent in authoring form, but allowed so a
    // resolved manifest also validates (publish resolves promptFile→systemPrompt
    // then re-validates the outgoing wire object against this same schema).
    systemPrompt: z.string().min(1).optional(),
    readme: z.string().min(1).optional(),

    // runtime-specific
    clankerAgent: clankerAgentSchema.optional(),
    entrypoint: z.string().min(1).optional(),
    toolchains: toolchainsSchema.optional(),
  })
  .strict()
  .superRefine((def, ctx) => {
    // ── workspace coherence (mirrors gateway) ──
    if (def.needsWorkspace && !def.workspaceMode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `agent "${def.id}" sets needsWorkspace=true but is missing workspaceMode`,
        path: ['workspaceMode'],
      });
    }
    if (!def.needsWorkspace && def.workspaceMode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `agent "${def.id}" sets workspaceMode but needsWorkspace=false`,
        path: ['workspaceMode'],
      });
    }

    // ── hook ↔ workspace coherence (mirrors gateway) ──
    for (const hook of def.hooks) {
      if (hook.kind === 'open-pull-request' && def.workspaceMode !== 'branch') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `agent "${def.id}" binds hook 'open-pull-request' but workspaceMode is not 'branch'`,
          path: ['hooks'],
        });
      }
      if (hook.kind === 'post-pr-review' && def.workspaceMode !== 'pr-head') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `agent "${def.id}" binds hook 'post-pr-review' but workspaceMode is not 'pr-head'`,
          path: ['hooks'],
        });
      }
      if (hook.kind === 'setup-workspace' && !def.needsWorkspace) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `agent "${def.id}" binds hook 'setup-workspace' but needsWorkspace=false`,
          path: ['hooks'],
        });
      }
    }

    // ── per-runtime shape table (design §1) ──
    const hasPrompt = def.systemPrompt != null || def.promptFile != null;
    switch (def.runtime) {
      case AgentRuntime.Claude: {
        if (!hasPrompt) {
          issue(ctx, ['promptFile'], `claude runtime requires a systemPrompt (via promptFile)`);
        }
        forbid(ctx, def, 'entrypoint', 'claude');
        forbid(ctx, def, 'clankerAgent', 'claude');
        forbid(ctx, def, 'toolchains', 'claude');
        break;
      }
      case AgentRuntime.Codex: {
        if (!hasPrompt) {
          issue(ctx, ['promptFile'], `codex runtime requires a systemPrompt (via promptFile)`);
        }
        if (def.model == null) {
          issue(ctx, ['model'], 'codex runtime requires an explicit model; no CLI fallback is allowed');
        }
        forbid(ctx, def, 'maxTurns', 'codex');
        forbid(ctx, def, 'entrypoint', 'codex');
        forbid(ctx, def, 'clankerAgent', 'codex');
        forbid(ctx, def, 'toolchains', 'codex');
        break;
      }
      case AgentRuntime.Clanker: {
        if (def.clankerAgent == null) {
          issue(ctx, ['clankerAgent'], `clanker runtime requires a clankerAgent object`);
        }
        forbidPrompt(ctx, def, 'clanker');
        forbid(ctx, def, 'entrypoint', 'clanker');
        break;
      }
      case AgentRuntime.Node: {
        if (def.entrypoint == null) {
          issue(ctx, ['entrypoint'], `node runtime requires an entrypoint (bundle-relative path)`);
        }
        forbidPrompt(ctx, def, 'node');
        forbid(ctx, def, 'maxTurns', 'node');
        forbid(ctx, def, 'clankerAgent', 'node');
        break;
      }
    }
  });

export type AgentManifest = z.infer<typeof agentManifestSchema>;

// ── superRefine helpers ─────────────────────────────────────────────────────

function issue(
  ctx: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
}

/** A runtime forbids a field when it's present. `promptFile`/`systemPrompt`
 *  are handled by forbidPrompt (they're a pair). */
function forbid(
  ctx: z.RefinementCtx,
  def: AgentManifest,
  key: 'entrypoint' | 'clankerAgent' | 'toolchains' | 'maxTurns',
  runtime: string,
): void {
  if (def[key] != null) {
    issue(ctx, [key], `${runtime} runtime forbids '${key}'`);
  }
}

/** Both prompt carriers are forbidden together for clanker/node. */
function forbidPrompt(ctx: z.RefinementCtx, def: AgentManifest, runtime: string): void {
  if (def.systemPrompt != null) {
    issue(ctx, ['systemPrompt'], `${runtime} runtime forbids 'systemPrompt'`);
  }
  if (def.promptFile != null) {
    issue(ctx, ['promptFile'], `${runtime} runtime forbids 'promptFile'`);
  }
}

// ── Typed errors ────────────────────────────────────────────────────────────

/** A local manifest validation failure — carries the flattened zod issues. */
export class ManifestValidationError extends Error {
  override readonly name = 'ManifestValidationError';
  constructor(
    readonly dir: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(
      `manifest at ${dir} is invalid:\n` +
        issues
          .map((i) => `  - ${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`)
          .join('\n'),
    );
  }
}

/**
 * Parse + validate a raw manifest object (already read from disk / merged with
 * resolved file contents). Throws ManifestValidationError with all issues.
 */
export function parseManifest(dir: string, raw: unknown): AgentManifest {
  const result = agentManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new ManifestValidationError(dir, result.error.issues);
  }
  return result.data;
}

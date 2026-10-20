// App agent templates — `agents/<id>/` directories whose agent.json has
// `kind: "app"`.
//
// A template is the SKELETON of an always-on agent app: its sub-agents and
// their instruction files, the tool ceiling its deployments must stay within,
// a default model and the persona/notes/assistant name/`/connect` apps a new
// deployment starts from. Templates are operator-published to the gateway
// (`PUT /v1/agent-templates/:id/:version`) and are immutable per id@version.
// A DEPLOYMENT (one app's persona, notes, model, permissions, triggers) pins
// an exact template version and is edited in the dashboard, never from here.
//
// A template directory holds:
//
//   agent.json   the manifest (strict — unknown keys are rejected)
//   *.md         files agent.json references (`subAgents[].instructions`,
//                `seed.persona`, `seed.notes`), sent verbatim
//   README.md    the catalog page — documentation only, never published
//
// This module is the offline mirror of the gateway's template validation and
// digest (dough-gateway src/domain/agent-template.ts), so `validate` catches
// mistakes before CI and `publish` can verify the server stored exactly what
// was sent.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

import { canonicalJson } from './digest.ts';

/** The `kind` of an app template; registry agents have no kind or `"task"`. */
export const PackageKind = {
  Task: 'task',
  App: 'app',
} as const;
export type PackageKind = (typeof PackageKind)[keyof typeof PackageKind];

export const DESCRIPTION_MAX_CHARS = 500;
export const ASSISTANT_NAME_MAX_CHARS = 64;
export const SUB_AGENT_NAME_MAX_CHARS = 64;
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}\.md$/;
export const FILE_MAX_BYTES = 64 * 1024;
export const FILES_TOTAL_MAX_BYTES = 256 * 1024;
export const MAX_FILES = 16;
export const MAX_SUB_AGENTS = 16;
export const MAX_CONNECT_APPS = 20;

/**
 * The host's built-in task executor, used when no sub-agent is the default:
 * a sub-agent may only take this id by replacing it (`default: true`).
 */
export const BUILT_IN_WORKER_ID = 'worker';
/** The editor hint for a template's agent.json (served publicly by the gateway). */
export const AGENT_TEMPLATE_SCHEMA_URL = 'https://api.try-dough.com/v1/agent-template/schema';
/**
 * Strict semver WITHOUT build metadata: `1.0.0+a` and `1.0.0+b` would be
 * different versions with the same precedence, so the gateway refuses `+`.
 */
export const TEMPLATE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;
/** The only file name reserved to one reference: the seed persona's. */
export const PERSONA_FILE = 'persona.md';
const MANIFEST_FILE = 'agent.json';
/** Present in a template directory for humans; never part of the template. */
const DOC_FILES = new Set(['README.md']);

// ── Namespaces ────────────────────────────────────────────────────────
//
// Platform templates have bare ids (`assistant`) and are published with the
// operator token. Team templates are `@<team-slug>/<name>` and are published
// with a team template publish token (`tpt_…`) scoped to that team; neither
// token can publish into the other's namespace.

/** A team's slug, as the gateway validates it (dough-gateway src/domain/team.ts). */
export const TEAM_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export const TemplateNamespace = {
  Platform: 'platform',
  Team: 'team',
} as const;
export type TemplateNamespace = (typeof TemplateNamespace)[keyof typeof TemplateNamespace];

/** A parsed template id. */
export type TemplateRef =
  | { namespace: typeof TemplateNamespace.Platform; name: string }
  | { namespace: typeof TemplateNamespace.Team; scope: string; name: string };

const TEMPLATE_ID_MESSAGE =
  'must be a template name (lowercase letters, digits and "-") or "@<team-slug>/<name>"';

/** Parses `name` or `@scope/name`; undefined when it is neither. */
export function parseTemplateId(id: string): TemplateRef | undefined {
  if (!id.startsWith('@')) {
    return SLUG_PATTERN.test(id) ? { namespace: TemplateNamespace.Platform, name: id } : undefined;
  }
  const slash = id.indexOf('/');
  if (slash < 0) return undefined;
  const scope = id.slice(1, slash);
  const name = id.slice(slash + 1);
  if (!TEAM_SLUG_PATTERN.test(scope) || !SLUG_PATTERN.test(name)) return undefined;
  return { namespace: TemplateNamespace.Team, scope, name };
}

/** Like {@link parseTemplateId}, for ids already validated by the schema. */
export function templateRef(id: string): TemplateRef {
  const ref = parseTemplateId(id);
  if (ref === undefined) throw new Error(`template id "${id}" ${TEMPLATE_ID_MESSAGE}`);
  return ref;
}

/**
 * `<gateway>/v1/agent-templates/<name>/<version>` (platform) or
 * `<gateway>/v1/agent-templates/@<scope>/<name>/<version>` (team): the `@` and
 * the `/` between scope and name are path structure, every segment is encoded.
 */
export function templateVersionUrl(gatewayUrl: string, id: string, version: string): string {
  const ref = templateRef(id);
  const base = `${gatewayUrl.replace(/\/+$/, '')}/v1/agent-templates`;
  const path =
    ref.namespace === TemplateNamespace.Team
      ? `@${encodeURIComponent(ref.scope)}/${encodeURIComponent(ref.name)}`
      : encodeURIComponent(ref.name);
  return `${base}/${path}/${encodeURIComponent(version)}`;
}

/** The operator token for platform templates, a team token for `@scope/` ones. */
export const TEMPLATE_TOKEN_ENV = 'DOUGH_TEMPLATE_TOKEN';
export const OPERATOR_TOKEN_ENV = 'AGENT_REGISTRY_PUBLISH_TOKEN';
/** Team template publish tokens, minted by a team admin in the dashboard. */
export const TEAM_TOKEN_PREFIX = 'tpt_';

export class TemplateTokenError extends Error {
  override readonly name = 'TemplateTokenError';
}

/**
 * The token that may publish `id`: {@link TEMPLATE_TOKEN_ENV} for a team
 * template, {@link OPERATOR_TOKEN_ENV} for a platform one. A missing token, or
 * a team token where the operator token belongs (and vice versa), is an error
 * naming the variable to set — the gateway would refuse it anyway.
 */
export function selectTemplateToken(
  id: string,
  env: { templateToken?: string | undefined; publishToken?: string | undefined },
): string {
  const ref = templateRef(id);
  const templateToken = env.templateToken?.trim() || undefined;
  const publishToken = env.publishToken?.trim() || undefined;
  if (ref.namespace === TemplateNamespace.Team) {
    if (templateToken === undefined) {
      throw new TemplateTokenError(
        `${id} is a team template: set ${TEMPLATE_TOKEN_ENV} to a template publish token (${TEAM_TOKEN_PREFIX}…) of team "${ref.scope}", minted by a team admin on the team's Templates page`,
      );
    }
    if (!templateToken.startsWith(TEAM_TOKEN_PREFIX)) {
      throw new TemplateTokenError(
        `${TEMPLATE_TOKEN_ENV} is not a template publish token (expected ${TEAM_TOKEN_PREFIX}…)`,
      );
    }
    return templateToken;
  }
  if (publishToken === undefined) {
    throw new TemplateTokenError(
      `${id} is a platform template: set ${OPERATOR_TOKEN_ENV} (the operator token; only the dough operators publish bare ids — team templates are "@<team-slug>/${ref.name}")`,
    );
  }
  if (publishToken.startsWith(TEAM_TOKEN_PREFIX)) {
    throw new TemplateTokenError(
      `${OPERATOR_TOKEN_ENV} holds a team template token (${TEAM_TOKEN_PREFIX}…), which can never publish platform template ${id}`,
    );
  }
  return publishToken;
}

const fileRef = z
  .string()
  .regex(FILE_NAME_PATTERN, 'must be a file name like "notes.md" (lowercase, ending in .md)');
const slug = z.string().regex(SLUG_PATTERN, 'must be lowercase letters, digits and "-"');

/** The ceiling: `false` = deployments of this template can never enable it. Default true. */
const toolsSchema = z
  .object({
    memory: z.boolean().optional(),
    tasks: z.boolean().optional(),
    agents: z.boolean().optional(),
    events: z.boolean().optional(),
    connections: z.boolean().optional(),
    webSearch: z.boolean().optional(),
  })
  .strict();

const subAgentSchema = z
  .object({
    id: slug,
    name: z.string().min(1).max(SUB_AGENT_NAME_MAX_CHARS),
    description: z.string().min(1).max(DESCRIPTION_MAX_CHARS),
    instructions: fileRef,
    tools: z
      .object({
        memory: z.boolean().optional(),
        connections: z.boolean().optional(),
        webSearch: z.boolean().optional(),
      })
      .strict()
      .optional(),
    default: z.boolean().optional(),
  })
  .strict();

/** Copied into a NEW deployment of the template; the deployment owns it after that. */
const seedSchema = z
  .object({
    persona: fileRef,
    notes: fileRef.optional(),
    assistantName: z.string().trim().min(1).max(ASSISTANT_NAME_MAX_CHARS).optional(),
    connectApps: z.array(slug).max(MAX_CONNECT_APPS).optional(),
  })
  .strict();

function refineTemplate(t: z.infer<typeof templateObjectSchema>, ctx: z.RefinementCtx): void {
  const add = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  const tasksOff = t.tools?.tasks === false;
  const subAgents = t.subAgents ?? [];
  if (tasksOff && t.tools?.agents === true) add(['tools', 'agents'], 'requires tools.tasks (it is false)');
  if (tasksOff && t.approvals === true) add(['approvals'], 'requires tools.tasks (it is false)');
  if (tasksOff && subAgents.length > 0) add(['subAgents'], 'requires tools.tasks (it is false)');
  if (t.tools?.connections === false && (t.seed?.connectApps?.length ?? 0) > 0) {
    add(['seed', 'connectApps'], 'requires tools.connections (it is false)');
  }

  const seen = new Map<string, number>();
  subAgents.forEach((sub, i) => {
    if (sub.id === BUILT_IN_WORKER_ID && sub.default !== true) {
      add(
        ['subAgents', i, 'id'],
        `"${BUILT_IN_WORKER_ID}" is reserved for the default worker; mark it default or rename it`,
      );
    }
    const first = seen.get(sub.id);
    if (first !== undefined) {
      add(['subAgents', i, 'id'], `duplicate sub-agent id "${sub.id}" (also subAgents[${first}])`);
    } else {
      seen.set(sub.id, i);
    }
  });
  const defaults = subAgents.flatMap((sub, i) => (sub.default === true ? [i] : []));
  if (defaults.length > 1) {
    add(['subAgents'], `at most one sub-agent may be the default (subAgents ${defaults.join(', ')} are)`);
  }
}

const templateObjectSchema = z
  .object({
    $schema: z.string().url().optional(),
    kind: z.literal(PackageKind.App),
    /** `name` (platform) or `@<team-slug>/<name>` (team). */
    id: z.string().refine((id) => parseTemplateId(id) !== undefined, TEMPLATE_ID_MESSAGE),
    version: z
      .string()
      .regex(TEMPLATE_VERSION_PATTERN, 'version must be strict semver without build metadata (e.g. 1.4.0 or 1.4.0-rc.1)'),
    description: z.string().trim().min(1).max(DESCRIPTION_MAX_CHARS),
    /** Mutable metadata: hides the version from new deployments; not part of the digest. */
    deprecated: z.boolean().optional(),
    /** The default model of new deployments. */
    model: z.string().regex(MODEL_PATTERN, 'must be a model id').optional(),
    tools: toolsSchema.optional(),
    /** Ceiling for the needs-approval gate; default = tools.tasks. */
    approvals: z.boolean().optional(),
    subAgents: z.array(subAgentSchema).max(MAX_SUB_AGENTS).optional(),
    seed: seedSchema.optional(),
  })
  .strict();

/** agent.json of an app template, with every cross-field rule. */
export const agentTemplateJsonSchema = templateObjectSchema.superRefine(refineTemplate);

export type AgentTemplateJson = z.infer<typeof agentTemplateJsonSchema>;
/** agent.json as published and stored: `$schema` dropped (the digest also drops `deprecated`). */
export type AgentTemplate = Omit<AgentTemplateJson, '$schema'>;

/** What `PUT /v1/agent-templates/:id/:version` takes. */
export interface AgentTemplateBody {
  template: AgentTemplate;
  files: Record<string, string>;
}

export class AgentTemplateError extends Error {
  override readonly name = 'AgentTemplateError';
  readonly issues: string[];
  constructor(dir: string, issues: string[]) {
    super(`${dir}: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Every file the template names, with the agent.json path that names it. */
export function templateFileReferences(
  template: Pick<AgentTemplate, 'subAgents' | 'seed'>,
): Array<{ file: string; path: string }> {
  const refs: Array<{ file: string; path: string }> = [];
  (template.subAgents ?? []).forEach((sub, i) => {
    refs.push({ file: sub.instructions, path: `subAgents.${i}.instructions` });
  });
  if (template.seed !== undefined) {
    refs.push({ file: template.seed.persona, path: 'seed.persona' });
    if (template.seed.notes !== undefined) refs.push({ file: template.seed.notes, path: 'seed.notes' });
  }
  return refs;
}

/**
 * The rules between the template and its files — names, count, sizes (UTF-8
 * bytes), and that the files agent.json names are exactly the files there are:
 * a dangling reference would fail at the host, an orphan is dead weight.
 */
export function validateTemplateFiles(body: AgentTemplateBody): string[] {
  const issues: string[] = [];
  const { files } = body;
  const names = Object.keys(files);
  if (names.length > MAX_FILES) issues.push(`at most ${MAX_FILES} files (got ${names.length})`);
  let total = 0;
  for (const name of names) {
    const size = bytes(files[name] ?? '');
    total += size;
    if (!FILE_NAME_PATTERN.test(name)) issues.push(`file "${name}": invalid name`);
    if (size < 1) issues.push(`file "${name}" is empty`);
    if (size > FILE_MAX_BYTES) issues.push(`file "${name}" exceeds ${FILE_MAX_BYTES} bytes`);
  }
  if (total > FILES_TOTAL_MAX_BYTES) {
    issues.push(`files exceed ${FILES_TOTAL_MAX_BYTES} bytes in total (got ${total})`);
  }

  const refs = templateFileReferences(body.template);
  for (const ref of refs) {
    if (ref.file === PERSONA_FILE && ref.path !== 'seed.persona') {
      issues.push(`${ref.path} references "${PERSONA_FILE}", which only seed.persona may name`);
    }
    if (!Object.hasOwn(files, ref.file)) {
      issues.push(`${ref.path} references "${ref.file}", which is not in the template`);
    }
  }
  const referenced = new Set(refs.map((r) => r.file));
  for (const name of names) {
    if (!referenced.has(name)) issues.push(`file "${name}" is not referenced by agent.json`);
  }
  return issues;
}

/**
 * The kind of a raw agent.json: `"app"` = a template, `"task"` or absent = a
 * registry agent. Anything else is an error rather than a guess.
 */
export function packageKind(raw: Record<string, unknown>): PackageKind {
  const kind = raw.kind;
  if (kind === undefined || kind === PackageKind.Task) return PackageKind.Task;
  if (kind === PackageKind.App) return PackageKind.App;
  throw new Error(`agent.json "kind" must be "${PackageKind.Task}" or "${PackageKind.App}", got ${JSON.stringify(kind)}`);
}

/** Reads a template directory into a publish body. Throws AgentTemplateError on any problem. */
export function loadTemplate(dir: string): AgentTemplateBody {
  const manifestPath = join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) throw new AgentTemplateError(dir, [`missing ${MANIFEST_FILE}`]);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new AgentTemplateError(dir, [`${MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`]);
  }
  const parsed = agentTemplateJsonSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentTemplateError(
      dir,
      parsed.error.issues.map((i) => `agent.json ${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const { $schema: _schema, ...template } = parsed.data;

  const issues: string[] = [];
  const dirName = basename(dir.replace(/\/+$/, ''));
  const { name } = templateRef(template.id);
  if (dirName !== name) {
    issues.push(`directory name "${dirName}" must equal the template name "${name}" (of id "${template.id}")`);
  }

  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir).sort()) {
    if (entry === MANIFEST_FILE || DOC_FILES.has(entry)) continue;
    const path = join(dir, entry);
    if (!statSync(path).isFile()) {
      issues.push(`unexpected directory "${entry}"`);
      continue;
    }
    if (!entry.endsWith('.md')) {
      issues.push(`unexpected file "${entry}" (only .md files are part of a template)`);
      continue;
    }
    files[entry] = readFileSync(path, 'utf8');
  }

  const body: AgentTemplateBody = { template, files };
  issues.push(...validateTemplateFiles(body));
  if (issues.length > 0) throw new AgentTemplateError(dir, issues);
  return body;
}

/**
 * The gateway's template digest (agentTemplateDigest): sha256 over the
 * canonical JSON (keys sorted at every level, the same canonicalization as
 * registry manifests and app packages) of `{files, template}`, with `$schema`
 * and the mutable `deprecated` removed, `id` reduced to the bare name (no
 * `@scope/`) and no defaults materialized. Key order
 * never changes it, so republishing the same content is recognised as
 * identical, and deprecating a version does not fork its identity.
 */
export function templateDigest(body: AgentTemplateBody): string {
  const { $schema: _schema, deprecated: _deprecated, ...rest } = body.template as AgentTemplateJson;
  // The scope is not content: a team template hashes under its bare name, so
  // renaming the team (its slug) never changes a published version's digest.
  const template = { ...rest, id: parseTemplateId(rest.id)?.name ?? rest.id };
  const json = canonicalJson({ files: body.files, template });
  return `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`;
}

/** What `PUT /v1/agent-templates/:id/:version` reports in `outcome`. */
export const TemplatePublishOutcomeKind = {
  /** 201: a new id@version. */
  Created: 'created',
  /** 200: id@version already holds identical content. */
  Unchanged: 'unchanged',
  /** 200: identical content; only its `deprecated` flag changed. */
  DeprecationUpdated: 'deprecation-updated',
} as const;
export type TemplatePublishOutcomeKind =
  (typeof TemplatePublishOutcomeKind)[keyof typeof TemplatePublishOutcomeKind];

export type TemplatePublishOutcome = {
  outcome: TemplatePublishOutcomeKind;
  id: string;
  version: string;
  digest: string;
};

export class TemplatePublishError extends Error {
  override readonly name = 'TemplatePublishError';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The outcomes each success status may carry. */
const OUTCOMES_BY_STATUS: Record<number, readonly TemplatePublishOutcomeKind[]> = {
  201: [TemplatePublishOutcomeKind.Created],
  200: [TemplatePublishOutcomeKind.Unchanged, TemplatePublishOutcomeKind.DeprecationUpdated],
};

/**
 * `PUT /v1/agent-templates/:id/:version` with the operator publish token and
 * `{template, files}`. 201 `created`; 200 `unchanged` or `deprecation-updated`
 * (same content, only `deprecated` flipped); 409 = id@version holds different
 * content (templates are immutable — bump the version); 400 = invalid. The
 * response is `{outcome, template: {digest, …}}`, and `template.digest` must
 * equal the local digest — a mismatch means the server normalized the
 * template differently and is reported as an error.
 */
export async function publishTemplate(opts: {
  gatewayUrl: string;
  token: string;
  body: AgentTemplateBody;
  /** The template's directory, named in errors; default `agents/<name>`. */
  dir?: string;
  fetchImpl?: typeof fetch;
}): Promise<TemplatePublishOutcome> {
  const { id, version } = opts.body.template;
  const ref = `${id}@${version}`;
  const url = templateVersionUrl(opts.gatewayUrl, id, version);
  const dir = (opts.dir ?? `agents/${templateRef(id).name}`).replace(/\/+$/, '');
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(opts.body),
    });
  } catch (err) {
    throw new TemplatePublishError(`publishing template ${ref}: request failed: ${(err as Error).message}`, 0);
  }
  const payload = (await res.json().catch(() => ({}))) as {
    outcome?: unknown;
    template?: { digest?: unknown } | null;
    message?: unknown;
    error?: unknown;
  };
  const expected = templateDigest(opts.body);

  if (res.status === 409) {
    throw new TemplatePublishError(
      `template ${ref} is already published with different content (local ${expected})` +
        ` — templates are immutable: bump "version" in ${dir}/agent.json`,
      409,
    );
  }
  const allowed = OUTCOMES_BY_STATUS[res.status];
  if (allowed === undefined) {
    // Nest errors: {statusCode, message: string | string[], error}.
    const message = Array.isArray(payload.message) ? payload.message.join('; ') : payload.message;
    const detail = [message, payload.error].find((v) => typeof v === 'string') ?? `HTTP ${res.status}`;
    throw new TemplatePublishError(
      `publishing template ${ref} failed (HTTP ${res.status}): ${String(detail)}`,
      res.status,
    );
  }
  const outcome = payload.outcome as TemplatePublishOutcomeKind;
  if (!allowed.includes(outcome)) {
    throw new TemplatePublishError(
      `publishing template ${ref}: unexpected outcome ${JSON.stringify(payload.outcome)} for HTTP ${res.status}`,
      res.status,
    );
  }
  const digest = payload.template?.digest;
  if (typeof digest !== 'string') {
    throw new TemplatePublishError(`publishing template ${ref}: response carries no template.digest`, res.status);
  }
  if (digest !== expected) {
    throw new TemplatePublishError(
      `publishing template ${ref}: server digest ${digest} does not match the local ${expected}`,
      res.status,
    );
  }
  return { outcome, id, version, digest };
}

// App agent packages — the format a dough APP's agent is published in
// (dough-gateway docs/agent-package-format.md). Unlike the registry packages
// under agents/ (one-shot agents run in a fresh VM per task), an app package
// configures an always-on agent app running the platform's managed agent
// host: publishing it creates a new immutable version on the app, and the
// running host hot-reloads it within seconds — no build, no redeploy.
//
// A package directory holds:
//
//   agent.json   the manifest (strict — unknown keys are rejected)
//   persona.md   the entry agent's system prompt
//   *.md         extra files, each referenced by agent.json (`notes`,
//                `subAgents[].instructions`)
//   README.md    optional, documentation only — never published
//
// This module is the offline mirror of the gateway's validation and digest,
// so `validate` catches mistakes before CI and `publish` can report whether
// the server's digest matches what was sent.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

export const DESCRIPTION_MAX_CHARS = 500;
export const ASSISTANT_NAME_MAX_CHARS = 64;
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}\.md$/;
export const FILE_MAX_BYTES = 64 * 1024;
export const FILES_TOTAL_MAX_BYTES = 256 * 1024;
export const MAX_FILES = 16;
export const MAX_SUB_AGENTS = 16;
export const MAX_CONNECT_APPS = 20;

const PERSONA_FILE = 'persona.md';
/**
 * The host's built-in task executor, used when no sub-agent is the default:
 * a sub-agent may only take this id by replacing it (`default: true`).
 */
const BUILT_IN_WORKER_ID = 'worker';
const MANIFEST_FILE = 'agent.json';
/** Present in a package directory for humans; never part of the package. */
const DOC_FILES = new Set(['README.md']);

const fileRef = z.string().regex(FILE_NAME_PATTERN, 'must be a file name like "notes.md"');

const subAgentSchema = z
  .object({
    id: z.string().regex(SLUG_PATTERN, 'must be lowercase letters, digits and "-"'),
    name: z.string().min(1).max(64),
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

export const appAgentJsonSchema = z
  .object({
    $schema: z.string().url().optional(),
    description: z.string().max(DESCRIPTION_MAX_CHARS).optional(),
    assistantName: z.string().trim().min(1).max(ASSISTANT_NAME_MAX_CHARS).optional(),
    model: z.string().regex(MODEL_PATTERN, 'must be a model id').optional(),
    tools: z
      .object({
        memory: z.boolean().optional(),
        tasks: z.boolean().optional(),
        agents: z.boolean().optional(),
        events: z.boolean().optional(),
        connections: z.boolean().optional(),
        webSearch: z.boolean().optional(),
      })
      .strict()
      .optional(),
    approvals: z.boolean().optional(),
    connectApps: z.array(z.string().regex(SLUG_PATTERN)).max(MAX_CONNECT_APPS).optional(),
    notes: fileRef.optional(),
    subAgents: z.array(subAgentSchema).max(MAX_SUB_AGENTS).optional(),
  })
  .strict();

export type AppAgentJson = z.infer<typeof appAgentJsonSchema>;
export type AppAgentJsonStored = Omit<AppAgentJson, '$schema'>;

/** What `PUT /v1/apps/:name/agent` takes. `files` is omitted when empty. */
export interface AppPackageBody {
  agent: AppAgentJsonStored;
  persona: string;
  files?: Record<string, string>;
}

export class AppPackageError extends Error {
  readonly issues: string[];
  constructor(dir: string, issues: string[]) {
    super(`${dir}: ${issues.join('; ')}`);
    this.name = 'AppPackageError';
    this.issues = issues;
  }
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * The cross-field rules (capability dependencies, file references, sub-agent
 * ids) — the same ones the gateway enforces. `appName` is the entry agent's
 * id on the host, so no sub-agent may take it.
 */
export function validateAppPackage(body: AppPackageBody, appName: string): string[] {
  const issues: string[] = [];
  const { agent, persona } = body;
  const files = body.files ?? {};
  const tools = agent.tools ?? {};
  const tasks = tools.tasks ?? true;
  const connections = tools.connections ?? true;

  if (bytes(persona) < 1) issues.push('persona.md must not be empty');
  if (bytes(persona) > FILE_MAX_BYTES) issues.push(`persona.md exceeds ${FILE_MAX_BYTES} bytes`);

  if (!tasks) {
    if (tools.agents === true) issues.push('tools.agents requires tools.tasks');
    if (agent.approvals === true) issues.push('approvals requires tools.tasks');
    if (agent.subAgents !== undefined && agent.subAgents.length > 0) {
      issues.push('subAgents requires tools.tasks');
    }
  }
  if (!connections && agent.connectApps !== undefined && agent.connectApps.length > 0) {
    issues.push('connectApps requires tools.connections');
  }

  const names = Object.keys(files);
  if (names.length > MAX_FILES) issues.push(`at most ${MAX_FILES} files`);
  let total = 0;
  for (const name of names) {
    const text = files[name] ?? '';
    if (!FILE_NAME_PATTERN.test(name)) issues.push(`file "${name}": invalid name`);
    if (name === PERSONA_FILE) issues.push(`"${PERSONA_FILE}" is the persona, not an extra file`);
    if (bytes(text) < 1) issues.push(`file "${name}" is empty`);
    if (bytes(text) > FILE_MAX_BYTES) issues.push(`file "${name}" exceeds ${FILE_MAX_BYTES} bytes`);
    total += bytes(text);
  }
  if (total > FILES_TOTAL_MAX_BYTES) issues.push(`files exceed ${FILES_TOTAL_MAX_BYTES} bytes in total`);

  const referenced = new Set<string>();
  const reference = (name: string, by: string): void => {
    referenced.add(name);
    if (!(name in files)) issues.push(`${by} references "${name}", which is not in the package`);
  };
  if (agent.notes !== undefined) reference(agent.notes, 'notes');

  const ids = new Set<string>();
  let defaults = 0;
  for (const [i, sub] of (agent.subAgents ?? []).entries()) {
    if (sub.id === appName) issues.push(`subAgents[${i}].id "${sub.id}" is the app's own agent id`);
    if (ids.has(sub.id)) issues.push(`subAgents[${i}].id "${sub.id}" is duplicated`);
    ids.add(sub.id);
    if (sub.id === BUILT_IN_WORKER_ID && sub.default !== true) {
      issues.push(
        `subAgents[${i}].id "${BUILT_IN_WORKER_ID}" is reserved for the default worker; mark it default or rename it`,
      );
    }
    if (sub.default === true) defaults++;
    reference(sub.instructions, `subAgents[${i}].instructions`);
  }
  if (defaults > 1) issues.push('at most one sub-agent may be the default');

  for (const name of names) {
    if (!referenced.has(name)) issues.push(`file "${name}" is not referenced by agent.json`);
  }
  return issues;
}

/** Reads a package directory into a publish body. Throws AppPackageError on any problem. */
export function loadAppPackage(dir: string): { appName: string; body: AppPackageBody } {
  const appName = basename(dir.replace(/\/+$/, ''));
  const issues: string[] = [];
  if (!SLUG_PATTERN.test(appName)) issues.push(`directory name "${appName}" is not a valid app name`);

  const manifestPath = join(dir, MANIFEST_FILE);
  const personaPath = join(dir, PERSONA_FILE);
  if (!existsSync(manifestPath)) throw new AppPackageError(dir, [`missing ${MANIFEST_FILE}`]);
  if (!existsSync(personaPath)) throw new AppPackageError(dir, [`missing ${PERSONA_FILE}`]);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new AppPackageError(dir, [`${MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`]);
  }
  const parsed = appAgentJsonSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppPackageError(
      dir,
      parsed.error.issues.map((i) => `agent.json ${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const { $schema: _schema, ...agent } = parsed.data;

  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir).sort()) {
    if (entry === MANIFEST_FILE || entry === PERSONA_FILE || DOC_FILES.has(entry)) continue;
    const path = join(dir, entry);
    if (!statSync(path).isFile()) {
      issues.push(`unexpected directory "${entry}"`);
      continue;
    }
    if (!entry.endsWith('.md')) {
      issues.push(`unexpected file "${entry}" (only .md files are part of a package)`);
      continue;
    }
    files[entry] = readFileSync(path, 'utf8');
  }

  const body: AppPackageBody = {
    agent,
    persona: readFileSync(personaPath, 'utf8'),
    ...(Object.keys(files).length > 0 ? { files } : {}),
  };
  issues.push(...validateAppPackage(body, appName));
  if (issues.length > 0) throw new AppPackageError(dir, issues);
  return { appName, body };
}

/** JSON with object keys sorted at every level — the gateway's canonical form. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The gateway's package digest: {agent, persona}, plus files when there are any. */
export function appPackageDigest(body: AppPackageBody): string {
  const files = body.files ?? {};
  const content =
    Object.keys(files).length === 0
      ? { agent: body.agent, persona: body.persona }
      : { agent: body.agent, files, persona: body.persona };
  return `sha256:${createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex')}`;
}

export type AppPublishOutcome = {
  status: 'published' | 'unchanged';
  version: number;
  digest: string;
};

export class AppPublishError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AppPublishError';
    this.status = status;
  }
}

/**
 * `PUT /v1/apps/:name/agent` with an app deploy token. 201 = a new version
 * (now active); 200 = identical to the active version, nothing changed.
 * The returned digest must equal the locally computed one — a mismatch means
 * the server normalized the package differently and is reported as an error.
 */
export async function publishAppPackage(opts: {
  gatewayUrl: string;
  token: string;
  appName: string;
  body: AppPackageBody;
  fetchImpl?: typeof fetch;
}): Promise<AppPublishOutcome> {
  const url = `${opts.gatewayUrl.replace(/\/+$/, '')}/v1/apps/${encodeURIComponent(opts.appName)}/agent`;
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(opts.body),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    version?: { version?: number; digest?: string };
    error?: unknown;
    message?: unknown;
  };
  if (res.status !== 200 && res.status !== 201) {
    // Nest errors: {statusCode, message: string | string[], error}.
    const message = Array.isArray(payload.message) ? payload.message.join('; ') : payload.message;
    const detail = [message, payload.error].find((v) => typeof v === 'string') ?? `HTTP ${res.status}`;
    throw new AppPublishError(
      `publishing ${opts.appName} failed (HTTP ${res.status}): ${String(detail)}`,
      res.status,
    );
  }
  const version = payload.version?.version;
  const digest = payload.version?.digest;
  if (typeof version !== 'number' || typeof digest !== 'string') {
    throw new AppPublishError(`publishing ${opts.appName}: unexpected response body`, res.status);
  }
  const expected = appPackageDigest(opts.body);
  if (digest !== expected) {
    throw new AppPublishError(
      `publishing ${opts.appName}: server digest ${digest} does not match the local ${expected}`,
      res.status,
    );
  }
  return { status: res.status === 201 ? 'published' : 'unchanged', version, digest };
}

/**
 * Deploy tokens are per app. CI holds them in one secret,
 * `DOUGH_DEPLOY_TOKENS` = `{"<app>": "dpt_…"}`.
 */
export function deployTokenFor(appName: string, tokensJson: string | undefined): string {
  if (tokensJson === undefined || tokensJson.trim() === '') {
    throw new Error('DOUGH_DEPLOY_TOKENS is not set (a JSON object {"<app>": "dpt_…"})');
  }
  let map: unknown;
  try {
    map = JSON.parse(tokensJson);
  } catch {
    throw new Error('DOUGH_DEPLOY_TOKENS is not valid JSON');
  }
  const token = (map as Record<string, unknown> | null)?.[appName];
  if (typeof token !== 'string' || !token.startsWith('dpt_')) {
    throw new Error(`DOUGH_DEPLOY_TOKENS has no deploy token for "${appName}"`);
  }
  return token;
}

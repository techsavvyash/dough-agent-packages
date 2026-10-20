#!/usr/bin/env bun
// `dough agent publish` — the agent-package CLI.
//
//   bun bin/publish.ts validate <dir>...   local schema validation (offline)
//   bun bin/publish.ts pack <dir>          deterministic bundle + digest (node runtime)
//   bun bin/publish.ts publish <dir>...    resolve → validate → idempotent PUT
//
// See docs/design/agent-packages.md §2. Every subcommand takes one or more
// package directories; `agents/*` glob-expands in the shell.
//
// agents/ holds two kinds, told apart by agent.json `kind`:
//   - registry agents (`kind` absent or "task"): one-shot task agents,
//     published to PUT /v1/agents/:id/:version (bin/registry.ts);
//   - app templates (`kind: "app"`): skeletons of always-on agent apps,
//     published to PUT /v1/agent-templates/:id/:version (bin/agent-template.ts).
// Both are immutable per id@version and use the same operator publish token.

import {
  type AgentTemplateBody,
  AgentTemplateError,
  PackageKind,
  TemplatePublishError,
  TemplatePublishOutcomeKind,
  loadTemplate,
  packageKind,
  publishTemplate,
  templateDigest,
} from './agent-template.ts';
import { type AgentManifest, AgentRuntime } from './manifest.ts';
import { packDir } from './pack.ts';
import { ImmutabilityError, RegistryClient, RegistryError } from './registry.ts';
import { PackageIoError, loadPackage, resolveManifest } from './resolve.ts';
import { ManifestValidationError } from './manifest.ts';

interface CliEnv {
  gatewayUrl: string | undefined;
  publishToken: string | undefined;
}

function readEnv(): CliEnv {
  return {
    gatewayUrl: process.env.DOUGH_GATEWAY_URL,
    publishToken: process.env.AGENT_REGISTRY_PUBLISH_TOKEN,
  };
}

/** Human-readable one-line describe of a package for logs. */
function describe(id: string, version: string, runtime: string): string {
  return `${id}@${version} (${runtime})`;
}

/** A package directory, loaded and validated according to its kind. */
type LoadedAny =
  | { kind: typeof PackageKind.Task; def: AgentManifest }
  | { kind: typeof PackageKind.App; body: AgentTemplateBody };

function loadAny(dir: string): LoadedAny {
  const pkg = loadPackage(dir);
  if (packageKind(pkg.raw) === PackageKind.App) {
    return { kind: PackageKind.App, body: loadTemplate(dir) };
  }
  return { kind: PackageKind.Task, def: resolveManifest(pkg) };
}

function describeTemplate(body: AgentTemplateBody): string {
  return `${body.template.id}@${body.template.version} (app template)`;
}

// ── validate ────────────────────────────────────────────────────────────────

async function cmdValidate(dirs: string[]): Promise<number> {
  if (dirs.length === 0) {
    console.error('validate: no package directories given');
    return 2;
  }
  let failures = 0;
  for (const dir of dirs) {
    try {
      const loaded = loadAny(dir);
      if (loaded.kind === PackageKind.App) {
        console.log(`OK  ${describeTemplate(loaded.body)}  digest=${templateDigest(loaded.body)}  [${dir}]`);
      } else {
        const { def } = loaded;
        console.log(`OK  ${describe(def.id, def.version, def.runtime)}  [${dir}]`);
      }
    } catch (err) {
      failures++;
      reportPackageError(dir, err);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} of ${dirs.length} package(s) failed validation`);
    return 1;
  }
  console.log(`\nall ${dirs.length} package(s) valid`);
  return 0;
}

// ── pack ────────────────────────────────────────────────────────────────────

async function cmdPack(dirs: string[]): Promise<number> {
  if (dirs.length === 0) {
    console.error('pack: no package directory given');
    return 2;
  }
  let failures = 0;
  for (const dir of dirs) {
    try {
      const loaded = loadAny(dir);
      if (loaded.kind === PackageKind.App) {
        console.error(`SKIP ${describeTemplate(loaded.body)}: app templates ship no bundle`);
        continue;
      }
      const { def } = loaded;
      if (def.runtime !== AgentRuntime.Node) {
        console.error(
          `SKIP ${describe(def.id, def.version, def.runtime)}: only 'node' runtime agents ship a bundle`,
        );
        continue;
      }
      const result = packDir(dir);
      console.log(`PACK ${describe(def.id, def.version, def.runtime)}`);
      console.log(`  digest: ${result.digest}`);
      console.log(`  files:  ${result.files.length}`);
      for (const f of result.files) console.log(`    - ${f}`);
    } catch (err) {
      failures++;
      reportPackageError(dir, err);
    }
  }
  return failures > 0 ? 1 : 0;
}

// ── publish ─────────────────────────────────────────────────────────────────

async function cmdPublish(dirs: string[], env: CliEnv, fetchImpl?: typeof fetch): Promise<number> {
  if (dirs.length === 0) {
    console.error('publish: no package directories given');
    return 2;
  }
  if (!env.gatewayUrl) {
    console.error('publish: DOUGH_GATEWAY_URL is not set');
    return 2;
  }
  if (!env.publishToken) {
    console.error('publish: AGENT_REGISTRY_PUBLISH_TOKEN is not set');
    return 2;
  }

  const client = new RegistryClient({
    baseUrl: env.gatewayUrl,
    token: env.publishToken,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  let failures = 0;
  let published = 0;
  let skipped = 0;
  for (const dir of dirs) {
    let loaded: LoadedAny;
    try {
      loaded = loadAny(dir);
    } catch (err) {
      failures++;
      reportPackageError(dir, err);
      continue;
    }
    if (loaded.kind === PackageKind.App) {
      const { body } = loaded;
      try {
        const outcome = await publishTemplate({
          gatewayUrl: env.gatewayUrl,
          token: env.publishToken,
          body,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        if (outcome.outcome === TemplatePublishOutcomeKind.Created) {
          published++;
          console.log(`PUBLISHED ${describeTemplate(body)}  digest=${outcome.digest}`);
        } else if (outcome.outcome === TemplatePublishOutcomeKind.DeprecationUpdated) {
          published++;
          const state = body.template.deprecated === true ? 'deprecated' : 'undeprecated';
          console.log(`UPDATED   ${describeTemplate(body)}  (${state}; content unchanged)`);
        } else {
          skipped++;
          console.log(`SKIP      ${describeTemplate(body)}  (identical already published)`);
        }
      } catch (err) {
        failures++;
        reportPackageError(dir, err);
      }
      continue;
    }
    const { def } = loaded;
    try {
      // Pass the package dir so a node-runtime publish can pack + upload its
      // bundle before the manifest PUT (design §2 step 3); non-node runtimes
      // ignore it. packDir is the default packer inside publish().
      const outcome = await client.publish(
        def,
        (msg) => console.warn(`  warn: ${msg}`),
        packDir,
        dir,
      );
      if (outcome.kind === 'published') {
        published++;
        const bundleNote = outcome.bundleDigest ? `  bundle=${outcome.bundleDigest}` : '';
        console.log(
          `PUBLISHED ${describe(def.id, def.version, def.runtime)}  digest=${outcome.digest}${bundleNote}`,
        );
      } else {
        skipped++;
        console.log(`SKIP      ${describe(def.id, def.version, def.runtime)}  (identical already published)`);
      }
    } catch (err) {
      failures++;
      reportPackageError(dir, err);
    }
  }

  console.log(`\npublished ${published}, skipped ${skipped}, failed ${failures}`);
  return failures > 0 ? 1 : 0;
}

// ── error reporting ─────────────────────────────────────────────────────────

function reportPackageError(dir: string, err: unknown): void {
  if (
    err instanceof ManifestValidationError ||
    err instanceof PackageIoError ||
    err instanceof ImmutabilityError ||
    err instanceof RegistryError ||
    err instanceof TemplatePublishError
  ) {
    console.error(`ERR ${dir}: ${err.message}`);
  } else if (err instanceof AgentTemplateError) {
    console.error(`ERR ${dir}: invalid app template:`);
    for (const issue of err.issues) console.error(`  - ${issue}`);
  } else if (err instanceof Error) {
    console.error(`ERR ${dir}: ${err.name}: ${err.message}`);
  } else {
    console.error(`ERR ${dir}: ${String(err)}`);
  }
}

// ── dispatch ────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'validate':
      return cmdValidate(rest);
    case 'pack':
      return cmdPack(rest);
    case 'publish':
      return cmdPublish(rest, readEnv());
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      printUsage();
      return cmd === undefined ? 2 : 0;
    default:
      console.error(`unknown subcommand: ${cmd}`);
      printUsage();
      return 2;
  }
}

function printUsage(): void {
  console.log(
    [
      'dough agent packages CLI',
      '',
      'usage:',
      '  bun bin/publish.ts validate <dir>...   validate agent.json manifests locally',
      '  bun bin/publish.ts pack <dir>...       deterministically pack a node-runtime bundle',
      '  bun bin/publish.ts publish <dir>...    resolve, validate, and PUT to the registry',
      '',
      'agent.json "kind": absent or "task" = registry agent, "app" = app template',
      '(PUT /v1/agent-templates/:id/:version).',
      '',
      'env (publish):',
      '  DOUGH_GATEWAY_URL              registry base URL',
      '  AGENT_REGISTRY_PUBLISH_TOKEN  operator publish token',
    ].join('\n'),
  );
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('fatal:', err instanceof Error ? err.stack ?? err.message : err);
      process.exit(1);
    });
}

export { main, cmdValidate, cmdPack, cmdPublish };

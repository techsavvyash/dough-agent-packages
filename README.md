# dough-agent-packages

Source packages for [dough](https://try-dough.com) agents. Every package is a
directory under `agents/` with an `agent.json` manifest, whose `kind` says what
it is:

- **Registry agents** (`kind` absent or `"task"`): one-shot agents the platform
  runs in a fresh VM per task (PR review, coding, …), published to the hosted
  agent registry.
- **App templates** (`kind: "app"`): the skeleton of an always-on agent app such
  as Dough, the concierge — its sub-agents, their instructions, the tool
  ceiling and the starter persona. See [App templates](#app-templates).

This repo is the **authoring side** of both. Pushing to `main` publishes every
package via CI — **no platform deploy required**. Bumping a prompt is a PR here,
not an edit to the gateway. Every package is immutable per `id@version`.

The design lives in
[`dough-gateway/docs/design/agent-packages.md`](../dough-gateway/docs/design/agent-packages.md).

## Repo layout

```
agents/
  pr-reviewer/          agent.json, prompt.md, README.md        (registry agent)
  pr-reviewer-codex/    …
  coder/  coder-codex/  fixer-codex/  default/  …
  concierge/            agent.json, persona.md, notes.md,       (app template: Dough)
                        worker.md, README.md
bin/
  publish.ts            the CLI: validate | pack | publish (dispatches on kind)
  check-sync.ts         drift check vs the live dough-gateway definitions
  manifest.ts           the registry agent.json zod schema (local pre-flight)
  pack.ts               deterministic tar.gz bundling (node runtime)
  registry.ts           registry HTTP client + idempotency
  resolve.ts            promptFile/readmeFile inlining
  agent-template.ts     app templates: schema, file rules, digest, publish client
.github/workflows/publish.yml   tests + validation on PRs; publishes on main
```

## The registry package format

`agent.json` **is** the registry's stored `AgentDefinition`, with two authoring
conveniences resolved away at publish time:

| field | meaning |
|-------|---------|
| `id`, `version` | identity; `version` is strict semver and immutable once published |
| `description` | one-line catalog summary |
| `runtime` | `claude` \| `codex` \| `clanker` \| `node` |
| `model`, `maxTurns` | execution knobs (per-runtime rules — see below) |
| `needsWorkspace`, `workspaceMode` | git-checkout requirements |
| `hooks` | platform hook bindings (`setup-workspace`, `post-pr-review`, …) |
| `keywords`, `author`, `license`, `repository`, `homepage`, `maintainers` | npm-style metadata |
| `promptFile` | → inlined into `systemPrompt` at publish, then stripped |
| `readmeFile` | → inlined into `readme` at publish, then stripped |

### Per-runtime shape rules

| runtime | requires | forbids |
|---------|----------|---------|
| `claude` | `systemPrompt` (via `promptFile`) | `entrypoint`, `clankerAgent`, `toolchains` |
| `codex` | `systemPrompt` | `maxTurns`, `entrypoint`, `clankerAgent`, `toolchains` |
| `clanker` | `clankerAgent` (inline object) | `systemPrompt`, `entrypoint` |
| `node` | `entrypoint` (bundle-relative path); optional `toolchains` | `systemPrompt`, `maxTurns`, `clankerAgent` |

## Adding or changing an agent

1. Create `agents/<id>/` with `agent.json`, `prompt.md` (claude/codex), and
   `README.md`.
2. Set a fresh strict-semver `version`. Republishing an existing `id@version`
   with different content is a hard error — bump the version.
3. Validate locally: `bun bin/publish.ts validate agents/<id>`.
4. Open a PR. On merge, CI publishes it.

## The CLI

```bash
bun bin/publish.ts validate agents/*      # local validation of both kinds (offline)
bun bin/publish.ts pack agents/<node-id>  # deterministic bundle + digest (node runtime)
bun bin/publish.ts publish agents/*       # validate → idempotent PUT, per kind
```

`publish` reads `DOUGH_GATEWAY_URL` and `AGENT_REGISTRY_PUBLISH_TOKEN` (the
operator publish token, used for both kinds) from the environment. App
templates are published as described in [App templates](#app-templates). For a
registry agent it:

1. `POST /v1/agents/validate` (dry-run; warns and continues if the endpoint is
   absent — it lands in a later gateway task).
2. `GET /v1/agents/:id/:version` — if it exists with an identical content digest
   the publish is **skipped**; a different digest is a **hard error**.
3. `PUT /v1/agents/:id/:version` with the resolved definition.

## Drift detection

`bun bin/check-sync.ts` compares each package's `prompt.md` against the live
`systemPrompt` in a local `dough-gateway` checkout (default `../dough-gateway`,
override with `--gateway <path>`). The seven builtin prompts were extracted
verbatim from the gateway; this catches a gateway-side prompt change that hasn't
been mirrored here. The gateway remains authoritative until its compiled-in
`BUILTINS` are deleted (design §5).

## Determinism

`node`-runtime bundles are content-addressed by SHA256. The packer emits a
sorted, mtime-zeroed, fixed-mode POSIX USTAR archive gzipped deterministically,
so two packs of the same tree on any machine produce the same digest — which is
what makes republish idempotent.

## App templates

An app template is the versioned **skeleton** of an always-on agent app. The
**deployments** built from it (one per app: its persona, notes, model,
assistant name, the tools it enables within the ceiling, approvals, `/connect`
apps and triggers) are created and edited on the app's **Agent** tab in the
dashboard. This repo never writes a deployment and the dashboard never writes a
template: a deployment pins an exact template version, so publishing a new
version changes nothing until someone upgrades a deployment to it.

```
agents/<id>/            the directory name is the template id
  agent.json            the manifest (strict: unknown keys are rejected)
  *.md                  every file agent.json references, sent verbatim
  README.md             the catalog page; documentation only, never published
```

```jsonc
{
  "kind": "app",
  "id": "concierge",
  "version": "1.0.0",                 // strict semver, immutable once published
  "description": "…",                 // catalog summary, 1–500 chars
  "model": "gpt-6-luna",              // default model of new deployments
  "tools": {                          // the CEILING; every key defaults to true.
    "memory": true, "tasks": true,    // false = deployments can never enable it
    "agents": true, "events": true,
    "connections": true, "webSearch": true
  },
  "approvals": true,                  // ceiling; default = tools.tasks
  "subAgents": [                      // owned by the template, read-only in deployments
    { "id": "worker", "name": "Worker", "description": "…",
      "instructions": "worker.md", "default": true }
  ],
  "seed": {                           // copied into a NEW deployment only
    "persona": "persona.md",
    "notes": "notes.md",
    "assistantName": "Dough",
    "connectApps": ["gmail", "github"]
  }
}
```

Rules (the gateway enforces the same ones):

- Files: names match `^[a-z0-9][a-z0-9._-]{0,63}\.md$`; at most 16 files, each
  1 B–64 KiB, 256 KiB in total (UTF-8 bytes). Every file must be referenced by
  agent.json (`subAgents[].instructions`, `seed.persona`, `seed.notes`) and
  every reference must exist.
- `subAgents` (and `tools.agents`, `approvals: true`) need `tools.tasks` not to
  be `false`; `seed.connectApps` needs `tools.connections` not to be `false`.
- Sub-agent ids are unique slugs, at most one is `default`, and `worker` is
  reserved for the default sub-agent.
- Template files have no implicit trailing newline: `.editorconfig` keeps
  editors from adding one, since it would become part of the prompt.

`publish` sends `PUT /v1/agent-templates/:id/:version` with
`{"template": <agent.json without $schema>, "files": {"<name>.md": …}}`:
201 = published, 200 = this id@version already holds identical content, 409 =
it holds different content (bump `version`). The digest is
`sha256(canonical JSON of {template, files})` with keys sorted at every level,
the same canonicalization as registry manifests; the CLI verifies the server's
digest equals the local one. `validate` prints it.

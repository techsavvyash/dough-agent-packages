# dough-agent-packages

Source packages for [dough](https://try-dough.com) agents. Every package is a
directory under `agents/` with an `agent.json` manifest, whose `kind` says what
it is:

- **Registry agents** (`kind` absent or `"task"`): one-shot agents the platform
  runs in a fresh VM per task (PR review, coding, …), published to the hosted
  agent registry.
- **App templates** (`kind: "app"`): the skeleton of an always-on agent app —
  its sub-agents, their instructions, the tool ceiling and the starter persona.
  See [App templates](#app-templates).

This repo is the **authoring side** of both. Pushing to `main` publishes every
package via CI — **no platform deploy required**. Bumping a prompt is a PR here,
not an edit to the gateway. Every package is immutable per `id@version`.

### Dashboard or repo?

An always-on agent that is pure JSON and markdown — a persona, notes,
sub-agents and their instructions, the tools it may use — is created and edited
on the **dough dashboard**, not here. That includes team templates authored on
the dashboard. Nothing about such an agent needs a commit, a review or CI.

Use this repo (or your own, via the [reusable workflow](#publish-templates-from-your-own-repo))
for:

- **registry agents**: task agents published to the hosted registry;
- **app templates you want versioned in git**: next to the code they come with
  (a code skeleton, a service the agent drives), reviewed in pull requests and
  published by CI.

`agents/` currently holds registry agents only; the tests load a full app
template from `test/fixtures/templates/example-assistant/`.

The design lives in
[`dough-gateway/docs/design/agent-packages.md`](../dough-gateway/docs/design/agent-packages.md).

## Repo layout

```
agents/
  pr-reviewer/          agent.json, prompt.md, README.md        (registry agent)
  pr-reviewer-codex/    …
  coder/  coder-codex/  fixer-codex/  default/  …
  <name>/               agent.json, persona.md, *.md, README.md (app template, kind "app")
bin/
  publish.ts            the CLI: validate | pack | publish (dispatches on kind)
  check-sync.ts         drift check vs the live dough-gateway definitions
  manifest.ts           the registry agent.json zod schema (local pre-flight)
  pack.ts               deterministic tar.gz bundling (node runtime)
  registry.ts           registry HTTP client + idempotency
  resolve.ts            promptFile/readmeFile inlining
  agent-template.ts     app templates: schema, namespaces, tokens, digest, publish client
.github/workflows/publish.yml            this repo: tests + validation on PRs; publishes on main
.github/workflows/publish-templates.yml  reusable: any repo validates/publishes its templates
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

An illustrative team template, `agents/release-desk/` in Acme's repo, kept in
git next to the release tooling its sub-agents drive:

```jsonc
{
  "$schema": "https://api.try-dough.com/v1/agent-template/schema",
  "kind": "app",
  "id": "@acme/release-desk",         // "@<team-slug>/<name>"; a bare id is a platform template
  "version": "1.0.0",                 // strict semver without +build, immutable once published
  "description": "…",                 // catalog summary, 1–500 chars
  "deprecated": false,                // optional; hides it from new deployments
  "model": "gpt-6-luna",              // default model of new deployments
  "tools": {                          // the CEILING; every key defaults to true.
    "memory": true, "tasks": true,    // false = deployments can never enable it
    "agents": true, "events": true,
    "connections": true, "webSearch": false
  },
  "approvals": true,                  // ceiling; default = tools.tasks
  "subAgents": [                      // owned by the template, read-only in deployments
    { "id": "worker", "name": "Worker", "description": "…",
      "instructions": "worker.md", "default": true },
    { "id": "changelog", "name": "Changelog writer", "description": "…",
      "instructions": "changelog.md" }
  ],
  "seed": {                           // copied into a NEW deployment only
    "persona": "persona.md",
    "notes": "notes.md",
    "assistantName": "Release Desk",
    "connectApps": ["github", "linear"]
  }
}
```

Rules (the gateway enforces the same ones):

- Files: names match `^[a-z0-9][a-z0-9._-]{0,63}\.md$`; at most 16 files, each
  1 B–64 KiB, 256 KiB in total (UTF-8 bytes). Every file must be referenced by
  agent.json (`subAgents[].instructions`, `seed.persona`, `seed.notes`) and
  every reference must exist. Only `seed.persona` may name `persona.md`.
- `subAgents` (and `tools.agents`, `approvals: true`) need `tools.tasks` not to
  be `false`; `seed.connectApps` needs `tools.connections` not to be `false`.
- Sub-agent ids are unique slugs, at most one is `default`, and `worker` is
  reserved for the default sub-agent.
- Template files have no implicit trailing newline: `.editorconfig` keeps
  editors from adding one, since it would become part of the prompt.

`publish` sends `PUT /v1/agent-templates/:id/:version` with
`{"template": <agent.json without $schema>, "files": {"<name>.md": …}}` and
reads `outcome`: 201 `created`; 200 `unchanged` (this id@version already holds
identical content) or `deprecation-updated` (same content, only `deprecated`
flipped); 409 = it holds different content (bump `version`); 400 = invalid.
The digest is `sha256(canonical JSON of {files, template})` with keys sorted at
every level (the same canonicalization as registry manifests), `$schema` and
`deprecated` removed, `id` reduced to its bare name (a team template hashes
without its `@scope/`, so renaming the team never changes a digest) and no
defaults filled in; `files` is `{}` when empty. The
CLI verifies the server's `template.digest` equals the local one, and
`validate` prints it. A best-effort test checks parity against the gateway's
own `agentTemplateDigest` when a gateway checkout is present
(`../dough-gateway`, or `DOUGH_GATEWAY_DIR`).

### Namespaces and tokens

| id | who publishes | token |
|----|---------------|-------|
| `<name>` (bare) | dough operators, from this repo | `AGENT_REGISTRY_PUBLISH_TOKEN` |
| `@<team-slug>/<name>` | that team, from any repo | `DOUGH_TEMPLATE_TOKEN` (a `tpt_…` token) |

A team template's directory is named after `<name>`, e.g. `agents/support-bot/`
for `@acme/support-bot`. A team admin mints template publish tokens on the
team's **Templates** page in the dashboard. A team token publishes only into
its own team's namespace, and the operator token never publishes into a team's
namespace. The CLI picks the token per template and stops with the name of the
variable to set when the needed one is missing or holds the wrong kind of
token. Team templates are visible to the team's members only; platform
templates are visible to everyone.

## Publish templates from your own repo

Any repo can hold templates for its team. Put each one in its own directory
(by default under `agents/`), add a token, and call the reusable workflow:

1. On the dashboard, open your team's **Templates** page and mint a template
   publish token. Save it as the `DOUGH_TEMPLATE_TOKEN` Actions secret of the repo.
2. Add `.github/workflows/dough-templates.yml`:

```yaml
on: { push: { branches: [main] }, pull_request: {} }
jobs:
  templates:
    uses: techsavvyash/dough-agent-packages/.github/workflows/publish-templates.yml@main
    secrets: { DOUGH_TEMPLATE_TOKEN: "${{ secrets.DOUGH_TEMPLATE_TOKEN }}" }
```

Pull requests validate every template offline (no token needed). A push to the
default branch publishes them: a new `version` is created, an unchanged one is
skipped, and changed content under an existing version fails (bump the
version). Pin `@main` to a tag or commit SHA to pin the publish tool too; the
workflow runs this repo's CLI at exactly the commit you reference. Optional
inputs (under `with:`): `path`, a glob of template directories (default
`agents/*`), and `gateway-url` (default `https://api.try-dough.com`).

A minimal template, `agents/support-bot/`:

```
agents/support-bot/
  agent.json
  persona.md
```

```json
{
  "$schema": "https://api.try-dough.com/v1/agent-template/schema",
  "kind": "app",
  "id": "@acme/support-bot",
  "version": "1.0.0",
  "description": "Answers support questions for Acme customers.",
  "seed": { "persona": "persona.md", "assistantName": "Acme Support" }
}
```

`persona.md` holds the starting system prompt. Add sub-agents, a tool ceiling
and notes as described in [App templates](#app-templates). Check a template
locally with
`bun <path-to-this-repo>/bin/publish.ts validate agents/support-bot`.
Deployments of a team template are created on an app's **Agent** tab. A team
app can pin platform templates or its own team's; a personal app can pin
platform templates or those of any team its owner belongs to.

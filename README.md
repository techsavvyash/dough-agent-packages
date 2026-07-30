# dough-agent-packages

Source packages for the agents in the [dough](https://try-dough.com) registry.

This repo is the **authoring side** of the dough agent registry. Each agent is a
directory under `agents/` with a `agent.json` manifest, a `prompt.md` system
prompt, and a `README.md` catalog page. Pushing to `main` publishes every
package to the hosted registry via CI — **no platform deploy required**. Bumping
a prompt is a PR here, not an edit to the gateway.

The design lives in
[`dough-gateway/docs/design/agent-packages.md`](../dough-gateway/docs/design/agent-packages.md).

## Repo layout

```
agents/
  pr-reviewer/          agent.json, prompt.md, README.md
  pr-reviewer-codex/    …
  coder/  coder-codex/  fixer-codex/  concierge/  default/
bin/
  publish.ts            the CLI: validate | pack | publish
  check-sync.ts         drift check vs the live dough-gateway definitions
  manifest.ts           the agent.json zod schema (local pre-flight)
  pack.ts               deterministic tar.gz bundling (node runtime)
  registry.ts           registry HTTP client + idempotency
  resolve.ts            promptFile/readmeFile inlining
.github/workflows/publish.yml
```

## The package format

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
bun bin/publish.ts validate agents/*      # local schema validation (offline)
bun bin/publish.ts pack agents/<node-id>  # deterministic bundle + digest (node runtime)
bun bin/publish.ts publish agents/*       # resolve → validate → idempotent PUT
```

`publish` reads `DOUGH_GATEWAY_URL` and `AGENT_REGISTRY_PUBLISH_TOKEN` from the
environment. It:

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

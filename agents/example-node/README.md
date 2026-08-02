# example-node

A minimal **`node`-runtime** dough agent — a worked example of writing agent
behaviour as a real TypeScript program instead of a prompt.

It scans the checked-out workspace for cost-comment markers
(`TODO`/`FIXME`/`HACK`/`XXX`) and writes a Markdown report.

## Why node runtime

`claude`/`codex` agents are a **prompt** handed to an LLM CLI; the platform
supplies the behaviour via shared hooks. A `node` agent **is the program** — you
get deterministic control flow, direct filesystem/API access, and your own exit
code. Reach for it when the job is logic, not language: multi-step
orchestration, calling an SDK directly, transforming structured data.

## The contract

The worker spawns `entrypoint` with `bun src/main.ts` inside the VM and hands it
exactly four environment variables:

| var | meaning |
|-----|---------|
| `DOUGH_TASK_INPUT` | the task payload (this agent accepts optional JSON — see below) |
| `DOUGH_WORKSPACE` | path to the checked-out repo (present because `needsWorkspace: true`) |
| `DOUGH_AGENT_DIR` | this bundle's unpacked dir (read your own bundled assets here) |
| `DOUGH_RESULT_FILE` | write the result here; its content wins over the stdout tail |

Exit `0` = success; any non-zero exit fails the task (the stderr tail is
surfaced to the operator).

## Task input (optional)

Pass a JSON object to tune the scan; a free-text prompt is ignored (defaults
apply):

```json
{ "markers": ["NOTE", "WIP"], "maxResults": 50 }
```

## Manifest notes (`agent.json`)

- `runtime: "node"` **requires** `entrypoint` (bundle-relative) and **forbids**
  `promptFile`/`systemPrompt`, `maxTurns`, and `clankerAgent`.
- `needsWorkspace: true` + `workspaceMode: "branch"` + the `setup-workspace`
  hook is what makes `DOUGH_WORKSPACE` a checkout of the repo. Drop all three
  for a pure-compute agent that only reads `DOUGH_TASK_INPUT`.
- `roles: ["chat"]` is a **platform classification** — `chat` marks an
  invoke-only agent. Switch to `["reviewer"]` (or `["fixer"]`) if you want it
  auto-dispatched on PR-review events.
- **Dependencies:** the packer strips `node_modules`, so a bundle ships source
  only. Keep the entrypoint on Node built-ins (as here), **or** declare a
  `toolchains` map and shell out to the provisioned runtime, e.g.:

  ```json
  "toolchains": { "node": "20" }
  ```

## Run it locally

```sh
# standalone: scans the current directory, prints to stdout
bun agents/example-node/src/main.ts

# emulate the worker's env contract
DOUGH_WORKSPACE="$PWD" \
DOUGH_TASK_INPUT='{"markers":["TODO","FIXME","NOTE"]}' \
DOUGH_RESULT_FILE=/tmp/example-node-result.md \
  bun agents/example-node/src/main.ts && cat /tmp/example-node-result.md
```

## Publish

```sh
bun bin/publish.ts validate agents/example-node   # local pre-flight + gateway verdict
bun bin/publish.ts publish  agents/example-node   # packs (content-addressed) + uploads
```

Publishing is a PR to this repo, not a platform deploy.

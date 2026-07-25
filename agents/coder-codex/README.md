# coder-codex

Autonomous coding agent (OpenAI Codex / ChatGPT login) that implements a change and opens a pull request.

## What it does

`coder-codex` has the same scope as [`coder`](https://try-dough.com/agents/coder)
— it makes file edits in a target repo and opens a PR — but runs through the
**OpenAI Codex CLI** with ChatGPT-login OAuth instead of the Anthropic SDK. It:

1. Inspects the repository first — README, package manifests, relevant source —
   and honours any project-local `CLAUDE.md` / `AGENTS.md`.
2. Makes the requested change as a minimal, focused diff.
3. Verifies the change builds / passes tests when a test command is obvious from
   the manifests (`npm test`, `cargo test`, `pytest`, `go test`, `bun test`).
4. Prints a 1-3 sentence past-tense summary as its last output, which becomes
   the PR description verbatim.

The agent **never** runs state-changing `git`/`gh` — the system stages, commits,
pushes, and opens the PR. It refuses any change that would commit secrets. It is
a separate id from `coder` because task creation locks to the (agent, runtime)
pair: the bootstrap cred and broker egress differ per runtime.

## Run it (hosted)

```bash
curl -X POST https://api.try-dough.com/v1/tasks \
  -H "authorization: Bearer $DOUGH_TOKEN" \
  -d '{"agentRef":"coder-codex","prompt":"Add a --json flag to the export command that emits the report as JSON instead of a table."}'
```

The coder can also be driven from GitHub — a labelled issue or an @-mention of
the dough bot on an opted-in repo spawns a coder task whose PR targets that repo.

## Self-host it

```bash
clanker-agent pull coder-codex --registry https://api.try-dough.com/registry
```

## Lifecycle

- **before-agent → setup-workspace**: clones the repo and checks out a fresh
  gateway-named branch off the base.
- **before-agent → provision-from-config**: reads `.dough/config.yaml` and
  provisions the runnable environment (toolchain, services, egress).
- **after-agent → open-pull-request**: stages the edits, commits, pushes the
  branch, and opens the PR using the agent's summary as the body.
- **on-operator-message → steer-receive** and **on-turn-completed →
  steer-continuation**: allow live steering of an in-flight run.

## Runtime

- Runtime: **codex** (OpenAI Codex CLI, ChatGPT-login OAuth; the broker injects
  the real bearer at egress — the VM never sees your OpenAI token)
- Model: **gpt-5.5** (the only model chatgpt.com's Codex endpoint accepts for
  ChatGPT-account-backed callers)
- Workspace: **branch** (`needsWorkspace=true`) — a fresh head branch is created
  and pushed as a new PR.

# coder

Autonomous coding agent that implements a change in a target repo and opens a pull request.

## What it does

`coder` runs inside a Firecracker VM with the target repository already cloned
and a fresh branch checked out. It:

1. Inspects the repository first — README, package manifests, and the
   directly-relevant source — and honours any project-local `CLAUDE.md` /
   `AGENTS.md`.
2. Makes the requested change as a minimal, focused diff (no tangential
   refactors).
3. Verifies the change builds / passes tests when a test command is obvious from
   the manifests (`npm test`, `cargo test`, `pytest`, `go test`, `bun test`),
   fixing any failure it introduces.
4. Prints a 1-3 sentence past-tense summary as its last output, which becomes
   the PR description verbatim.

The agent **never** runs state-changing `git`/`gh` — the system stages, commits,
pushes, and opens the PR deterministically. It refuses any change that would
commit secrets.

## Run it (hosted)

```bash
curl -X POST https://api.try-dough.com/v1/tasks \
  -H "authorization: Bearer $DOUGH_TOKEN" \
  -d '{"agentRef":"coder","prompt":"Add a --json flag to the export command that emits the report as JSON instead of a table."}'
```

The coder can also be driven from GitHub — a labelled issue or an @-mention of
the dough bot on an opted-in repo spawns a coder task whose PR targets that repo.

## Self-host it

```bash
clanker-agent pull coder --registry https://api.try-dough.com/registry
```

## Lifecycle

- **before-agent → setup-workspace**: clones the repo and checks out a fresh
  gateway-named branch off the base.
- **before-agent → provision-from-config**: reads `.dough/config.yaml` and
  provisions the runnable environment (toolchain, services, egress) so tests can
  actually run.
- **after-agent → open-pull-request**: stages the agent's edits, commits,
  pushes the branch, and opens the PR using the agent's summary as the body.
- **on-operator-message → steer-receive** and **on-turn-completed →
  steer-continuation**: allow live steering of an in-flight run.

## Runtime

- Runtime: **claude** (Anthropic SDK)
- Model: CLI default (not pinned)
- Workspace: **branch** (`needsWorkspace=true`) — a fresh head branch is created
  and pushed as a new PR.

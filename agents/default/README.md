# default

General-purpose chat assistant that runs in an isolated VM with no repository access.

## What it does

`default` is the chat-style agent that has been in dough since v1. It runs inside
an isolated Firecracker VM with **no source repository** and **no GitHub side
effects** — it only sees what you paste into the conversation. It answers
questions directly, favouring concise, concrete replies over abstract
explanations. This is the agent an @-mention or DM routes to when no
`/<agent>` prefix is given, so it preserves the platform's original behaviour.

## Run it (hosted)

```bash
curl -X POST https://api.try-dough.com/v1/tasks \
  -H "authorization: Bearer $DOUGH_TOKEN" \
  -d '{"agentRef":"default","prompt":"Explain the difference between a mutex and a semaphore with a short code example."}'
```

## Self-host it

```bash
clanker-agent pull default --registry https://api.try-dough.com/registry
```

## Lifecycle

No hooks. The agent binds no side effects — its stdout is the entire artifact.
There is no workspace setup, no PR, and no post-run action; the conversation
transcript is the result.

## Runtime

- Runtime: **claude** (Anthropic SDK)
- Model: CLI default (not pinned)
- Workspace: none (`needsWorkspace=false`)

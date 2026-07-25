# concierge

Always-on coordinator that triages requests and decomposes real work into pad task DAGs.

## What it does

`concierge` is the platform's always-on triage persona. Every message it
receives is a user request routed over HTTP. It decides, in order:

1. **Trivial** requests (direct questions, small lookups, chit-chat) — it just
   answers, without creating any tracked work.
2. **Real** work (anything worth tracking, parallelizing, or handing to a
   specialized executor) — it decomposes the request into pad tasks with
   `pad_create_task`, wiring dependencies via `dependencyIds` so the tasks form
   a DAG. A dependent task automatically receives its dependencies' outputs, so
   it never re-sends content.

It uses `list_agents` to discover available executors before decomposing, and
`register_agent` to mint a new specialist at run time when the work needs one.
It never polls for task completion — the reactive rules
(`pad.task.ready → create_attempt → executor dispatch`) take over once the DAG
exists. Its final reply always includes `taskIds`: the ids of every pad task it
created that turn (or `[]` when it answered directly).

This definition is the **single source of truth** for the concierge persona.
The deployed concierge lingering app pulls it from the hosted registry at boot
and grafts on its host execution wiring (the clanker-tools MCP server and the
`reply`/`taskIds` output schema).

## Run it (hosted)

```bash
curl -X POST https://api.try-dough.com/v1/tasks \
  -H "authorization: Bearer $DOUGH_TOKEN" \
  -d '{"agentRef":"concierge","prompt":"Add rate limiting to the login endpoint and write tests for it, then open a PR."}'
```

## Self-host it

```bash
clanker-agent pull concierge --registry https://api.try-dough.com/registry
```

## Lifecycle

No hooks. The concierge does not set up a workspace or open PRs itself — it
orchestrates. All side effects happen through the clanker pad/agent tools its
host exposes (`pad_create_task`, `list_agents`, `register_agent`,
`pad_list_tasks`, `pad_get_task`, `bus_emit`), and the reactive rules on the
host dispatch the tasks it creates.

## Runtime

- Runtime: **claude** (Anthropic SDK)
- Model: **claude-sonnet-5** (pinned to match the deployed concierge host so a
  registry publish and the built-in fallback speak with the same voice)
- Workspace: none (`needsWorkspace=false`)

# concierge (Dough)

The app template behind **Dough**, dough's always-on concierge: the `concierge`
app, reached from Discord, Telegram and the dashboard.

| file | what it is |
|------|------------|
| `agent.json` | the template: default model, tool ceiling, the `worker` sub-agent and the seed |
| `persona.md` | seed: Dough's system prompt |
| `notes.md` | seed: how Dough acts for a user (signing what it creates, finding the user's time zone) |
| `worker.md` | the prompt of the worker that runs the tasks Dough hands off |

Every capability (memory, tasks, sub-agents, events, connections, web search,
approvals) is within the ceiling. `notes.md` and `worker.md` have no trailing
newline on purpose: the host uses them verbatim.

Merging a new version here publishes the template; it does not change the
running app. The `concierge` deployment pins an exact template version and is
edited (persona, notes, model, permissions, triggers) on the app's Agent tab in
the dashboard, where it can be upgraded to a newer template version. The seed
files are only copied into new deployments.

# concierge (Dough)

The app package for **Dough**, dough's always-on concierge: the `concierge`
app, reached from Discord, Telegram and the dashboard.

| file | what it is |
|------|------------|
| `agent.json` | model, name, the `/connect` apps it suggests, the notes file and its `worker` sub-agent |
| `persona.md` | Dough's system prompt |
| `notes.md` | how Dough acts for a user: signing what it creates, finding the user's time zone |
| `worker.md` | the prompt of the worker that runs the tasks Dough hands off |

Every capability (memory, tasks, sub-agents, events, connections, web search,
approvals) is on, which is the default. `notes.md` and `worker.md` have no
trailing newline on purpose: the host uses them verbatim.

Changes merged to `main` here are published by CI and live within seconds.
Edits made on the app's Agent tab in the dashboard are not written back here;
copy them into this directory to keep the repo the source of truth.

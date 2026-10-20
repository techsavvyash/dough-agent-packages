# example-assistant (test fixture)

A full app template the tests load from disk: a `worker` sub-agent, every
ceiling on and a complete seed. `notes.md` and `worker.md` have no trailing
newline on purpose (template files are sent verbatim). Its digest is pinned in
`test/agent-template.test.ts`; changing any byte here changes it.

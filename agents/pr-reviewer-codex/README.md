# pr-reviewer-codex

Autonomous code reviewer (OpenAI Codex / ChatGPT login) that investigates a PR
and reports through a single, continuously-updated review.

## What it does

`pr-reviewer-codex` has the same scope as
[`pr-reviewer`](https://try-dough.com/agents/pr-reviewer) — investigate a pull
request and hand off structured findings — but runs through the **OpenAI Codex
CLI** with ChatGPT-login OAuth instead of the Anthropic SDK. It:

1. Establishes intent from the diff, commit log, PR description, linked
   requirements, existing review threads, CI failures, and the `CLAUDE.md` or
   `AGENTS.md` files governing changed paths.
2. Reviews in risk order and reports only evidence-backed, reachable issues.
   It filters low-confidence and tool-enforced noise, consolidates repeated
   symptoms by root cause, and limits non-blocking nits to three.
3. Writes its review to `/tmp/dough/review.json` (a `body` summary, optional
   structured walkthrough and validation report, plus an array of anchored
   inline `comments`). Findings include a short title, severity, category,
   confidence, impact, evidence, and smallest safe fix, with native GitHub
   suggestion blocks when the exact replacement is unambiguous.

The agent investigates freely (reading files, running build/tests, using `gh` to
**read** context) but does **not** post the review itself and does **not** choose
the verdict. A marker-owned progress comment appears while it runs. On approval,
the system deletes that comment and leaves only the formal GitHub review; for a
non-approval outcome, it finalizes the comment as a sticky summary. Prior dough
verdicts are dismissed so only the latest is active. A blocking finding requests
changes; a clean or nit-only review approves, and non-blocking nits can still
appear inline on that approval. It is a separate id
from `pr-reviewer` because task creation locks to the (agent, runtime) pair. The
PR is described via `DOUGH_PR_NUMBER`, `DOUGH_PR_OWNER`, `DOUGH_PR_REPO`,
`DOUGH_PR_BASE_SHA`, `DOUGH_PR_HEAD_SHA`.

The formal review uses GitHub-native Markdown rather than a second summary
comment: a verdict callout and signal table stay visible, while the file
walkthrough and validation results are collapsed in `<details>` sections.
Inline findings use callouts with severity, category, and confidence metadata;
unambiguous fixes use committable `suggestion` fences.

It is usually fired automatically when a PR is opened / synchronized on an
opted-in repo, or on a label / @-mention of the dough bot.

## Run it (hosted)

```bash
curl -X POST https://api.try-dough.com/v1/tasks \
  -H "authorization: Bearer $DOUGH_TOKEN" \
  -d '{"agentRef":"pr-reviewer-codex","prompt":"Review this pull request.","agentContext":{"github":{"installationId":123,"owner":"techsavvyash","repo":"dough-gateway","prNumber":42}}}'
```

## Self-host it

```bash
clanker-agent pull pr-reviewer-codex --registry https://api.try-dough.com/registry
```

## Lifecycle

- **before-agent → setup-workspace**: clones the repo, checks out the PR head,
  and posts the `🔄 reviewing…` sticky status comment.
- **after-agent → post-pr-review**: reads `/tmp/dough/review.json`, posts the
  verdict review via `gh api`, dismisses any prior dough review, and removes the
  progress comment after an approval or finalizes it for a non-approval outcome.
- **on-operator-message → steer-receive** and **on-turn-completed →
  steer-continuation**: allow live steering of an in-flight run.

## Runtime

- Runtime: **codex** (OpenAI Codex CLI, ChatGPT-login OAuth; the broker injects
  the real bearer at egress — the VM never sees your OpenAI token)
- Model: **gpt-5.6-luna** (explicitly pinned; there is no model fallback)
- Workspace: **pr-head** (`needsWorkspace=true`) — the PR head checked out for
  investigation.

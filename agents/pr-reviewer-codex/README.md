# pr-reviewer-codex

Autonomous code reviewer (OpenAI Codex / ChatGPT login) that investigates a PR
and reports through a single, continuously-updated review.

## What it does

`pr-reviewer-codex` has the same scope as
[`pr-reviewer`](https://try-dough.com/agents/pr-reviewer) — investigate a pull
request and hand off structured findings — but runs through the **OpenAI Codex
CLI** with ChatGPT-login OAuth instead of the Anthropic SDK. It:

1. Inspects the diff with `git diff "$DOUGH_PR_BASE_SHA".."$DOUGH_PR_HEAD_SHA"`,
   skims the commit log for intent, and reads a project-local `CLAUDE.md` /
   `AGENTS.md` if present.
2. For each changed file, decides whether there are concrete, actionable
   comments — focusing on logic bugs, security issues (injection, auth bypass,
   secret leakage), concurrency/data-race problems, public-API breakage, and
   clear deviations from project conventions. It skips formatter-enforced style
   nits, favouring quality over quantity.
3. Writes its review to `/tmp/dough/review.json` (a `body` summary plus an array
   of anchored inline `comments`).

The agent investigates freely (reading files, running build/tests, using `gh` to
**read** context) but does **not** post the review itself and does **not** choose
the verdict. The system owns two edit-in-place artifacts — a single sticky
comment (`🔄 reviewing…` → verdict) and one formal review (**actionable inline
comments → REQUEST CHANGES**, **no inline comments → APPROVE**, prior dough
verdicts dismissed) — so re-reviews never clutter the PR. It is a separate id
from `pr-reviewer` because task creation locks to the (agent, runtime) pair. The
PR is described via `DOUGH_PR_NUMBER`, `DOUGH_PR_OWNER`, `DOUGH_PR_REPO`,
`DOUGH_PR_BASE_SHA`, `DOUGH_PR_HEAD_SHA`.

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
  verdict review via `gh api`, dismisses any prior dough review, and rewrites
  the sticky comment to the final verdict.
- **on-operator-message → steer-receive** and **on-turn-completed →
  steer-continuation**: allow live steering of an in-flight run.

## Runtime

- Runtime: **codex** (OpenAI Codex CLI, ChatGPT-login OAuth; the broker injects
  the real bearer at egress — the VM never sees your OpenAI token)
- Model: **gpt-5.5** (the only model chatgpt.com's Codex endpoint accepts for
  ChatGPT-account-backed callers)
- Workspace: **pr-head** (`needsWorkspace=true`) — the PR head checked out for
  investigation.

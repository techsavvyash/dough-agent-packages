# pr-reviewer

Autonomous code reviewer that investigates a pull request and reports through a
single, continuously-updated review — never a pile of bot comments.

## What it does

`pr-reviewer` runs inside a Firecracker VM with the target repo cloned and the
**head of the pull request checked out**. It:

1. Inspects the diff with `git diff "$DOUGH_PR_BASE_SHA".."$DOUGH_PR_HEAD_SHA"`,
   skims the commit log for intent, and reads a project-local `CLAUDE.md` if
   present.
2. Investigates as deeply as it needs — reading any file, grepping, running the
   project's build/tests, and using `gh` to **read** context (the PR
   conversation, linked issues, CI logs, related PRs).
3. For each changed file, decides whether there are concrete, actionable
   comments — focusing on logic bugs, security issues (injection, auth bypass,
   secret leakage), concurrency/data-race problems, public-API breakage, and
   clear deviations from project conventions. It deliberately skips
   formatter-enforced style nits, favouring quality over quantity.
4. Writes its findings to `/tmp/dough/review.json` (a `body` summary plus an
   array of anchored inline `comments`).

The agent investigates freely but does **not** post the review itself, and does
**not** choose the verdict. The system owns exactly two edit-in-place artifacts,
so re-reviews never clutter the PR:

- a **single sticky comment** that starts as a `🔄 reviewing…` progress
  indicator and is rewritten to the verdict summary when the review finishes
  (edited in place on every re-run, never duplicated), and
- **one formal GitHub review** carrying the verdict — **actionable inline
  comments → REQUEST CHANGES**, **no inline comments → APPROVE** — with any
  prior dough verdict dismissed so only the latest is active.

The PR is described via `DOUGH_PR_NUMBER`, `DOUGH_PR_OWNER`, `DOUGH_PR_REPO`,
`DOUGH_PR_BASE_SHA`, `DOUGH_PR_HEAD_SHA`. It is usually fired automatically when a
PR is opened / synchronized on an opted-in repo, or on a label / @-mention of the
dough bot.

## Run it (hosted)

```bash
curl -X POST https://api.try-dough.com/v1/tasks \
  -H "authorization: Bearer $DOUGH_TOKEN" \
  -d '{"agentRef":"pr-reviewer","prompt":"Review this pull request.","agentContext":{"github":{"installationId":123,"owner":"techsavvyash","repo":"dough-gateway","prNumber":42}}}'
```

## Self-host it

```bash
clanker-agent pull pr-reviewer --registry https://api.try-dough.com/registry
```

## Lifecycle

- **before-agent → setup-workspace**: clones the repo, checks out the PR head,
  and posts the `🔄 reviewing…` sticky status comment.
- **after-agent → post-pr-review**: reads `/tmp/dough/review.json`, posts the
  verdict review (deriving APPROVE / REQUEST_CHANGES from the findings),
  dismisses any prior dough review, and rewrites the sticky comment to the
  final verdict.
- **on-operator-message → steer-receive** and **on-turn-completed →
  steer-continuation**: allow live steering of an in-flight run.

## Runtime

- Runtime: **claude** (Anthropic SDK)
- Model: CLI default (not pinned)
- Workspace: **pr-head** (`needsWorkspace=true`) — the PR head checked out for
  investigation.

# pr-reviewer

Autonomous code reviewer that produces structured findings and posts one consolidated GitHub review.

## What it does

`pr-reviewer` runs inside a Firecracker VM with the target repo cloned and the
**head of the pull request checked out** (read-only). It:

1. Inspects the diff with `git diff "$DOUGH_PR_BASE_SHA".."$DOUGH_PR_HEAD_SHA"`,
   skims the commit log for intent, and reads a project-local `CLAUDE.md` if
   present.
2. For each changed file, decides whether there are concrete, actionable
   comments — focusing on logic bugs, security issues (injection, auth bypass,
   secret leakage), concurrency/data-race problems, public-API breakage, and
   clear deviations from project conventions. It deliberately skips
   formatter-enforced style nits, favouring quality over quantity.
3. Writes its review to `/tmp/dough/review.json` (a `body` summary plus an array
   of anchored inline `comments`).

The agent does **not** call `gh` and does **not** choose the verdict: the system
posts one consolidated review deterministically and sets the verdict from the
findings — **actionable inline comments → REQUEST CHANGES**, **no inline
comments → APPROVE**. The PR is described via `DOUGH_PR_NUMBER`,
`DOUGH_PR_OWNER`, `DOUGH_PR_REPO`, `DOUGH_PR_BASE_SHA`, `DOUGH_PR_HEAD_SHA`.

It is usually fired automatically when a PR is opened / synchronized on an
opted-in repo, or on a label / @-mention of the dough bot.

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

- **before-agent → setup-workspace**: clones the repo and checks out the PR head
  detached (read-only).
- **after-agent → post-pr-review**: reads `/tmp/dough/review.json` and posts one
  consolidated GitHub review via `gh api`, deriving the verdict from the
  findings.
- **on-operator-message → steer-receive** and **on-turn-completed →
  steer-continuation**: allow live steering of an in-flight run.

Note there is **no** `provision-from-config` hook: a reviewer is read-only on the
tree (it only runs `git diff`), so it gets the checkout but not the app's
runnable environment — this is the single gate that keeps the provisioning chain
(config scan, extra egress, toolchain/services) switched off.

## Runtime

- Runtime: **claude** (Anthropic SDK)
- Model: CLI default (not pinned)
- Workspace: **pr-head** (`needsWorkspace=true`) — read-only on the checked-out
  PR head.

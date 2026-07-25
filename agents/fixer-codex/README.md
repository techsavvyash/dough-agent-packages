# fixer-codex

Autonomous agent (OpenAI Codex / ChatGPT login) that addresses review comments on an existing PR.

## What it does

`fixer-codex` runs inside a Firecracker VM checked out on an **existing pull
request's head branch**. It reads the open review comments on the PR and makes
targeted edits to address them, pushing back to the same branch so GitHub
updates the PR in place — no new PR is opened. It:

1. Lists open review comments via
   `gh api "repos/$DOUGH_PR_OWNER/$DOUGH_PR_REPO/pulls/$DOUGH_PR_NUMBER/comments"`,
   addresses the root comments, and skips LGTM / nit / question-only ones.
2. For each actionable comment, makes the smallest change that satisfies it;
   when comments conflict it favours the correctness/security fix over style.
3. Verifies the change builds / passes tests when a test command is obvious from
   the manifests (`npm test`, `cargo test`, `pytest`, `go test`, `bun test`).
4. Prints a 1-3 sentence past-tense summary as its last output, naming the
   comment IDs it addressed; this becomes the new commit body.

The PR is described to the agent via `DOUGH_PR_NUMBER`, `DOUGH_PR_OWNER`,
`DOUGH_PR_REPO`, `DOUGH_PR_BASE_SHA`, and `DOUGH_PR_HEAD_SHA`. The agent
**never** runs state-changing `git`/`gh` — the system commits and pushes.

It is typically fired automatically from a `pull_request_review.submitted` /
`pull_request_review_comment.created` event on a dough-bot PR (or a repo opted
in via the per-repo toggle), closing the auto-review → fix loop.

## Run it (hosted)

```bash
curl -X POST https://api.try-dough.com/v1/tasks \
  -H "authorization: Bearer $DOUGH_TOKEN" \
  -d '{"agentRef":"fixer-codex","prompt":"Address the open review comments on this PR.","agentContext":{"github":{"installationId":123,"owner":"techsavvyash","repo":"dough-gateway","prNumber":42}}}'
```

## Self-host it

```bash
clanker-agent pull fixer-codex --registry https://api.try-dough.com/registry
```

## Lifecycle

- **before-agent → setup-workspace**: checks out the PR's existing head branch
  as a tracking branch (from the `prNumber` + `headBranch` on the workspace).
- **before-agent → provision-from-config**: reads `.dough/config.yaml` and
  provisions the runnable environment so tests can run.
- **after-agent → open-pull-request**: commits and pushes back to the same head
  branch — GitHub updates the existing PR in place (the idempotency path returns
  the existing PR URL rather than opening a new one).
- **on-operator-message → steer-receive** and **on-turn-completed →
  steer-continuation**: allow live steering of an in-flight run.

## Runtime

- Runtime: **codex** (OpenAI Codex CLI, ChatGPT-login OAuth; the broker injects
  the real bearer at egress)
- Model: **gpt-5.5** (the only model chatgpt.com's Codex endpoint accepts for
  ChatGPT-account-backed callers)
- Workspace: **branch** (`needsWorkspace=true`) — but it stays on the PR's
  existing head branch rather than creating a new one.

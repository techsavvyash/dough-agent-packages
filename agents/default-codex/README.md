# default-codex

The codex-runtime twin of [`default`](../default) — a general-purpose chat
assistant with **no repository access**, answering from the conversation alone.

## Why this exists

`default` backs the platform's `@mention` path: an `issue_comment` that mentions
the bot on any installed repo opens a chat task. That path is a platform default,
not a trigger binding, so it applies everywhere the GitHub App is installed.

`default` runs on the **claude** runtime, which needs a per-user Anthropic API
key in Vault. On an account that only has a ChatGPT (codex) subscription, every
@mention therefore produced a task that failed at the model call — surfacing on
the PR as an opaque `HTTP 502` several minutes later. `default-codex` gives that
path a home on the credential the account actually has.

The prompt is byte-identical to `default`'s; only `runtime` and `model` differ,
so behaviour stays comparable across the two.

## Choosing which one the mention path uses

The gateway resolves it from `GITHUB_MENTION_AGENT_REF` (default: `default`).
Set it to `default-codex` on a codex-only deployment.

## Capabilities

- No workspace, no repo checkout, no hooks — it cannot read your code or push.
- Prompt is the comment body with the bot mention stripped.

# cp-solver

An expert **competitive-programming** agent. Give it a problem — as text, as a
**screenshot**, or both — and it derives an algorithm that fits the stated
limits and returns one correct, efficient, ready-to-submit solution (C++17 by
default, Python 3 when the task calls for it).

| | |
|---|---|
| **Runtime** | `codex` (OpenAI Codex, ChatGPT login) — model `gpt-5.5` |
| **Role** | `chat` (no repository; the reply is the whole artifact) |
| **Modalities** | `text`, `image` |
| **Workspace** | none |

## What it does

1. Reads every attached image and transcribes the statement, I/O format,
   constraints, and samples.
2. Derives the approach and *proves it fits the limits* (target complexity from
   the constraints).
3. Enumerates edge cases (overflow, indexing, modulus, multi-test).
4. Writes a single self-contained program with fast I/O and correct integer
   widths.
5. Verifies against the provided samples before finishing.

## Input modalities

`cp-solver` declares `modalities: ["text", "image"]`. Image input rides the
platform's task-**attachments** channel: attached images are uploaded to the
content-addressed blob store, presigned into the worker bootstrap, downloaded
and verified inside the VM, and handed to the codex runtime as native
`local_image` input parts. No text-only fallback OCR — the model sees the actual
image.

## Running it

`cp-solver` is trigger-agnostic — it runs behind **any** trigger.

### Behind Telegram (the headline path)

1. Create a bot with @BotFather and set the gateway env:
   `TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_TOKEN=<token>`,
   `TELEGRAM_WEBHOOK_SECRET=<random>`, and (for the demo) `TELEGRAM_DEFAULT_OWNER_ID=<user>`.
2. Point Telegram at the gateway:
   `setWebhook(url="https://<gateway>/webhooks/telegram", secret_token="<TELEGRAM_WEBHOOK_SECRET>")`.
3. DM the bot a problem — paste text, send a screenshot, or send a screenshot
   with a caption. The solution is edited back into the chat as it runs.

Prefix a message with `/agent <ref>` to route to a different registry agent; the
default is `cp-solver`.

### Via the REST API (text + image)

```
POST /v1/tasks
{
  "agentRef": "cp-solver",
  "prompt": "Solve the attached problem.",
  "attachments": [
    { "filename": "problem.png", "mimeType": "image/png", "dataBase64": "<base64>" }
  ]
}
```

Poll `GET /v1/tasks/:id` (and its events feed) for the streamed answer.

## Notes

- Best for single, well-posed problems. It solves the problem you give it; it
  does not fetch a live contest or submit on your behalf.
- The delivered code is the efficient solution — it commits to one approach
  rather than dumping alternatives.

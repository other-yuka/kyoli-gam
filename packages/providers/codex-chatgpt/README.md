# @kyoli-gam/provider-codex-chatgpt

ChatGPT/Codex OAuth provider adapter for kyoli Server Mode.

The adapter signs requests with stored ChatGPT OAuth credentials, speaks the Codex
backend protocol, and powers the OpenAI-compatible gateway routes.

## Routes

| Gateway route | Upstream behavior |
|---|---|
| `/backend-api/codex/responses` | Native Codex Responses proxy |
| `/backend-api/files` | Codex file upload URL create |
| `/backend-api/files/{file_id}/uploaded` | Codex file finalize |
| `/v1/responses` | OpenAI Responses-compatible bridge |
| `/v1/chat/completions` | Generic Chat Completions bridge |

## Account setup

```bash
kyoli login codex
kyoli accounts status codex
```

## Checks

```bash
kyoli doctor codex
kyoli doctor codex --file
kyoli doctor codex --e2e --opencode
kyoli doctor codex --e2e --codex-cli
kyoli doctor codex --load --requests 8 --concurrency 2
```

## Docs

- [Codex compatibility matrix](../../../docs/codex-compatibility.md)
- [Codex release checklist](../../../docs/codex-release-checklist.md)
- [codex-lb cross-check](../../../docs/codex-lb-crosscheck.md)

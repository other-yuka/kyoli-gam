# @kyoli-gam/provider-codex-chatgpt

ChatGPT/Codex OAuth provider adapter for kyoli Server Mode.

The adapter signs requests with stored ChatGPT OAuth credentials, speaks the Codex
backend protocol, and powers the OpenAI-compatible gateway routes.

## Routes

| Gateway route | Upstream behavior |
|---|---|
| `/backend-api/codex/alpha/search` | Raw standalone Codex search proxy |
| `/backend-api/codex/memories/trace_summarize` | Raw memory summarization proxy |
| `/backend-api/codex/realtime/calls` | Raw WebRTC call creation proxy |
| `/backend-api/codex/responses` | Native Codex Responses proxy |
| `WS /backend-api/codex/responses` | Native Codex Responses WebSocket relay with `responses_websockets=2026-02-06` |
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

## Related

- [Root README](../../../README.md)
- [`@kyoli-gam/gateway`](../../gateway)
- [`opencode-codex-multi-account`](../../codex-multi-account)

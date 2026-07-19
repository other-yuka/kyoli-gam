# @kyoli-gam/gateway

Local HTTP gateway for kyoli Server Mode.

The gateway exposes OpenAI/Anthropic-compatible routes, native Codex backend routes, and
admin routes backed by the kyoli SQLite account pool.

## Routes

| Route | Provider path | Notes |
|---|---|---|
| `GET /health` | local | Gateway health check |
| `GET /v1/models` | local registry | provider-owned model list |
| `GET /backend-api/codex/models` | local registry | Codex CLI model catalog shape |
| `POST /v1/responses` | Codex OAuth pool | Preferred OpenCode Server Mode path for Codex |
| `POST /v1/chat/completions` | Codex OAuth pool | Generic OpenAI-compatible bridge |
| `POST /backend-api/codex/alpha/search` | Codex OAuth pool | Standalone Codex web search |
| `POST /backend-api/codex/memories/trace_summarize` | Codex OAuth pool | Native Codex memory summarization |
| `POST /backend-api/codex/realtime/calls` | Codex OAuth pool | Native Codex WebRTC call creation |
| `POST /backend-api/codex/responses` | Codex OAuth pool | Native Codex backend path |
| `WS /backend-api/codex/responses` | Codex OAuth pool | Native Codex Responses WebSocket relay |
| `POST /backend-api/files` | Codex OAuth pool | Codex file upload URL creation |
| `POST /backend-api/files/{file_id}/uploaded` | Codex OAuth pool | Codex file finalize |
| `POST /v1/messages` | Claude Code OAuth pool | Live generation is opt-in |
| `POST /v1/messages/count_tokens` | Claude Code OAuth pool | Safer Claude smoke path |

Provider-prefixed model IDs are recommended:

```json
{ "model": "openai/gpt-5.3-codex" }
{ "model": "anthropic/claude-sonnet-5" }
```

## 30 seconds

Start through the CLI:

```bash
kyoli login codex
kyoli login claude
kyoli serve
```

Check the gateway:

```bash
curl http://127.0.0.1:2021/health
curl http://127.0.0.1:2021/v1/models
curl http://127.0.0.1:2021/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-5.3-codex","input":"Say smoke-ok","store":false}'
```

## Admin

Admin routes inspect and manage the local account store:

```bash
curl http://127.0.0.1:2021/admin/accounts/status
curl http://127.0.0.1:2021/admin/accounts/status?provider=codex
curl 'http://127.0.0.1:2021/admin/request-logs?provider=codex&grouped=true&limit=50'
```

`/admin/accounts/status` includes ready, rate-limited, auth-cooldown, disabled,
reauth-required, expired rate-limit, and recent failure buckets.

Set `KYOLI_ADMIN_TOKEN` or config `adminToken` before binding outside localhost:

```bash
curl http://127.0.0.1:2021/admin/accounts/status \
  -H 'authorization: Bearer <token>'
```

## Backpressure

`maxConcurrentRequests` / `KYOLI_MAX_CONCURRENT_REQUESTS` caps local provider-route
concurrency. The default `0` is uncapped. When a positive cap is saturated, the gateway
returns `429 local_overload`; provider account exhaustion remains separate and is handled
by the account executor.

## Related

- [Root README](../../README.md)
- [`@kyoli-gam/cli`](../cli)
- [`@kyoli-gam/core`](../core)
- [`@kyoli-gam/provider-codex-chatgpt`](../providers/codex-chatgpt)
- [`@kyoli-gam/provider-claude-code`](../providers/claude-code)

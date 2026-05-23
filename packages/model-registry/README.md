# @kyoli-gam/model-registry

Model metadata loader for kyoli Server Mode.

The registry gives OpenCode and OpenAI-compatible clients a fresh `/v1/models` surface
without creating a separate kyoli provider namespace.

## Sources

Resolution order:

1. `KYOLI_MODELS_PATH` local override
2. cache at `KYOLI_MODELS_CACHE_PATH` or `~/.cache/kyoli-gam/models.dev.json`
3. bundled fallback snapshot
4. background refresh from `https://models.dev/api.json`

The gateway refreshes in the background on startup and every 60 minutes by default.

## Environment

```bash
KYOLI_MODELS_URL=https://models.dev
KYOLI_MODELS_PATH=/path/to/api.json
KYOLI_MODELS_CACHE_PATH=~/.cache/kyoli-gam/models.dev.json
KYOLI_DISABLE_MODELS_FETCH=true
KYOLI_MODELS_REFRESH_INTERVAL_MS=3600000
KYOLI_MODELS_FETCH_TIMEOUT_MS=10000
```

## Related

- [Root README](../../README.md)
- [`@kyoli-gam/gateway`](../gateway)
- [`@kyoli-gam/provider-codex-chatgpt`](../providers/codex-chatgpt)

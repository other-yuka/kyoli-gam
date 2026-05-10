# opencode-anthropic-multi-account

OpenCode plugin for multi-account Claude OAuth. It runs inside OpenCode and does not
launch `kyoli serve`.

Use this package for OpenCode Plugin Mode. Use Server Mode (`kyoli serve` +
`kyoli install opencode`) when the same account pool should also serve Codex CLI, SDK
clients, or a dashboard.

## Install

Add the plugin to `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["opencode-anthropic-multi-account@latest"]
}
```

If `plugin` already exists, append this package to the existing array.

Then use OpenCode's normal auth flow:

```bash
opencode auth login
```

Choose the Claude/Anthropic multi-auth OAuth method. Run the same command again to add
more Claude accounts or open the account management menu.

## What it does

- Uses OpenCode's built-in `anthropic` provider.
- Stores accounts under OpenCode's config directory.
- Rotates accounts on auth/rate-limit failures.
- Refreshes tokens before expiry.
- Keeps routing sticky by default for prompt-cache-heavy sessions.

## Tool policy

Claude tool handling is OpenCode-first:

- preserve incoming OpenCode tools when present;
- use Claude Code template tools only when OpenCode sends no tools;
- fill missing `input_schema` from the template only when tool counts match;
- do not remap unknown OpenCode/custom tools onto Claude Code fallback tools.

This is an internal compatibility policy, not a third user-facing mode.

## Server Mode migration

```bash
kyoli accounts import opencode --dry-run --provider claude-code
kyoli accounts import opencode --provider claude-code
kyoli install opencode
```

Do not keep this plugin enabled for Anthropic while also routing Anthropic through
`kyoli install opencode`, unless you are intentionally comparing both paths.

## Checks

No-live contract:

```bash
pnpm --filter opencode-anthropic-multi-account test:contract:native
```

Full package checks:

```bash
pnpm --filter opencode-anthropic-multi-account typecheck
pnpm --filter opencode-anthropic-multi-account test
pnpm --filter opencode-anthropic-multi-account build
```

Opt-in live acceptance:

```bash
KYOLI_ENABLE_LIVE_OPENCODE_CLAUDE_NATIVE=1 \
KYOLI_CLAUDE_ALLOW_LIVE_MESSAGES=1 \
pnpm --filter opencode-anthropic-multi-account test:live:opencode-claude-native
```

## Docs

- [Root README](../../README.md)
- [OpenCode Plugin Usage](../../docs/opencode-plugin-usage.md)
- [Claude live acceptance](../../docs/claude-live-acceptance.md)

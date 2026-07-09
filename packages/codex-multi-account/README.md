# opencode-codex-multi-account

OpenCode plugin for multi-account ChatGPT/Codex OAuth. It runs inside OpenCode and does
not launch `kyoli serve`.

Use this package for OpenCode Plugin Mode. Use Server Mode (`kyoli serve` +
`kyoli install opencode`) when the same account pool should also serve Codex CLI, SDK
clients, or a dashboard.

## Install

Add the plugin to `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["opencode-codex-multi-account@latest"]
}
```

If `plugin` already exists, append this package to the existing array.

Then use OpenCode's normal auth flow:

```bash
opencode auth login
```

Choose the ChatGPT/Codex multi-auth OAuth method. Run the same command again to add more
Codex accounts or open the account management menu.

## What it does

- Uses OpenCode's built-in `openai` provider.
- Stores accounts under OpenCode's config directory.
- Rotates accounts on auth/rate-limit failures.
- Hides pre-output Codex quota failures while replaying the same request with the next account.
- Retries model-capacity failures on the same account without putting it into quota cooldown.
- Refreshes tokens before expiry.
- Supports browser OAuth and device-code authentication.

## Server Mode migration

```bash
kyoli accounts import opencode --dry-run --provider codex
kyoli accounts import opencode --provider codex
kyoli install opencode
```

Do not keep this plugin enabled for OpenAI while also routing OpenAI through
`kyoli install opencode`, unless you are intentionally comparing both paths.

## Checks

No-live contract:

```bash
pnpm --filter opencode-codex-multi-account test:contract:native
```

Full package checks:

```bash
pnpm --filter opencode-codex-multi-account typecheck
pnpm --filter opencode-codex-multi-account test
pnpm --filter opencode-codex-multi-account build
```

## Related

- [Root README](../../README.md)
- [`opencode-multi-account-core`](../multi-account-core)
- [`@kyoli-gam/provider-codex-chatgpt`](../providers/codex-chatgpt)

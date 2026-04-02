---
"opencode-multi-account-core": patch
"opencode-anthropic-multi-account": patch
"opencode-codex-multi-account": patch
---

fix: switch build toolchain from esbuild to tsup for proper CJS interop

esbuild was converting `import lockfile from 'proper-lockfile'` to `import * as lockfile` in the published dist, causing `lockfile.lock is not a function` at runtime. tsup handles CJS-to-ESM interop correctly.

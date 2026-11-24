# AGENTS.md

`ag-vario` is a macOS-only, read-only observability HUD for Antigravity 2.0. Read [docs/DESIGN.md](./docs/DESIGN.md) before making changes.

## Collaboration & Scope
- **Respect design boundaries**: Stay within `docs/DESIGN.md` — do not add unrequested settings, localization/i18n, cross-platform shims, or host-modifying features (proxies, prompt/title rewriting, context unlocking).
- **Honest metrics**: Clearly separate host-reported exact numbers from local estimates; show `Unpriced` when rates are unavailable instead of fabricating values.
- **English UI**: Keep all rendered HUD labels, tooltips, and statuses in concise English.

## Engineering Rules
- **Clean separation & zero dependencies**: Keep `src/core/` pure calculations, `src/main/` read-only data collection/IPC, and `src/renderer/` lightweight Shadow DOM UI; do not add third-party runtime dependencies.
- **Low overhead & silence**: Closed popovers must stay hidden (`display: none`) with zero active animations; keep heavy scans/breakdowns on-demand with incremental caching.
- **Read-only host safety**: Open host SQLite databases strictly read-only; never write to `~/.gemini/antigravity/`; always keep a verified backup of the unmodified `app.asar` so `npm run hud:restore` stays lossless.
- **Verification**: Run `npm test` after code changes. Do not force-kill a running Antigravity app from inside an active session; ask the user to restart Antigravity manually after `npm run hud:install`.
- **Open-source attribution**: Preserve MIT attribution notices where conventions from `antigravity-context-viewer` are referenced.

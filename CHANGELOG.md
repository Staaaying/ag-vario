# Changelog

All notable changes to `ag-vario` are documented in this file.

## [0.3.1] - 2026-11-25 (`Antigravity v2.35.1 · Node >=22.13.0`)

### Changed
- Raised minimum required Node.js version from `>=22.5.0` to `>=22.13.0`.
- Removed Gravatar email-hash fallback when resolving user avatars (now uses local custom avatars, host-reported `profilePictureUrl`, or local initials).
- Switched conversation database scanning and ASAR repacking/verification to incremental, time-sliced, and streaming implementations with split-slot caching and stricter HTTPS/path validation.

### Added
- Transparent privacy/outbound HTTPS, code-signing/restore, and installation troubleshooting notes in `README.md`, `README.zh-CN.md`, and `docs/DESIGN.md`.
- macOS GitHub Actions test workflow (`.github/workflows/test.yml`).

## [0.3.0] - 2026-11-25 (`Antigravity v2.35.1 · Node >=22.5.0`)

### Added
- Automatic Light/Dark host theme detection and live syncing across Shadow DOM components (`Native Frosted` Light theme palette).

### Fixed
- Promoted composer and topbar popovers to browser Top Layer (`popover="manual"`) to prevent split-pane occlusion and auto-close on host modal dialogs.
- Kept composer popovers left-aligned to triggers with horizontal pane-bounds clamping.

## [0.2.0] - 2026-11-25 (`Antigravity v2.35.1 · Node >=22.5.0`)

### Added
- Host-reported context compaction tracking (`CORTEX_STEP_TYPE_CHECKPOINT`, `chatStartMetadata`), compaction count inside the Context ring, and pre/post token delta notice in the Context popover.

### Changed
- Refined Usage `Model Breakdown` labels (`Est. Cost (USD)`) and upgraded the 30-day activity heatmap to 10×10 rounded squares.
- Normalized reasoning effort labels to lowercase (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`).

## [0.1.0] - 2026-11-24 (`Antigravity v2.35.1 · Node >=22.5.0`)

### Added
- Initial release with split-pane Chat Composer Bar (`Session`, `Context`, `Subagents`) and Window Titlebar (`Quota`, `Usage`).
- Read-only local SQLite + loopback RPC collection, daily official Gemini/Claude pricing sync, and lossless ASAR install/restore scripts.

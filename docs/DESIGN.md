# `ag-vario` Design Specification

> **Name**: `vario` comes from a glider's *Variometer* — a minimal, glanceable instrument that tells the pilot whether altitude is being gained or spent, matching Antigravity's aviation theme.  
> **Scope**: macOS-only, read-only observability HUD for Antigravity 2.0 Desktop (verified baseline: `v2.34.0`).

---

## 1. Design Principles

`ag-vario` is a **practical, restrained, low-overhead, strictly read-only** observability HUD.

1. **Quiet by default, informative on demand**: Persistent indicators stay compact and blend into the host UI, surfacing semantic color only as context pressure rises or subagents run.
2. **Only what you actually check**: High-frequency session metrics sit inside each chat composer; low-frequency account-wide metrics sit in the window titlebar.
3. **Honest accounting**: Host-reported exact figures and local estimates are clearly separated; unpriced models show `Unpriced` rather than guessed numbers.
4. **Low overhead**: Closed popovers stay completely silent (`display: none`, zero background animations). Heavy work (context breakdown, SQLite usage scans) runs on demand with incremental caching.

---

## 2. Explicit Non-Goals

- UI localization / client translation / multi-language switcher (HUD UI is pure English);
- Custom color pickers, draggable floating docks, or hover-triggered popovers;
- Network proxies, system-prompt overrides, title rewriting, or context-limit unlocking;
- Back-calculating token counts from remaining quota percentages;
- Multi-currency conversion or subscription ROI calculators (API estimates use USD only);
- Antigravity CLI (`agy`) tracking or wrappers (Desktop only);
- Blended mid-session pricing (each session is priced by its first valid model call);
- Windows / Linux support.

---

## 3. Dual-Zone Layout & Interaction

All popovers are **click-to-toggle** (dismiss via second click, `Escape`, or clicking outside), with Shadow DOM event isolation so split-pane focus never jumps unexpectedly. Globally at most one popover is open at a time.

### Area A: Chat Composer Bar (Per Open Pane · High Frequency)

Mounted inside each visible chat composer before the right-hand controls (separated by a subtle divider), supporting single-pane and 2/3/4+ split-pane layouts:
- Compact spacing below `520px` pane width; fallback row below `agent-input-box` under `340px`;
- Popovers (`288px` wide) open upward by default and flip downward automatically when a pane sits near the top of the viewport (e.g., 2×2 splits).

1. **`Session`**
   - **Persistent**: Icon + total session tokens (main + subagents).
   - **Popover**: Total tokens & single `Est.` USD total, `turns · steps`, primary model with reasoning effort; `Token Breakdown` stacked bar (`Cache` / `Input` / `Output`) + `Hit` rate; `Avg TTFT`, `Speed`, and `Model Time`.
2. **`Context`**
   - **Persistent**: `16px` mini progress ring + context percentage (`<50%` green, `50%–79%` orange, `≥80%` red); when compacted, the compaction count (`1`..`9+`) is centered inside the ring in bright white (empty when uncompacted).
   - **Popover**: `used / limit · percent` header, an Ice Blue left-right aligned compaction notice (`Compacted N×` | `Last ... → ...` when compacted) above the on-demand 5-category breakdown (proportional estimate scaled to exact prompt tokens): `System Prompt`, `Skills & Rules`, `MCP Tools`, `Built-in Tools`, and `Messages & Outputs`.
3. **`Subagents`**
   - **Persistent**: Icon + `0` (dimmed) or `running/total` (highlighted when active).
   - **Popover**: List of child subagents and workflow agents with status (`Running` / `Done` / `Error`), model, and context usage.

### Area B: Window Titlebar (Global Account · Low Frequency)

Two subtle pills in the titlebar, opening downward:

1. **`Quota`**
   - **Persistent**: Side-by-side `20px` rings for `5h` and `7d` remaining percentages of the active model pool.
   - **Popover (`338px`)**: `Quota` + full subscription badge (e.g. `Google AI Ultra (5x)`) + `Updated HH:MM` + manual refresh; per-pool cards (`Gemini Models`, `Claude and GPT models`, etc.) with `5h limit` / `Weekly limit` progress bars, single-line right-aligned reset countdowns (`· Resets in ...`), and per-pool `Last reset` + weekly burn pace.
2. **`Usage`**
   - **Persistent**: Icon + `Today` total tokens.
   - **Popover (`420px`)**: Profile avatar, display name, full subscription badge, email, and `7 Days | 30 Days | All` selector; 5-cell summary (`Tokens`, `Est. Cost`, `Daily Avg`, `Per Chat`, `Daily Time`); 30-day `Token Activity` rounded-square heatmap (hover for day totals, click to filter `Model Breakdown` and `Top 3 Sessions` — clicking >7 days ago auto-switches `7 Days` → `30 Days`); `Model Breakdown` horizontal bars (`Est. Cost (USD)`); and `Top 3 Sessions` (root + child subagent rollups).

---

## 4. Data Sources & Accounting

- **Exact host-reported values**: Context usage & limits, compaction checkpoints (`CORTEX_STEP_TYPE_CHECKPOINT` / `chatStartMetadata.startStepIndex` / `truncationReason`) & pre/post prompt tokens, turns, steps, `inputTokens` / `outputTokens` / `cacheReadTokens`, cache hit rate (`cacheRead / (input + cacheRead)`), TTFT, output speed, model time, subagent/workflow tree, quota pool fractions & reset timestamps, and daily token totals.
- **Estimated values**: 5-category context breakdown (scaled to exact prompt tokens; note `MCP Tools` classification matches Protobuf definitions and has not yet been end-to-end verified against a live MCP server) and USD API cost (built-in official rates + daily HTTPS sync from official Gemini/Claude pricing pages, cached locally; unpriced models labeled `Unpriced`).
- **Visual language (`Native Frosted`)**: Dark translucent backdrop blur, inherited host sans-serif typography with `tabular-nums` on numbers, and low-saturation Ice Blue (`#7db8e8`) as the primary data accent.

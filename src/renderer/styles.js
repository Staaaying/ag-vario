(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  const mods = (root.__AGVarioModules = root.__AGVarioModules || {});
  mods.styles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COLORS = {
    iceBlue: '#7db8e8',
    iceBlueSoft: 'rgba(125, 184, 232, 0.16)',
    iceBlueBorder: 'rgba(125, 184, 232, 0.34)',
    track: 'rgba(255, 255, 255, 0.12)',
    contextLevels: {
      green: '#68c28c',
      orange: '#e0a054',
      red: '#e06c6c',
      unknown: 'rgba(255, 255, 255, 0.38)'
    },
    statusColors: {
      Running: '#7db8e8',
      Done: '#68c28c',
      Error: '#e06c6c'
    },
    heatmapRamp: [
      'rgba(255, 255, 255, 0.08)',
      'rgba(125, 184, 232, 0.28)',
      'rgba(125, 184, 232, 0.50)',
      'rgba(125, 184, 232, 0.74)',
      '#7db8e8'
    ]
  };

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTokensCompact(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const n = Math.max(0, Number(value));
    if (n < 1000) return String(Math.round(n));
    if (n < 100000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    if (n < 1000000) return `${Math.round(n / 1000)}K`;
    if (n < 100000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n < 1000000000) return `${Math.round(n / 1000000)}M`;
    return `${(n / 1000000000).toFixed(1).replace(/\.0$/, '')}B`;
  }

  function formatTokensOneDecimal(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const n = Math.max(0, Number(value));
    if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
    if (n < 1000000000) return `${(n / 1000000).toFixed(1)}M`;
    return `${(n / 1000000000).toFixed(1)}B`;
  }

  function formatContextPercentOneDecimal(waterline) {
    if (!waterline) return null;
    if (waterline.ratio !== null && waterline.ratio !== undefined && Number.isFinite(Number(waterline.ratio))) {
      return `${(Math.max(0, Number(waterline.ratio)) * 100).toFixed(1)}%`;
    }
    if (waterline.percent !== null && waterline.percent !== undefined && Number.isFinite(Number(waterline.percent))) {
      return `${Math.max(0, Number(waterline.percent)).toFixed(1)}%`;
    }
    return null;
  }

  function formatUsd(costUsd, { isPriced = true, hasUnpriced = false } = {}) {
    if (!isPriced || costUsd === null || costUsd === undefined || !Number.isFinite(Number(costUsd))) {
      return 'Unpriced';
    }
    const n = Math.max(0, Number(costUsd));
    const suffix = hasUnpriced ? '*' : '';
    if (n > 0 && n < 0.01) return `<$0.01${suffix}`;
    return `$${n.toFixed(2)}${suffix}`;
  }

  function formatDurationCompact(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
    const v = Math.max(0, Number(ms));
    if (v < 1000) return `${Math.round(v)}ms`;
    const sec = v / 1000;
    if (sec < 60) return `${sec.toFixed(1).replace(/\.0$/, '')}s`;
    const totalMin = Math.floor(sec / 60);
    const remSec = Math.round(sec % 60);
    if (totalMin < 60) return remSec > 0 ? `${totalMin}m ${remSec}s` : `${totalMin}m`;
    const hours = Math.floor(totalMin / 60);
    const remMin = totalMin % 60;
    return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
  }

  function formatDurationHm(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
    const v = Math.max(0, Number(ms));
    if (v === 0) return '0m';
    if (v < 60000) return '<1m';
    const totalMin = Math.round(v / 60000);
    if (totalMin < 60) return `${totalMin}m`;
    const hours = Math.floor(totalMin / 60);
    const remMin = totalMin % 60;
    return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
  }

  function formatPercent(ratio, digits = 0) {
    if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return '—';
    return `${(Number(ratio) * 100).toFixed(digits)}%`;
  }

  function formatTimeHHMM(ms) {
    if (!Number.isFinite(Number(ms))) return '—';
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return '—';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function formatDateShort(dateKey) {
    const m = String(dateKey || '').match(/^\d{4}-(\d{2})-(\d{2})$/);
    if (!m) return String(dateKey || '—');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[Number(m[1]) - 1] || m[1]} ${Number(m[2])}`;
  }

  function formatMonthDayTime(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return '—';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${months[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
  }

  function buildSvgRing({
    size = 20,
    strokeWidth = 2.2,
    fraction = null,
    color = COLORS.iceBlue,
    trackColor = COLORS.track
  } = {}) {
    const r = (size - strokeWidth) / 2;
    const c = 2 * Math.PI * r;
    const clamped =
      fraction !== null && fraction !== undefined && Number.isFinite(Number(fraction))
        ? Math.max(0, Math.min(1, Number(fraction)))
        : 0;
    const offset = c * (1 - clamped);
    const cx = size / 2;
    return [
      `<svg class="agv-ring-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">`,
      `<circle cx="${cx}" cy="${cx}" r="${r.toFixed(2)}" fill="none" stroke="${trackColor}" stroke-width="${strokeWidth}"/>`,
      `<circle cx="${cx}" cy="${cx}" r="${r.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 ${cx} ${cx})"/>`,
      '</svg>'
    ].join('');
  }

  const SHARED_CSS = `
    :host {
      all: initial;
      color-scheme: dark;
      font-family: inherit;
      color: rgba(242, 244, 248, 0.92);
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    *, *::before, *::after { box-sizing: border-box; }
    button {
      font-family: inherit;
      color: inherit;
      border: none;
      background: transparent;
      padding: 0;
      margin: 0;
      cursor: pointer;
      outline: none;
    }
    .agv-num { font-variant-numeric: tabular-nums; }
    .agv-muted { color: rgba(242, 244, 248, 0.56); }
    .agv-dim { color: rgba(242, 244, 248, 0.36); }
    .agv-ice { color: ${COLORS.iceBlue}; }
    .agv-ok { color: #68c28c; }
    .agv-warn { color: #e0a054; }
    .agv-risk { color: #e06c6c; }
    .agv-badge {
      display: inline-flex;
      align-items: center;
      padding: 1px 6px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      background: ${COLORS.iceBlueSoft};
      color: ${COLORS.iceBlue};
      border: 1px solid ${COLORS.iceBlueBorder};
      white-space: nowrap;
      flex-shrink: 0;
    }
    .agv-est-tag {
      font-size: 10px;
      color: rgba(242, 244, 248, 0.48);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 4px;
      padding: 0 4px;
      line-height: 15px;
    }
    .agv-popover {
      position: fixed;
      z-index: 2147483000;
      background: rgba(26, 28, 34, 0.84);
      backdrop-filter: blur(22px) saturate(160%);
      -webkit-backdrop-filter: blur(22px) saturate(160%);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 12px;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.44), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      color: rgba(242, 244, 248, 0.92);
      font-size: 12px;
      line-height: 1.4;
      overflow-y: auto;
      max-height: calc(100vh - 72px);
    }
    .agv-popover[hidden],
    .agv-popover:not([data-open="true"]) {
      display: none !important;
      animation: none !important;
    }
    .agv-popover::-webkit-scrollbar,
    .agv-sub-list::-webkit-scrollbar {
      width: 5px;
      height: 5px;
    }
    .agv-popover::-webkit-scrollbar-track,
    .agv-sub-list::-webkit-scrollbar-track {
      background: transparent;
    }
    .agv-popover::-webkit-scrollbar-thumb,
    .agv-sub-list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.16);
      border-radius: 999px;
    }
    .agv-popover::-webkit-scrollbar-thumb:hover,
    .agv-sub-list::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.32);
    }
    .agv-block {
      background: rgba(255, 255, 255, 0.045);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 9px;
      padding: 8px 10px;
    }
    .agv-bar-track {
      height: 5px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.09);
      overflow: hidden;
    }
    .agv-bar-fill {
      height: 100%;
      border-radius: 999px;
      background: ${COLORS.iceBlue};
    }
    .agv-ring-svg { display: block; flex-shrink: 0; }
  `;

  const COMPOSER_CSS = `
    :host {
      display: inline-flex;
      align-items: center;
      vertical-align: middle;
    }
    .agv-comp-row {
      display: inline-flex;
      align-items: center;
      height: 24px;
      white-space: nowrap;
      gap: 2px;
      padding: 0 6px 0 2px;
      margin: 0 2px 0 4px;
      border-right: 1px solid rgba(255, 255, 255, 0.10);
    }
    .agv-comp-row[data-compact="true"] {
      gap: 1px;
      padding: 0 4px 0 1px;
      margin: 0 1px 0 2px;
    }
    .agv-comp-row[data-fallback="true"] {
      border-right: none;
      margin: 0;
      padding: 3px 2px 0;
      height: auto;
    }
    .agv-trigger {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 24px;
      padding: 0 6px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 500;
      color: rgba(242, 244, 248, 0.70);
      transition: background-color 120ms ease, color 120ms ease;
    }
    .agv-comp-row[data-compact="true"] .agv-trigger {
      padding: 0 4px;
      gap: 3px;
    }
    .agv-trigger:hover,
    .agv-trigger[aria-expanded="true"] {
      background: rgba(255, 255, 255, 0.08);
      color: rgba(242, 244, 248, 0.96);
    }
    .agv-trigger[data-dim="true"] { color: rgba(242, 244, 248, 0.34); }
    .agv-trigger[data-highlight="true"] { color: ${COLORS.iceBlue}; }
    .agv-card {
      width: 288px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .agv-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 10px;
    }
    .agv-card-title { font-size: 12px; font-weight: 600; }
    .agv-card-sub { font-size: 11px; color: rgba(242, 244, 248, 0.56); }
    .agv-block-hero {
      background: rgba(255, 255, 255, 0.055);
      border: 1px solid rgba(255, 255, 255, 0.075);
      border-radius: 9px;
      padding: 9px 10px;
    }
    .agv-hero-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .agv-hero-val {
      font-size: 15px;
      font-weight: 600;
      color: rgba(242, 244, 248, 0.88);
      line-height: 1.2;
      letter-spacing: -0.01em;
    }
    .agv-hero-unit {
      font-size: 11px;
      font-weight: 400;
      color: rgba(242, 244, 248, 0.46);
      margin-left: 3px;
    }
    .agv-hero-cost {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .agv-hero-bot {
      margin-top: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 10.5px;
      line-height: 16px;
    }
    .agv-model-chip {
      color: ${COLORS.iceBlue};
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: right;
      min-width: 0;
    }
    .agv-stack-bar {
      height: 6px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      overflow: hidden;
      display: flex;
      gap: 1px;
    }
    .agv-tri-row {
      display: grid;
      grid-template-columns: 1fr 1fr 68px;
      gap: 8px;
    }
    .agv-tri-cell {
      min-width: 0;
      text-align: left;
    }
    .agv-tri-lbl {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 4px;
      font-size: 10px;
      font-weight: 400;
      color: rgba(242, 244, 248, 0.54);
      white-space: nowrap;
    }
    .agv-tri-val {
      font-size: 12px;
      font-weight: 600;
      color: rgba(242, 244, 248, 0.88);
      margin-top: 3px;
      white-space: nowrap;
    }
    .agv-ctx-list { display: flex; flex-direction: column; gap: 7px; }
    .agv-ctx-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      font-size: 11px;
      margin-bottom: 3px;
    }
    .agv-ctx-meta {
      display: inline-grid;
      grid-template-columns: 44px 12px 34px;
      column-gap: 4px;
      align-items: baseline;
      flex-shrink: 0;
      color: rgba(242, 244, 248, 0.56);
    }
    .agv-ctx-tok { text-align: right; }
    .agv-ctx-sep { text-align: center; color: rgba(242, 244, 248, 0.34); }
    .agv-ctx-pct { text-align: right; }
    .agv-sub-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 220px;
      overflow-y: auto;
      padding-right: 4px;
    }
    .agv-sub-item {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 7px 9px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.045);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .agv-sub-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .agv-sub-title {
      font-size: 11.5px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agv-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }
    .agv-sub-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10.5px;
      color: rgba(242, 244, 248, 0.54);
    }
  `;

  const TOPBAR_CSS = `
    :host {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      vertical-align: middle;
      -webkit-app-region: no-drag;
    }
    .agv-pills {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-right: 4px;
    }
    .agv-pills[data-placement="after-title"] {
      margin-right: 0;
      margin-left: 6px;
      padding-left: 8px;
      border-left: 1px solid rgba(255, 255, 255, 0.10);
    }
    .agv-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 26px;
      padding: 0 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.045);
      border: 1px solid rgba(255, 255, 255, 0.09);
      transition: background-color 120ms ease, border-color 120ms ease;
    }
    .agv-pill:hover,
    .agv-pill[aria-expanded="true"] {
      background: rgba(255, 255, 255, 0.09);
      border-color: rgba(255, 255, 255, 0.16);
    }
    .agv-ring-pair {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .agv-ring-stack {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: flex-start;
      height: 20px;
      line-height: 1;
    }
    .agv-ring-lbl {
      font-size: 9px;
      font-weight: 500;
      color: rgba(242, 244, 248, 0.54);
    }
    .agv-ring-pct {
      font-size: 11px;
      font-weight: 600;
      color: rgba(242, 244, 248, 0.92);
    }
    .agv-pill-sep {
      width: 1px;
      height: 14px;
      background: rgba(255, 255, 255, 0.12);
      margin: 0 1px;
    }
    .agv-usage-pill-txt {
      font-size: 11px;
      font-weight: 600;
    }
    .agv-quota-panel {
      width: 338px;
      padding: 12px 13px;
      display: flex;
      flex-direction: column;
      gap: 9px;
    }
    .agv-quota-panel .agv-panel-head {
      padding: 0 10px;
    }
    .agv-usage-panel {
      width: 420px;
      padding: 13px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .agv-panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .agv-head-left {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .agv-head-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .agv-icon-btn {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: rgba(242, 244, 248, 0.68);
    }
    .agv-icon-btn:hover { background: rgba(255, 255, 255, 0.09); color: #fff; }
    .agv-pool-card {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .agv-pool-title { font-size: 11.5px; font-weight: 600; }
    .agv-win-row { display: flex; flex-direction: column; gap: 3px; }
    .agv-win-top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      font-size: 11px;
    }
    .agv-quota-meta {
      display: inline-flex;
      align-items: baseline;
      justify-content: flex-end;
      gap: 5px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .agv-q-pct { font-weight: 600; color: rgba(242, 244, 248, 0.92); }
    .agv-q-sep { color: rgba(242, 244, 248, 0.34); }
    .agv-q-phrase {
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
      white-space: nowrap;
    }
    .agv-q-word { color: rgba(242, 244, 248, 0.44); }
    .agv-q-time { color: rgba(242, 244, 248, 0.56); }
    .agv-pool-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 1px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 10.5px;
      line-height: 16px;
      white-space: nowrap;
    }
    .agv-anthropic-txt {
      color: #f07b7b;
      font-weight: 600;
      font-size: 10.5px;
      line-height: 16px;
      letter-spacing: 0.01em;
    }
    .agv-profile {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .agv-profile-left {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
    }
    .agv-avatar {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      flex-shrink: 0;
      object-fit: cover;
      background: ${COLORS.iceBlueSoft};
      border: 1px solid ${COLORS.iceBlueBorder};
      color: ${COLORS.iceBlue};
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
    }
    .agv-profile-name {
      font-size: 12.5px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agv-profile-mail {
      font-size: 10.5px;
      color: rgba(242, 244, 248, 0.52);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agv-seg {
      display: inline-flex;
      padding: 2px;
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.07);
      flex-shrink: 0;
    }
    .agv-seg-btn {
      padding: 2px 7px;
      border-radius: 5px;
      font-size: 10.5px;
      font-weight: 600;
      color: rgba(242, 244, 248, 0.56);
      white-space: nowrap;
    }
    .agv-seg-btn[data-active="true"] {
      background: rgba(125, 184, 232, 0.22);
      color: #fff;
    }
    .agv-summary-5 {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 5px;
    }
    .agv-stat-cell {
      min-width: 0;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.055);
      border-radius: 8px;
      padding: 6px 6px;
    }
    .agv-stat-lbl {
      font-size: 9.5px;
      color: rgba(242, 244, 248, 0.50);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .agv-stat-val { font-size: 11.5px; font-weight: 600; margin-top: 2px; white-space: nowrap; }
    .agv-sec-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .agv-dots {
      display: grid;
      grid-template-columns: repeat(30, 8px);
      justify-content: space-between;
      align-items: center;
    }
    .agv-heat-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      transition: transform 100ms ease, box-shadow 100ms ease;
    }
    .agv-heat-dot:hover { transform: scale(1.25); }
    .agv-heat-dot[data-selected="true"] {
      box-shadow: 0 0 0 1.5px #fff;
    }
    .agv-model-list,
    .agv-top-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .agv-model-row { display: flex; flex-direction: column; gap: 3px; }
    .agv-model-top,
    .agv-top-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
    }
    .agv-model-top > span:first-child,
    .agv-top-row > span:first-child {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agv-usage-meta {
      display: inline-flex;
      align-items: baseline;
      justify-content: flex-end;
      gap: 6px;
      white-space: nowrap;
      flex-shrink: 0;
      color: rgba(242, 244, 248, 0.56);
    }
    .agv-u-tok { text-align: right; }
    .agv-u-sep { text-align: center; color: rgba(242, 244, 248, 0.34); }
    .agv-u-usd { text-align: right; }
    .agv-top-item {
      padding: 6px 8px;
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.05);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .agv-top-title {
      font-size: 11px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  return {
    COLORS,
    SHARED_CSS,
    COMPOSER_CSS,
    TOPBAR_CSS,
    escapeHtml,
    formatTokensCompact,
    formatTokensOneDecimal,
    formatContextPercentOneDecimal,
    formatUsd,
    formatDurationCompact,
    formatDurationHm,
    formatPercent,
    formatTimeHHMM,
    formatDateShort,
    formatMonthDayTime,
    buildSvgRing
  };
});

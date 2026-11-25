(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  const mods = (root.__AGVarioModules = root.__AGVarioModules || {});
  mods.styles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const THEMES = {
    dark: {
      iceBlue: '#7db8e8',
      iceBlueSoft: 'rgba(125, 184, 232, 0.16)',
      iceBlueBorder: 'rgba(125, 184, 232, 0.34)',
      track: 'rgba(255, 255, 255, 0.12)',
      centerText: 'rgba(242, 244, 248, 0.92)',
      inputSegment: 'rgba(214, 234, 250, 0.88)',
      inputDot: 'rgba(214, 234, 250, 0.90)',
      perfDot: 'rgba(125, 184, 232, 0.58)',
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
        '#343944',
        '#1b466e',
        '#2c70ad',
        '#52a3e8',
        '#b5dcff'
      ]
    },
    light: {
      iceBlue: '#256fb3',
      iceBlueSoft: 'rgba(37, 111, 179, 0.09)',
      iceBlueBorder: 'rgba(37, 111, 179, 0.22)',
      track: 'rgba(15, 23, 42, 0.10)',
      centerText: '#1f2328',
      inputSegment: '#7eb4e0',
      inputDot: '#7eb4e0',
      perfDot: 'rgba(37, 111, 179, 0.55)',
      contextLevels: {
        green: '#1f883d',
        orange: '#bf6a0b',
        red: '#cf222e',
        unknown: 'rgba(31, 35, 40, 0.30)'
      },
      statusColors: {
        Running: '#256fb3',
        Done: '#1f883d',
        Error: '#cf222e'
      },
      heatmapRamp: [
        '#eaeef2',
        '#c6e2f8',
        '#7bb7e8',
        '#3a86c8',
        '#1b5a94'
      ]
    }
  };

  const COLORS = THEMES.dark;

  function normalizeTheme(theme) {
    return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
  }

  function getThemeColors(theme) {
    return THEMES[normalizeTheme(theme)];
  }

  function parseRgbColor(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const s = raw.trim().toLowerCase();
    if (!s || s === 'transparent' || s === 'none') return null;
    const hex3 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
    if (hex3) {
      return {
        r: parseInt(hex3[1] + hex3[1], 16),
        g: parseInt(hex3[2] + hex3[2], 16),
        b: parseInt(hex3[3] + hex3[3], 16),
        a: 1
      };
    }
    const hex6 = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i);
    if (hex6) {
      return {
        r: parseInt(hex6[1], 16),
        g: parseInt(hex6[2], 16),
        b: parseInt(hex6[3], 16),
        a: hex6[4] ? parseInt(hex6[4], 16) / 255 : 1
      };
    }
    const rgb = s.match(
      /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/
    );
    if (rgb) {
      let a = 1;
      if (rgb[4] !== undefined) {
        a = rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
      }
      return {
        r: Number(rgb[1]),
        g: Number(rgb[2]),
        b: Number(rgb[3]),
        a: Number.isFinite(a) ? a : 1
      };
    }
    return null;
  }

  function classifyThemeToken(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const lower = raw.trim().toLowerCase();
    if (!lower) return null;
    const tokens = lower.split(/\s+/);
    const hasLight = tokens.some(
      (t) => t === 'light' || t === 'theme-light' || t === 'vscode-light' || t === 'hc-light' || t.endsWith('-light')
    );
    const hasDark = tokens.some(
      (t) =>
        t === 'dark' ||
        t === 'theme-dark' ||
        t === 'vscode-dark' ||
        t === 'hc-black' ||
        t === 'hc-dark' ||
        t.endsWith('-dark')
    );
    if (hasLight && !hasDark) return 'light';
    if (hasDark && !hasLight) return 'dark';
    return null;
  }

  function detectHostTheme(doc, win) {
    const roots = [doc?.documentElement, doc?.body].filter(Boolean);

    // 1. Explicit data-theme attribute
    for (const el of roots) {
      const attr = el.getAttribute?.('data-theme');
      const byAttr = classifyThemeToken(attr);
      if (byAttr) return byAttr;
    }

    // 2. Explicit class names (e.g. html.dark / html.light / vscode-light)
    for (const el of roots) {
      const cls = el.className || el.getAttribute?.('class') || '';
      const byCls = classifyThemeToken(typeof cls === 'string' ? cls : '');
      if (byCls) return byCls;
    }

    // 3. Computed style color-scheme and background luminance
    const getCS =
      typeof win?.getComputedStyle === 'function'
        ? win.getComputedStyle.bind(win)
        : typeof globalThis?.getComputedStyle === 'function'
          ? globalThis.getComputedStyle.bind(globalThis)
          : null;

    if (getCS) {
      for (const el of roots) {
        try {
          const cs = getCS(el);
          const scheme = String(cs?.colorScheme || cs?.getPropertyValue?.('color-scheme') || '')
            .trim()
            .toLowerCase();
          if (scheme === 'light') return 'light';
          if (scheme === 'dark') return 'dark';
        } catch {}
      }

      const bgCandidates = [];
      for (const el of roots) {
        try {
          const cs = getCS(el);
          const bgVar = cs?.getPropertyValue?.('--background')?.trim();
          if (bgVar) bgCandidates.push(bgVar);
          const bg = cs?.backgroundColor || cs?.getPropertyValue?.('background-color');
          if (bg) bgCandidates.push(bg);
        } catch {}
      }
      for (const rawColor of bgCandidates) {
        const parsed = parseRgbColor(rawColor);
        if (parsed && parsed.a >= 0.1) {
          const lum = (0.299 * parsed.r + 0.587 * parsed.g + 0.114 * parsed.b) / 255;
          return lum >= 0.55 ? 'light' : 'dark';
        }
      }
    }

    // 4. Media query fallback
    try {
      if (typeof win?.matchMedia === 'function') {
        if (win.matchMedia('(prefers-color-scheme: light)')?.matches) return 'light';
        if (win.matchMedia('(prefers-color-scheme: dark)')?.matches) return 'dark';
      }
    } catch {}

    return 'dark';
  }

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
    trackColor = COLORS.track,
    centerText = '',
    centerColor = 'rgba(242, 244, 248, 0.92)'
  } = {}) {
    const r = (size - strokeWidth) / 2;
    const c = 2 * Math.PI * r;
    const clamped =
      fraction !== null && fraction !== undefined && Number.isFinite(Number(fraction))
        ? Math.max(0, Math.min(1, Number(fraction)))
        : 0;
    const cx = size / 2;
    const offset = c * (1 - clamped);
    const label = String(centerText ?? '').trim();

    let textEl = '';
    if (label) {
      const baseFs = size <= 14 ? 7.4 : size <= 16 ? 8.8 : size * 0.56;
      const fs = (label.length > 1 ? baseFs * 0.78 : baseFs).toFixed(2);
      const ls = label.length > 1 ? '-0.04em' : '0';
      textEl = `<text data-ring-label="true" x="${cx}" y="${cx}" dy="0.355em" text-anchor="middle" fill="${centerColor}" font-size="${fs}" font-weight="700" style="font-variant-numeric:tabular-nums;letter-spacing:${ls};">${escapeHtml(label)}</text>`;
    }

    const textAttr = label ? ` data-ring-text="${escapeHtml(label)}"` : '';
    return [
      `<svg class="agv-ring-svg"${textAttr} width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">`,
      `<circle cx="${cx}" cy="${cx}" r="${r.toFixed(2)}" fill="none" stroke="${trackColor}" stroke-width="${strokeWidth}"/>`,
      `<circle cx="${cx}" cy="${cx}" r="${r.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 ${cx} ${cx})"/>`,
      textEl,
      '</svg>'
    ].join('');
  }

  const SHARED_CSS = `
    :host {
      all: initial;
      color-scheme: dark;
      --agv-text: rgba(242, 244, 248, 0.92);
      --agv-text-strong: rgba(242, 244, 248, 0.96);
      --agv-text-val: rgba(242, 244, 248, 0.88);
      --agv-trigger-text: rgba(242, 244, 248, 0.70);
      --agv-icon-text: rgba(242, 244, 248, 0.68);
      --agv-icon-hover: #fff;
      --agv-text-muted: rgba(242, 244, 248, 0.56);
      --agv-text-muted-soft: rgba(242, 244, 248, 0.54);
      --agv-text-mail: rgba(242, 244, 248, 0.52);
      --agv-text-stat-lbl: rgba(242, 244, 248, 0.50);
      --agv-text-subtle: rgba(242, 244, 248, 0.48);
      --agv-text-unit: rgba(242, 244, 248, 0.46);
      --agv-text-q-word: rgba(242, 244, 248, 0.44);
      --agv-text-dim: rgba(242, 244, 248, 0.36);
      --agv-text-sep: rgba(242, 244, 248, 0.34);
      --agv-ice: ${THEMES.dark.iceBlue};
      --agv-ice-soft: ${THEMES.dark.iceBlueSoft};
      --agv-ice-border: ${THEMES.dark.iceBlueBorder};
      --agv-ok: ${THEMES.dark.contextLevels.green};
      --agv-warn: ${THEMES.dark.contextLevels.orange};
      --agv-risk: ${THEMES.dark.contextLevels.red};
      --agv-anthropic: #f07b7b;
      --agv-popover-bg: rgba(26, 28, 34, 0.84);
      --agv-popover-border: rgba(255, 255, 255, 0.10);
      --agv-popover-shadow: 0 14px 36px rgba(0, 0, 0, 0.44), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      --agv-block-bg: rgba(255, 255, 255, 0.045);
      --agv-block-border: rgba(255, 255, 255, 0.06);
      --agv-block-shadow: none;
      --agv-hero-bg: rgba(255, 255, 255, 0.055);
      --agv-hero-border: rgba(255, 255, 255, 0.075);
      --agv-cell-bg: rgba(255, 255, 255, 0.04);
      --agv-cell-border: rgba(255, 255, 255, 0.055);
      --agv-top-item-bg: rgba(255, 255, 255, 0.035);
      --agv-top-item-border: rgba(255, 255, 255, 0.05);
      --agv-est-border: rgba(255, 255, 255, 0.12);
      --agv-bar-track: rgba(255, 255, 255, 0.09);
      --agv-stack-track: rgba(255, 255, 255, 0.08);
      --agv-divider: rgba(255, 255, 255, 0.10);
      --agv-pill-bg: rgba(255, 255, 255, 0.045);
      --agv-pill-border: rgba(255, 255, 255, 0.09);
      --agv-pill-shadow: none;
      --agv-pill-hover-bg: rgba(255, 255, 255, 0.09);
      --agv-pill-hover-border: rgba(255, 255, 255, 0.16);
      --agv-pill-hover-shadow: none;
      --agv-pill-sep: rgba(255, 255, 255, 0.12);
      --agv-trigger-hover-bg: rgba(255, 255, 255, 0.08);
      --agv-compact-bg: rgba(125, 184, 232, 0.11);
      --agv-compact-border: rgba(125, 184, 232, 0.28);
      --agv-compact-right: rgba(198, 224, 246, 0.88);
      --agv-seg-bg: rgba(255, 255, 255, 0.06);
      --agv-seg-border: rgba(255, 255, 255, 0.07);
      --agv-seg-active-bg: rgba(125, 184, 232, 0.22);
      --agv-seg-active-text: #fff;
      --agv-seg-active-shadow: none;
      --agv-scroll-thumb: rgba(255, 255, 255, 0.16);
      --agv-scroll-thumb-hover: rgba(255, 255, 255, 0.32);
      --agv-heat-selected: #fff;
      font-family: inherit;
      color: var(--agv-text);
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    :host([data-theme="light"]) {
      color-scheme: light;
      --agv-text: #1f2328;
      --agv-text-strong: #111418;
      --agv-text-val: #1f2328;
      --agv-trigger-text: #424a53;
      --agv-icon-text: #59636e;
      --agv-icon-hover: #1f2328;
      --agv-text-muted: #59636e;
      --agv-text-muted-soft: #59636e;
      --agv-text-mail: #656d76;
      --agv-text-stat-lbl: #656d76;
      --agv-text-subtle: #656d76;
      --agv-text-unit: #6e7781;
      --agv-text-q-word: #6e7781;
      --agv-text-dim: #8c959f;
      --agv-text-sep: rgba(15, 23, 42, 0.24);
      --agv-ice: ${THEMES.light.iceBlue};
      --agv-ice-soft: ${THEMES.light.iceBlueSoft};
      --agv-ice-border: ${THEMES.light.iceBlueBorder};
      --agv-ok: ${THEMES.light.contextLevels.green};
      --agv-warn: ${THEMES.light.contextLevels.orange};
      --agv-risk: ${THEMES.light.contextLevels.red};
      --agv-anthropic: #cf222e;
      --agv-popover-bg: rgba(244, 245, 247, 0.94);
      --agv-popover-border: rgba(15, 23, 42, 0.10);
      --agv-popover-shadow: 0 12px 32px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.85);
      --agv-block-bg: #ffffff;
      --agv-block-border: rgba(15, 23, 42, 0.065);
      --agv-block-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
      --agv-hero-bg: #ffffff;
      --agv-hero-border: rgba(15, 23, 42, 0.075);
      --agv-cell-bg: #ffffff;
      --agv-cell-border: rgba(15, 23, 42, 0.065);
      --agv-top-item-bg: #f7f8fa;
      --agv-top-item-border: rgba(15, 23, 42, 0.06);
      --agv-est-border: rgba(15, 23, 42, 0.12);
      --agv-bar-track: rgba(15, 23, 42, 0.09);
      --agv-stack-track: rgba(15, 23, 42, 0.08);
      --agv-divider: rgba(15, 23, 42, 0.10);
      --agv-pill-bg: #ffffff;
      --agv-pill-border: rgba(15, 23, 42, 0.09);
      --agv-pill-shadow: 0 1px 2px rgba(15, 23, 42, 0.045);
      --agv-pill-hover-bg: #ffffff;
      --agv-pill-hover-border: rgba(15, 23, 42, 0.16);
      --agv-pill-hover-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
      --agv-pill-sep: rgba(15, 23, 42, 0.10);
      --agv-trigger-hover-bg: rgba(15, 23, 42, 0.055);
      --agv-compact-bg: rgba(37, 111, 179, 0.08);
      --agv-compact-border: rgba(37, 111, 179, 0.20);
      --agv-compact-right: #1b5a94;
      --agv-seg-bg: rgba(15, 23, 42, 0.055);
      --agv-seg-border: rgba(15, 23, 42, 0.06);
      --agv-seg-active-bg: #ffffff;
      --agv-seg-active-text: #1f2328;
      --agv-seg-active-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
      --agv-scroll-thumb: rgba(15, 23, 42, 0.18);
      --agv-scroll-thumb-hover: rgba(15, 23, 42, 0.34);
      --agv-heat-selected: #1b5a94;
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
    .agv-muted { color: var(--agv-text-muted); }
    .agv-dim { color: var(--agv-text-dim); }
    .agv-ice { color: var(--agv-ice); }
    .agv-ok { color: var(--agv-ok); }
    .agv-warn { color: var(--agv-warn); }
    .agv-risk { color: var(--agv-risk); }
    .agv-badge {
      display: inline-flex;
      align-items: center;
      padding: 1px 6px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      background: var(--agv-ice-soft);
      color: var(--agv-ice);
      border: 1px solid var(--agv-ice-border);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .agv-est-tag {
      font-size: 10px;
      color: var(--agv-text-subtle);
      border: 1px solid var(--agv-est-border);
      border-radius: 4px;
      padding: 0 4px;
      line-height: 15px;
    }
    .agv-popover {
      position: fixed;
      inset: auto;
      margin: 0;
      padding: 0;
      overflow-x: hidden;
      z-index: 2147483000;
      background: var(--agv-popover-bg);
      backdrop-filter: blur(22px) saturate(160%);
      -webkit-backdrop-filter: blur(22px) saturate(160%);
      border: 1px solid var(--agv-popover-border);
      border-radius: 12px;
      box-shadow: var(--agv-popover-shadow);
      color: var(--agv-text);
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
      background: var(--agv-scroll-thumb);
      border-radius: 999px;
    }
    .agv-popover::-webkit-scrollbar-thumb:hover,
    .agv-sub-list::-webkit-scrollbar-thumb:hover {
      background: var(--agv-scroll-thumb-hover);
    }
    .agv-block {
      background: var(--agv-block-bg);
      border: 1px solid var(--agv-block-border);
      box-shadow: var(--agv-block-shadow);
      border-radius: 9px;
      padding: 8px 10px;
    }
    .agv-bar-track {
      height: 5px;
      border-radius: 999px;
      background: var(--agv-bar-track);
      overflow: hidden;
    }
    .agv-bar-fill {
      height: 100%;
      border-radius: 999px;
      background: var(--agv-ice);
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
      border-right: 1px solid var(--agv-divider);
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
      color: var(--agv-trigger-text);
      transition: background-color 120ms ease, color 120ms ease;
    }
    .agv-comp-row[data-compact="true"] .agv-trigger {
      padding: 0 4px;
      gap: 3px;
    }
    .agv-trigger:hover,
    .agv-trigger[aria-expanded="true"] {
      background: var(--agv-trigger-hover-bg);
      color: var(--agv-text-strong);
    }
    .agv-trigger[data-dim="true"] { color: var(--agv-text-sep); }
    .agv-trigger[data-highlight="true"] { color: var(--agv-ice); }
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
    .agv-card-sub { font-size: 11px; color: var(--agv-text-muted); }
    .agv-block-hero {
      background: var(--agv-hero-bg);
      border: 1px solid var(--agv-hero-border);
      box-shadow: var(--agv-block-shadow);
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
      color: var(--agv-text-val);
      line-height: 1.2;
      letter-spacing: -0.01em;
    }
    .agv-hero-unit {
      font-size: 11px;
      font-weight: 400;
      color: var(--agv-text-unit);
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
      color: var(--agv-ice);
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
      background: var(--agv-stack-track);
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
      color: var(--agv-text-muted-soft);
      white-space: nowrap;
    }
    .agv-tri-val {
      font-size: 12px;
      font-weight: 600;
      color: var(--agv-text-val);
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
      color: var(--agv-text-muted);
    }
    .agv-ctx-tok { text-align: right; }
    .agv-ctx-sep { text-align: center; color: var(--agv-text-sep); }
    .agv-ctx-pct { text-align: right; }
    .agv-compact-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 5.5px 10px;
      border-radius: 8px;
      background: var(--agv-compact-bg);
      border: 1px solid var(--agv-compact-border);
      font-size: 10.5px;
      line-height: 1.3;
      white-space: nowrap;
    }
    .agv-compact-left {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      color: var(--agv-ice);
      flex-shrink: 0;
    }
    .agv-compact-right {
      font-weight: 500;
      color: var(--agv-compact-right);
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
    }
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
      background: var(--agv-block-bg);
      border: 1px solid var(--agv-block-border);
      box-shadow: var(--agv-block-shadow);
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
      color: var(--agv-text-muted-soft);
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
      border-left: 1px solid var(--agv-divider);
    }
    .agv-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 26px;
      padding: 0 8px;
      border-radius: 999px;
      background: var(--agv-pill-bg);
      border: 1px solid var(--agv-pill-border);
      box-shadow: var(--agv-pill-shadow);
      transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
    }
    .agv-pill:hover,
    .agv-pill[aria-expanded="true"] {
      background: var(--agv-pill-hover-bg);
      border-color: var(--agv-pill-hover-border);
      box-shadow: var(--agv-pill-hover-shadow);
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
      color: var(--agv-text-muted-soft);
    }
    .agv-ring-pct {
      font-size: 11px;
      font-weight: 600;
      color: var(--agv-text);
    }
    .agv-pill-sep {
      width: 1px;
      height: 14px;
      background: var(--agv-pill-sep);
      margin: 0 1px;
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
      color: var(--agv-icon-text);
    }
    .agv-icon-btn:hover { background: var(--agv-pill-hover-bg); color: var(--agv-icon-hover); }
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
    .agv-q-pct { font-weight: 600; color: var(--agv-text); }
    .agv-q-sep { color: var(--agv-text-sep); }
    .agv-q-phrase {
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
      white-space: nowrap;
    }
    .agv-q-word { color: var(--agv-text-q-word); }
    .agv-q-time { color: var(--agv-text-muted); }
    .agv-pool-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 1px;
      padding-top: 6px;
      border-top: 1px solid var(--agv-block-border);
      font-size: 10.5px;
      line-height: 16px;
      white-space: nowrap;
    }
    .agv-anthropic-txt {
      color: var(--agv-anthropic);
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
      background: var(--agv-ice-soft);
      border: 1px solid var(--agv-ice-border);
      color: var(--agv-ice);
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
      color: var(--agv-text-mail);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agv-seg {
      display: inline-flex;
      padding: 2px;
      border-radius: 7px;
      background: var(--agv-seg-bg);
      border: 1px solid var(--agv-seg-border);
      flex-shrink: 0;
    }
    .agv-seg-btn {
      padding: 2px 7px;
      border-radius: 5px;
      font-size: 10.5px;
      font-weight: 600;
      color: var(--agv-text-muted);
      white-space: nowrap;
    }
    .agv-seg-btn[data-active="true"] {
      background: var(--agv-seg-active-bg);
      color: var(--agv-seg-active-text);
      box-shadow: var(--agv-seg-active-shadow);
    }
    .agv-summary-5 {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 5px;
    }
    .agv-stat-cell {
      min-width: 0;
      background: var(--agv-cell-bg);
      border: 1px solid var(--agv-cell-border);
      box-shadow: var(--agv-block-shadow);
      border-radius: 8px;
      padding: 6px 6px;
    }
    .agv-stat-lbl {
      font-size: 9.5px;
      color: var(--agv-text-stat-lbl);
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
      grid-template-columns: repeat(30, 10px);
      justify-content: space-between;
      align-items: center;
    }
    .agv-heat-dot {
      width: 10px;
      height: 10px;
      border-radius: 2.5px;
      transition: transform 100ms ease, box-shadow 100ms ease;
    }
    .agv-heat-dot:hover { transform: scale(1.18); }
    .agv-heat-dot[data-selected="true"] {
      box-shadow: 0 0 0 1.5px var(--agv-heat-selected);
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
      color: var(--agv-text-muted);
    }
    .agv-u-tok { text-align: right; }
    .agv-u-sep { text-align: center; color: var(--agv-text-sep); }
    .agv-u-usd { text-align: right; }
    .agv-top-item {
      padding: 6px 8px;
      border-radius: 7px;
      background: var(--agv-top-item-bg);
      border: 1px solid var(--agv-top-item-border);
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
    THEMES,
    COLORS,
    normalizeTheme,
    getThemeColors,
    parseRgbColor,
    detectHostTheme,
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

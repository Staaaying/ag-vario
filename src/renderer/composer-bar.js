(function (root, factory) {
  const styles =
    typeof module === 'object' && module.exports
      ? require('./styles')
      : root.__AGVarioModules.styles;
  const api = factory(styles);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  const mods = (root.__AGVarioModules = root.__AGVarioModules || {});
  mods.composerBar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (styles) {
  'use strict';

  const EDITABLE_SELECTOR = 'input, textarea, select, option, label, [contenteditable]';

  function attachShadowIsolation(shadow) {
    if (!shadow || typeof shadow.addEventListener !== 'function') return;
    shadow.addEventListener('mousedown', (e) => {
      const t = e?.target;
      const el = t && typeof t.closest === 'function' ? t : t?.parentElement;
      if (!el?.closest?.(EDITABLE_SELECTOR)) e?.preventDefault?.();
      e?.stopPropagation?.();
    });
    shadow.addEventListener('pointerdown', (e) => e?.stopPropagation?.());
    shadow.addEventListener('click', (e) => e?.stopPropagation?.());
  }

  function createComposerBar({
    doc = document,
    win = typeof window !== 'undefined' ? window : null,
    hostId = 'ag-vario-composer',
    onOpenContext,
    onOpenCard
  } = {}) {
    const host = doc.createElement('div');
    host.setAttribute('data-ag-vario-composer', 'true');
    if (hostId) host.id = hostId;
    host.style.display = 'inline-flex';
    host.style.alignItems = 'center';
    host.style.flexShrink = '0';
    host.style.height = '24px';
    host.style.lineHeight = '1';
    const shadow = host.attachShadow({ mode: 'open' });
    attachShadowIsolation(shadow);

    shadow.innerHTML = `
      <style>${styles.SHARED_CSS}${styles.COMPOSER_CSS}</style>
      <div class="agv-comp-row" data-compact="false" data-fallback="false">
        <button type="button" class="agv-trigger" data-trigger="session" aria-expanded="false" title="Session stats">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.5 11.5L6 8l2.5 2.5L13.5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="agv-num" data-slot="session-tok">—</span>
        </button>
        <button type="button" class="agv-trigger" data-trigger="context" aria-expanded="false" title="Context window">
          <span data-slot="ctx-ring">${styles.buildSvgRing({ size: 16, strokeWidth: 1.85, fraction: 0, color: styles.COLORS.contextLevels.unknown })}</span>
          <span class="agv-num" data-slot="ctx-pct">—</span>
        </button>
        <button type="button" class="agv-trigger" data-trigger="subagents" aria-expanded="false" data-dim="true" title="Subagents">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2.5L13.5 5.5L8 8.5L2.5 5.5L8 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
            <path d="M2.5 8.5L8 11.5L13.5 8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="agv-num" data-slot="sub-badge">0</span>
        </button>
      </div>
      <div class="agv-popover" data-open="false" hidden></div>
    `;

    const rowEl = shadow.querySelector('.agv-comp-row');
    const popoverEl = shadow.querySelector('.agv-popover');
    const btnSession = shadow.querySelector('[data-trigger="session"]');
    const btnContext = shadow.querySelector('[data-trigger="context"]');
    const btnSubagents = shadow.querySelector('[data-trigger="subagents"]');
    const slotSessionTok = shadow.querySelector('[data-slot="session-tok"]');
    const slotCtxRing = shadow.querySelector('[data-slot="ctx-ring"]');
    const slotCtxPct = shadow.querySelector('[data-slot="ctx-pct"]');
    const slotSubBadge = shadow.querySelector('[data-slot="sub-badge"]');

    let openCard = null;
    let sessionData = null;
    let contextState = { data: null, loading: false, error: null };

    function syncExpandedAttrs() {
      btnSession.setAttribute('aria-expanded', String(openCard === 'session'));
      btnContext.setAttribute('aria-expanded', String(openCard === 'context'));
      btnSubagents.setAttribute('aria-expanded', String(openCard === 'subagents'));
    }

    function reposition() {
      if (!openCard || !popoverEl) return;
      const anchor =
        openCard === 'session' ? btnSession : openCard === 'context' ? btnContext : btnSubagents;
      const rect = anchor?.getBoundingClientRect?.();
      const vw = win?.innerWidth || 1200;
      const vh = win?.innerHeight || 800;
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      const cardW = 288;
      const left = Math.max(8, Math.min(vw - cardW - 8, rect.left));
      const spaceAbove = rect.top - 16;
      const spaceBelow = vh - rect.bottom - 16;
      popoverEl.style.left = `${Math.round(left)}px`;
      if (spaceAbove < 260 && spaceBelow > spaceAbove) {
        popoverEl.style.top = `${Math.round(Math.max(8, rect.bottom + 8))}px`;
        popoverEl.style.bottom = 'auto';
        popoverEl.style.maxHeight = `${Math.max(140, Math.min(vh - 72, Math.floor(spaceBelow)))}px`;
      } else {
        popoverEl.style.bottom = `${Math.round(Math.max(8, vh - rect.top + 8))}px`;
        popoverEl.style.top = 'auto';
        popoverEl.style.maxHeight = `${Math.max(140, Math.min(vh - 72, Math.floor(Math.max(spaceAbove, 140))))}px`;
      }
    }

    function renderSessionCard() {
      const main = sessionData?.main;
      if (!main) {
        return `<div class="agv-card"><div class="agv-card-head"><span class="agv-card-title">Session</span><span class="agv-card-sub">Ready</span></div><div class="agv-block agv-muted">No activity in this session yet</div></div>`;
      }
      const turnsLabel = `${main.turns} ${main.turns === 1 ? 'turn' : 'turns'} · ${main.steps} ${main.steps === 1 ? 'step' : 'steps'}`;
      const mainCostStr = styles.formatUsd(main.cost?.costUsd, { isPriced: main.cost?.priced });
      const totalCostStr = styles.formatUsd(sessionData.totalCost?.costUsd, {
        isPriced: sessionData.totalCost?.priced,
        hasUnpriced: sessionData.totalCost?.hasUnpriced
      });
      const subCount = sessionData.subagentSummary?.totalCount || 0;
      const hasSub = subCount > 0;
      const heroCostStr = hasSub ? totalCostStr : mainCostStr;
      const modelName =
        main.primaryModel?.displayNameWithEffort || main.primaryModel?.displayName || 'Unknown';

      const cacheTok = main.cacheReadTokens || 0;
      const inputTok = main.inputTokens || 0;
      const outputTok = main.outputTokens || 0;
      const sumTok = cacheTok + inputTok + outputTok;
      let wCache = 0;
      let wInput = 0;
      let wOutput = 0;
      if (sumTok > 0) {
        wOutput = outputTok > 0 ? Math.max(1.5, (outputTok / sumTok) * 100) : 0;
        const rem = Math.max(0, 100 - wOutput);
        const promptSum = cacheTok + inputTok;
        if (promptSum > 0) {
          wCache = (cacheTok / promptSum) * rem;
          wInput = (inputTok / promptSum) * rem;
        }
      }

      const speedStr = main.outputSpeedTps !== null ? `${main.outputSpeedTps.toFixed(0)} t/s` : '—';
      const perfDot = '<span class="agv-dot" style="background:rgba(125,184,232,0.58);"></span>';

      return `
        <div class="agv-card">
          <div class="agv-card-head">
            <span class="agv-card-title">Session</span>
          </div>
          <div class="agv-block-hero">
            <div class="agv-hero-top">
              <span style="display:inline-flex;align-items:baseline;">
                <span class="agv-hero-val agv-num">${styles.formatTokensOneDecimal(sessionData.totalTokens)}</span>
                <span class="agv-hero-unit">tokens</span>
              </span>
              <span class="agv-hero-cost">
                <span class="agv-est-tag">Est.</span>
                <span class="agv-hero-val agv-num">${styles.escapeHtml(heroCostStr)}</span>
              </span>
            </div>
            <div class="agv-hero-bot">
              <span class="agv-muted agv-num" style="white-space:nowrap;">${styles.escapeHtml(turnsLabel)}</span>
              <span class="agv-model-chip" title="${styles.escapeHtml(modelName)}">${styles.escapeHtml(modelName)}</span>
            </div>
          </div>
          <div class="agv-block">
            <div style="display:flex;align-items:center;justify-content:space-between;font-size:10.5px;margin-bottom:7px;">
              <span class="agv-muted">Token Breakdown</span>
              <span class="agv-ice agv-num" style="font-weight:600;">Hit ${styles.formatPercent(main.cacheHitRate, 1)}</span>
            </div>
            <div class="agv-stack-bar">
              <div style="width:${wCache.toFixed(2)}%;background:${styles.COLORS.iceBlue};"></div>
              <div style="width:${wInput.toFixed(2)}%;background:rgba(214,234,250,0.88);"></div>
              <div style="width:${wOutput.toFixed(2)}%;background:${styles.COLORS.contextLevels.orange};"></div>
            </div>
            <div class="agv-tri-row" style="margin-top:8px;">
              <div class="agv-tri-cell">
                <div class="agv-tri-lbl"><span class="agv-dot" style="background:${styles.COLORS.iceBlue};"></span><span>Cache</span></div>
                <div class="agv-tri-val agv-num">${styles.formatTokensOneDecimal(cacheTok)}</div>
              </div>
              <div class="agv-tri-cell">
                <div class="agv-tri-lbl"><span class="agv-dot" style="background:rgba(214,234,250,0.90);"></span><span>Input</span></div>
                <div class="agv-tri-val agv-num">${styles.formatTokensOneDecimal(inputTok)}</div>
              </div>
              <div class="agv-tri-cell">
                <div class="agv-tri-lbl"><span class="agv-dot" style="background:${styles.COLORS.contextLevels.orange};"></span><span>Output</span></div>
                <div class="agv-tri-val agv-num">${styles.formatTokensOneDecimal(outputTok)}</div>
              </div>
            </div>
          </div>
          <div class="agv-block">
            <div class="agv-tri-row">
              <div class="agv-tri-cell">
                <div class="agv-tri-lbl">${perfDot}<span>Avg TTFT</span></div>
                <div class="agv-tri-val agv-num">${styles.formatDurationCompact(main.avgTtftMs)}</div>
              </div>
              <div class="agv-tri-cell">
                <div class="agv-tri-lbl">${perfDot}<span>Speed</span></div>
                <div class="agv-tri-val agv-num">${styles.escapeHtml(speedStr)}</div>
              </div>
              <div class="agv-tri-cell">
                <div class="agv-tri-lbl">${perfDot}<span>Model Time</span></div>
                <div class="agv-tri-val agv-num">${styles.formatDurationCompact(main.modelTimeMs)}</div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    function formatCompactionParts(compaction) {
      if (!compaction || !compaction.compacted || !compaction.count) return null;
      const left = `Compacted ${compaction.count}×`;
      const hasDelta = compaction.lastBeforeTokens > 0 && compaction.lastAfterTokens > 0;
      const right = hasDelta
        ? `${compaction.count > 1 ? 'Last ' : ''}${styles.formatTokensOneDecimal(compaction.lastBeforeTokens)} → ${styles.formatTokensOneDecimal(compaction.lastAfterTokens)}`
        : '';
      const ringText = compaction.count > 9 ? '9+' : String(compaction.count);
      const tooltip = right ? `${left} · ${right}` : left;
      return { left, right, ringText, tooltip };
    }

    function renderContextTrigger(wl) {
      const compParts = formatCompactionParts(sessionData?.main?.compaction);
      const color = styles.COLORS.contextLevels[wl?.level || 'unknown'];
      slotCtxRing.innerHTML = styles.buildSvgRing({
        size: 16,
        strokeWidth: 1.85,
        fraction: wl?.ratio ?? 0,
        color,
        centerText: compParts ? compParts.ringText : '',
        centerColor: 'rgba(242, 244, 248, 0.92)'
      });
      const pctTxt = styles.formatContextPercentOneDecimal(wl);
      slotCtxPct.textContent =
        pctTxt || (wl?.usedTokens > 0 ? styles.formatTokensOneDecimal(wl.usedTokens) : '—');
      btnContext.style.color = wl?.level && wl.level !== 'unknown' ? color : '';
      btnContext.setAttribute('data-compacted', String(Boolean(compParts)));
      btnContext.title = compParts
        ? `Context window · ${compParts.tooltip}`
        : 'Context window';
    }

    function renderContextCard() {
      const ctx = contextState.data;
      const fallbackMain = sessionData?.main;
      const wl = ctx?.waterline || fallbackMain?.waterline;
      const usedStr = wl ? styles.formatTokensOneDecimal(wl.usedTokens) : '—';
      const limitStr = wl?.contextLimit ? styles.formatTokensOneDecimal(wl.contextLimit) : null;
      const pctStr = styles.formatContextPercentOneDecimal(wl);
      const headerRight = limitStr ? (pctStr ? `${usedStr} / ${limitStr} · ${pctStr}` : `${usedStr} / ${limitStr}`) : usedStr;
      const compParts = formatCompactionParts(fallbackMain?.compaction);
      const compBannerHtml = compParts
        ? `<div class="agv-compact-banner agv-num"><span class="agv-compact-left"><span class="agv-dot" style="background:${styles.COLORS.iceBlue};"></span><span>${styles.escapeHtml(compParts.left)}</span></span>${compParts.right ? `<span class="agv-compact-right">${styles.escapeHtml(compParts.right)}</span>` : ''}</div>`
        : '';

      if (!ctx && !contextState.loading && !contextState.error && !fallbackMain) {
        return `<div class="agv-card"><div class="agv-card-head"><span class="agv-card-title">Context</span><span class="agv-card-sub agv-num">${styles.escapeHtml(headerRight)}</span></div><div class="agv-block agv-muted">No context data yet</div></div>`;
      }
      if (contextState.loading && !ctx) {
        return `<div class="agv-card"><div class="agv-card-head"><span class="agv-card-title">Context</span><span class="agv-card-sub agv-num">${styles.escapeHtml(headerRight)}</span></div>${compBannerHtml}<div class="agv-block agv-muted">Calculating breakdown…</div></div>`;
      }
      if (contextState.error && !ctx) {
        return `<div class="agv-card"><div class="agv-card-head"><span class="agv-card-title">Context</span><span class="agv-card-sub agv-num">${styles.escapeHtml(headerRight)}</span></div>${compBannerHtml}<div class="agv-block agv-muted">${styles.escapeHtml(contextState.error)}</div></div>`;
      }
      if (!ctx || !ctx.breakdownAvailable) {
        return `<div class="agv-card"><div class="agv-card-head"><span class="agv-card-title">Context</span><span class="agv-card-sub agv-num">${styles.escapeHtml(headerRight)}</span></div>${compBannerHtml}<div class="agv-block agv-muted">Breakdown unavailable</div></div>`;
      }

      const rows = ctx.categories
        .map((cat) => {
          const pct = Number.isFinite(cat.percent) ? cat.percent : 0;
          const barW = Math.max(0, Math.min(100, pct));
          return `
            <div>
              <div class="agv-ctx-head">
                <span>${styles.escapeHtml(cat.label)}</span>
                <span class="agv-ctx-meta agv-num">
                  <span class="agv-ctx-tok">${styles.formatTokensOneDecimal(cat.tokens)}</span>
                  <span class="agv-ctx-sep">·</span>
                  <span class="agv-ctx-pct">${pct.toFixed(1)}%</span>
                </span>
              </div>
              <div class="agv-bar-track"><div class="agv-bar-fill" style="width:${barW}%"></div></div>
            </div>
          `;
        })
        .join('');

      return `
        <div class="agv-card">
          <div class="agv-card-head">
            <span class="agv-card-title">Context</span>
            <span class="agv-card-sub agv-num">${styles.escapeHtml(headerRight)}</span>
          </div>
          ${compBannerHtml}
          <div class="agv-block agv-ctx-list">${rows}</div>
        </div>
      `;
    }

    function renderSubagentsCard() {
      const summary = sessionData?.subagentSummary;
      const items = summary?.items || [];
      const subHead = summary ? `${summary.runningCount} active · ${summary.totalCount} total` : '0 total';
      if (!items.length) {
        return `
          <div class="agv-card">
            <div class="agv-card-head">
              <span class="agv-card-title">Subagents</span>
              <span class="agv-card-sub agv-num">${subHead}</span>
            </div>
            <div class="agv-block agv-muted">No subagents in this session</div>
          </div>
        `;
      }

      const listHtml = items
        .map((item) => {
          const dotColor = styles.COLORS.statusColors[item.status] || styles.COLORS.statusColors.Done;
          const ctxTxt = item.waterline?.percent !== null && item.waterline?.percent !== undefined
            ? `${styles.formatTokensCompact(item.currentContextTokens)} · ${item.waterline.percent}%`
            : styles.formatTokensCompact(item.currentContextTokens);
          return `
            <div class="agv-sub-item">
              <div class="agv-sub-top">
                <span class="agv-sub-title" title="${styles.escapeHtml(item.title)}">${styles.escapeHtml(item.title)}</span>
                <span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;flex-shrink:0;">
                  <span class="agv-dot" style="background:${dotColor}"></span>
                  <span>${styles.escapeHtml(item.status)}</span>
                </span>
              </div>
              <div class="agv-sub-meta">
                <span>${styles.escapeHtml(item.modelDisplayName)}</span>
                <span class="agv-num">Ctx ${styles.escapeHtml(ctxTxt)}</span>
              </div>
            </div>
          `;
        })
        .join('');

      return `
        <div class="agv-card">
          <div class="agv-card-head">
            <span class="agv-card-title">Subagents</span>
            <span class="agv-card-sub agv-num">${subHead}</span>
          </div>
          <div class="agv-sub-list">${listHtml}</div>
        </div>
      `;
    }

    function renderPopover() {
      if (!openCard) {
        popoverEl.setAttribute('data-open', 'false');
        popoverEl.hidden = true;
        popoverEl.innerHTML = '';
        syncExpandedAttrs();
        return;
      }
      const prevScroll = popoverEl.scrollTop || 0;
      if (openCard === 'session') popoverEl.innerHTML = renderSessionCard();
      else if (openCard === 'context') popoverEl.innerHTML = renderContextCard();
      else if (openCard === 'subagents') popoverEl.innerHTML = renderSubagentsCard();
      popoverEl.hidden = false;
      popoverEl.setAttribute('data-open', 'true');
      popoverEl.scrollTop = prevScroll;
      syncExpandedAttrs();
      reposition();
    }

    function openCardNamed(name) {
      if (openCard === name) {
        close();
        return;
      }
      openCard = name;
      if (typeof onOpenCard === 'function') onOpenCard(name);
      renderPopover();
      if (name === 'context' && typeof onOpenContext === 'function') {
        onOpenContext();
      }
    }

    function close() {
      if (!openCard) return;
      openCard = null;
      renderPopover();
    }

    btnSession.addEventListener('click', () => openCardNamed('session'));
    btnContext.addEventListener('click', () => openCardNamed('context'));
    btnSubagents.addEventListener('click', () => openCardNamed('subagents'));

    function updateSession(data) {
      sessionData = data || null;
      if (!sessionData) {
        contextState = { data: null, loading: false, error: null };
      }
      const main = sessionData?.main;
      slotSessionTok.textContent = main ? styles.formatTokensOneDecimal(sessionData.totalTokens) : '—';

      renderContextTrigger(main?.waterline);

      const sub = sessionData?.subagentSummary;
      slotSubBadge.textContent = sub ? sub.badgeText : '0';
      btnSubagents.setAttribute('data-dim', String(!sub || sub.totalCount === 0));
      btnSubagents.setAttribute('data-highlight', String(Boolean(sub && sub.hasRunning)));

      if (openCard) renderPopover();
    }

    function updateContext(data, { loading = false, error = null, reset = false } = {}) {
      contextState = {
        data: reset ? (data || null) : (data || contextState.data),
        loading,
        error
      };
      if (data?.waterline) {
        renderContextTrigger(data.waterline);
      }
      if (openCard === 'context') renderPopover();
    }

    return {
      host,
      shadow,
      updateSession,
      updateContext,
      setCompact: (flag) => rowEl.setAttribute('data-compact', String(Boolean(flag))),
      setFallbackRow: (flag) => rowEl.setAttribute('data-fallback', String(Boolean(flag))),
      setFocused: (flag) => rowEl.setAttribute('data-focused', String(Boolean(flag))),
      openCard: openCardNamed,
      close,
      getOpenCard: () => openCard,
      reposition,
      dispose: () => {
        close();
        host.remove();
      }
    };
  }

  return {
    createComposerBar,
    attachShadowIsolation
  };
});

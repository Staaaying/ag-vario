(function (root, factory) {
  const mod =
    typeof module === 'object' && module.exports
      ? { styles: require('./styles'), composerBar: require('./composer-bar') }
      : { styles: root.__AGVarioModules.styles, composerBar: root.__AGVarioModules.composerBar };
  const api = factory(mod.styles, mod.composerBar);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  const mods = (root.__AGVarioModules = root.__AGVarioModules || {});
  mods.topbarBar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (styles, composerBar) {
  'use strict';

  function createTopbarBar({
    doc = document,
    win = typeof window !== 'undefined' ? window : null,
    onOpenPanel,
    onRefreshQuota,
    onRequestUsage
  } = {}) {
    const host = doc.createElement('div');
    host.id = 'ag-vario-topbar';
    host.style.flexShrink = '0';
    const shadow = host.attachShadow({ mode: 'open' });
    composerBar.attachShadowIsolation(shadow);

    shadow.innerHTML = `
      <style>${styles.SHARED_CSS}${styles.TOPBAR_CSS}</style>
      <div class="agv-pills" data-placement="after-title">
        <button type="button" class="agv-pill" data-trigger="quota" aria-expanded="false" title="Quota">
          <span class="agv-ring-pair">
            <span data-slot="ring-5h">${styles.buildSvgRing({ size: 20, strokeWidth: 2.2, fraction: 0 })}</span>
            <span class="agv-ring-stack">
              <span class="agv-ring-lbl">5h</span>
              <span class="agv-ring-pct agv-num" data-slot="pct-5h">—</span>
            </span>
          </span>
          <span class="agv-pill-sep"></span>
          <span class="agv-ring-pair">
            <span data-slot="ring-7d">${styles.buildSvgRing({ size: 20, strokeWidth: 2.2, fraction: 0 })}</span>
            <span class="agv-ring-stack">
              <span class="agv-ring-lbl">7d</span>
              <span class="agv-ring-pct agv-num" data-slot="pct-7d">—</span>
            </span>
          </span>
        </button>
        <button type="button" class="agv-pill" data-trigger="usage" aria-expanded="false" title="Usage">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2.5" y="9" width="2.5" height="4.5" rx="0.8" fill="${styles.COLORS.iceBlue}" fill-opacity="0.65"/>
            <rect x="6.75" y="5.5" width="2.5" height="8" rx="0.8" fill="${styles.COLORS.iceBlue}" fill-opacity="0.85"/>
            <rect x="11" y="2.5" width="2.5" height="11" rx="0.8" fill="${styles.COLORS.iceBlue}"/>
          </svg>
          <span class="agv-ring-stack">
            <span class="agv-ring-lbl">Today</span>
            <span class="agv-ring-pct agv-num" data-slot="today-tok">—</span>
          </span>
        </button>
      </div>
      <div class="agv-popover" data-open="false" hidden></div>
    `;

    const pillsEl = shadow.querySelector('.agv-pills');
    const btnQuota = shadow.querySelector('[data-trigger="quota"]');
    const btnUsage = shadow.querySelector('[data-trigger="usage"]');
    const slotRing5h = shadow.querySelector('[data-slot="ring-5h"]');
    const slotPct5h = shadow.querySelector('[data-slot="pct-5h"]');
    const slotRing7d = shadow.querySelector('[data-slot="ring-7d"]');
    const slotPct7d = shadow.querySelector('[data-slot="pct-7d"]');
    const slotTodayTok = shadow.querySelector('[data-slot="today-tok"]');
    const popoverEl = shadow.querySelector('.agv-popover');

    let placement = 'after-title';
    let openPanel = null;
    let period = '7D';
    let selectedDateKey = null;
    let hoveredDateKey = null;

    let quotaState = { data: null, loading: false, error: null };
    let todayData = null;
    let usageState = { data: null, profile: null, loading: false, error: null };

    function setPlacement(nextPlacement) {
      placement = nextPlacement === 'right' ? 'right' : 'after-title';
      if (pillsEl) pillsEl.setAttribute('data-placement', placement);
    }

    function syncExpandedAttrs() {
      btnQuota.setAttribute('aria-expanded', String(openPanel === 'quota'));
      btnUsage.setAttribute('aria-expanded', String(openPanel === 'usage'));
    }

    function reposition() {
      if (!openPanel || !popoverEl) return;
      const anchor = openPanel === 'quota' ? btnQuota : btnUsage;
      const rect = anchor?.getBoundingClientRect?.();
      const vw = win?.innerWidth || 1200;
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      const panelW = openPanel === 'quota' ? 338 : 420;
      const desiredLeft = placement === 'after-title' ? rect.left : rect.right - panelW;
      const left = Math.max(8, Math.min(vw - panelW - 8, desiredLeft));
      const top = Math.max(8, rect.bottom + 8);
      popoverEl.style.left = `${Math.round(left)}px`;
      popoverEl.style.top = `${Math.round(top)}px`;
      popoverEl.style.bottom = 'auto';
    }

    function renderQuotaPanel() {
      const q = quotaState.data;
      const tierLabel = q?.profile?.planFullName || q?.profile?.planBadge;
      const planBadge = tierLabel
        ? `<span class="agv-badge">${styles.escapeHtml(tierLabel)}</span>`
        : '';
      const updatedTxt = q?.updatedAtMs ? `Updated ${styles.formatTimeHHMM(q.updatedAtMs)}` : 'Updated —';

      if (quotaState.loading && !q) {
        return `<div class="agv-quota-panel"><div class="agv-panel-head"><div class="agv-head-left"><strong>Quota</strong></div><span class="agv-muted">Loading…</span></div></div>`;
      }
      if (quotaState.error && !q) {
        return `<div class="agv-quota-panel"><div class="agv-panel-head"><div class="agv-head-left"><strong>Quota</strong></div><button type="button" class="agv-icon-btn" data-action="refresh-quota" title="Refresh">↻</button></div><div class="agv-block agv-muted">${styles.escapeHtml(quotaState.error)}</div></div>`;
      }

      const toneClassMap = {
        ok: 'agv-ok',
        ice: 'agv-ice',
        warn: 'agv-warn',
        risk: 'agv-risk',
        muted: 'agv-muted'
      };

      const poolsHtml = (q?.pools || []).length
        ? q.pools
            .map((pool) => {
              const winList = [pool.bucket5h, pool.bucket7d].filter(Boolean);
              const bars = (winList.length ? winList : pool.buckets)
                .map((b) => {
                  const pct = b.percent !== null && b.percent !== undefined ? b.percent : null;
                  const fillW = pct !== null ? Math.max(0, Math.min(100, pct)) : 0;
                  const pctStr = pct !== null ? `${pct}%` : '—';
                  const resetWord = b.countdown && b.countdown !== 'Resetting' ? 'Resets in' : '';
                  const resetTime = b.countdown || '—';
                  const resetPhraseHtml = resetWord
                    ? `<span class="agv-q-phrase"><span class="agv-q-word">${styles.escapeHtml(resetWord)}</span><span class="agv-q-time">${styles.escapeHtml(resetTime)}</span></span>`
                    : `<span class="agv-q-phrase"><span class="agv-q-time">${styles.escapeHtml(resetTime)}</span></span>`;
                  return `
                    <div class="agv-win-row">
                      <div class="agv-win-top">
                        <span class="agv-muted">${styles.escapeHtml(b.label)}</span>
                        <span class="agv-quota-meta agv-num">
                          <span class="agv-q-pct">${pctStr}</span>
                          <span class="agv-q-sep">·</span>
                          ${resetPhraseHtml}
                        </span>
                      </div>
                      <div class="agv-bar-track"><div class="agv-bar-fill" style="width:${fillW}%"></div></div>
                    </div>
                  `;
                })
                .join('');

              const lastResetStr = pool.weeklyCycle?.lastResetAtMs
                ? styles.formatMonthDayTime(pool.weeklyCycle.lastResetAtMs)
                : '—';

              let rightFootHtml = '';
              if (pool.poolKey === 'claude_3p') {
                rightFootHtml = '<span class="agv-anthropic-txt">Fuck Anthropic</span>';
              } else if (String(pool.poolKey || '').startsWith('gemini') && pool.weeklyCycle?.pace) {
                const toneCls = toneClassMap[pool.weeklyCycle.pace.tone] || 'agv-muted';
                rightFootHtml = `<span class="${toneCls}" style="font-weight:500;">${styles.escapeHtml(pool.weeklyCycle.pace.label)}</span>`;
              }

              const footHtml =
                pool.bucket7d || pool.weeklyCycle || pool.poolKey === 'claude_3p'
                  ? `<div class="agv-pool-foot agv-num">
                       <span class="agv-muted">Last reset: ${styles.escapeHtml(lastResetStr)}</span>
                       ${rightFootHtml}
                     </div>`
                  : '';

              return `
                <div class="agv-block agv-pool-card">
                  <div class="agv-pool-title">${styles.escapeHtml(pool.title)}</div>
                  ${bars || '<div class="agv-muted">No window data</div>'}
                  ${footHtml}
                </div>
              `;
            })
            .join('')
        : '<div class="agv-block agv-muted">No quota pools reported</div>';

      return `
        <div class="agv-quota-panel">
          <div class="agv-panel-head">
            <div class="agv-head-left">
              <strong>Quota</strong>
              ${planBadge}
            </div>
            <div class="agv-head-right">
              <span class="agv-muted agv-num" style="font-size:10.5px;">${styles.escapeHtml(updatedTxt)}</span>
              <button type="button" class="agv-icon-btn" data-action="refresh-quota" title="Refresh quota">↻</button>
            </div>
          </div>
          ${poolsHtml}
        </div>
      `;
    }

    function renderHeatmapDetailLine(heatmap) {
      const targetKey = hoveredDateKey || selectedDateKey;
      if (!targetKey) return '<span class="agv-dim">Hover a day · click to filter</span>';
      const day = (heatmap || []).find((d) => d.dateKey === targetKey);
      if (!day) return '';
      const costStr = day.totalTokens === 0
        ? '$0.00'
        : styles.formatUsd(day.costUsd, { isPriced: day.costUsd !== null, hasUnpriced: day.hasUnpriced });
      return `<span class="agv-num">${styles.formatDateShort(day.dateKey)} · ${styles.formatTokensCompact(day.totalTokens)} tokens · ${styles.escapeHtml(costStr)}</span>`;
    }

    function renderUsagePanel() {
      const report = usageState.data;
      const profile = usageState.profile || quotaState.data?.profile || {};
      const name = profile.name || 'Account';
      const email = profile.email || '';
      const tierLabel = profile.planFullName || profile.planBadge;
      const badge = tierLabel ? `<span class="agv-badge">${styles.escapeHtml(tierLabel)}</span>` : '';
      const avatarHtml = profile.avatarDataUrl
        ? `<img class="agv-avatar" src="${styles.escapeHtml(profile.avatarDataUrl)}" alt="avatar"/>`
        : `<span class="agv-avatar">${styles.escapeHtml(profile.initials || '?')}</span>`;

      const PERIOD_LABELS = { '7D': '7 Days', '30D': '30 Days', ALL: 'All' };
      const segHtml = ['7D', '30D', 'ALL']
        .map(
          (p) =>
            `<button type="button" class="agv-seg-btn" data-period="${p}" data-active="${String(period === p)}">${PERIOD_LABELS[p]}</button>`
        )
        .join('');

      const headerHtml = `
        <div class="agv-profile">
          <div class="agv-profile-left">
            ${avatarHtml}
            <div style="min-width:0;">
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="agv-profile-name">${styles.escapeHtml(name)}</span>
                ${badge}
              </div>
              <div class="agv-profile-mail">${styles.escapeHtml(email || 'Antigravity Desktop')}</div>
            </div>
          </div>
          <div class="agv-seg">${segHtml}</div>
        </div>
      `;

      if (usageState.loading && !report) {
        return `<div class="agv-usage-panel">${headerHtml}<div class="agv-block agv-muted">Scanning local usage…</div></div>`;
      }
      if (usageState.error && !report) {
        return `<div class="agv-usage-panel">${headerHtml}<div class="agv-block agv-muted">${styles.escapeHtml(usageState.error)}</div></div>`;
      }
      if (!report) {
        return `<div class="agv-usage-panel">${headerHtml}<div class="agv-block agv-muted">No usage data</div></div>`;
      }

      const sum = report.summary || {};
      const dailyAvgVal = sum.dailyAvgTokens !== undefined ? sum.dailyAvgTokens : sum.avg7dTokens;
      const dailyTimeVal = sum.activeDailyTimeMs !== undefined ? sum.activeDailyTimeMs : sum.dailyTimeMs;
      const summaryHtml = `
        <div class="agv-summary-5">
          <div class="agv-stat-cell"><div class="agv-stat-lbl">Tokens</div><div class="agv-stat-val agv-num">${styles.formatTokensOneDecimal(sum.tokens)}</div></div>
          <div class="agv-stat-cell"><div class="agv-stat-lbl">Est. Cost</div><div class="agv-stat-val agv-num">${styles.escapeHtml(styles.formatUsd(sum.estUsd, { isPriced: sum.estUsd !== null, hasUnpriced: sum.hasUnpriced }))}</div></div>
          <div class="agv-stat-cell"><div class="agv-stat-lbl">Daily Avg</div><div class="agv-stat-val agv-num">${styles.formatTokensOneDecimal(dailyAvgVal)}</div></div>
          <div class="agv-stat-cell"><div class="agv-stat-lbl">Per Chat</div><div class="agv-stat-val agv-num">${styles.formatTokensOneDecimal(sum.avgPerChatTokens)}</div></div>
          <div class="agv-stat-cell"><div class="agv-stat-lbl">Daily Time</div><div class="agv-stat-val agv-num">${styles.formatDurationHm(dailyTimeVal)}</div></div>
        </div>
      `;

      const dotsHtml = (report.heatmap || [])
        .map((d) => {
          const color = styles.COLORS.heatmapRamp[d.level] || styles.COLORS.heatmapRamp[0];
          const isSel = selectedDateKey === d.dateKey;
          return `<button type="button" class="agv-heat-dot" data-date="${d.dateKey}" data-selected="${String(isSel)}" style="background:${color}" title="${d.dateKey}"></button>`;
        })
        .join('');

      const maxModelTok = (report.byModel || []).reduce((m, r) => Math.max(m, r.totalTokens), 0);
      const modelsHtml = (report.byModel || []).length
        ? report.byModel
            .map((m) => {
              const barW = maxModelTok > 0 ? Math.max(3, Math.round((m.totalTokens / maxModelTok) * 100)) : 0;
              const usdStr = styles.formatUsd(m.costUsd, { isPriced: m.isPriced });
              return `
                <div class="agv-model-row">
                  <div class="agv-model-top">
                    <span>${styles.escapeHtml(m.displayName)}</span>
                    <span class="agv-usage-meta agv-num">
                      <span class="agv-u-tok">${styles.formatTokensOneDecimal(m.totalTokens)}</span>
                      <span class="agv-u-sep">·</span>
                      <span class="agv-u-usd">${styles.escapeHtml(usdStr)}</span>
                    </span>
                  </div>
                  <div class="agv-bar-track"><div class="agv-bar-fill" style="width:${barW}%"></div></div>
                </div>
              `;
            })
            .join('')
        : '<div class="agv-muted">No model activity in period</div>';

      const topHtml = (report.topSessions || []).length
        ? report.topSessions
            .map((t) => {
              const subTag = t.subagentCount > 0 ? ` · +${t.subagentCount} sub` : '';
              const usdStr = styles.formatUsd(t.costUsd, { isPriced: t.isPriced, hasUnpriced: t.hasUnpriced });
              return `
                <div class="agv-top-item">
                  <div class="agv-top-title" title="${styles.escapeHtml(t.title)}">${styles.escapeHtml(t.title)}</div>
                  <div class="agv-top-row agv-muted">
                    <span>${styles.escapeHtml(t.primaryModel?.displayName || 'Unknown')}${subTag}</span>
                    <span class="agv-usage-meta agv-num">
                      <span class="agv-u-tok">${styles.formatTokensOneDecimal(t.totalTokens)}</span>
                      <span class="agv-u-sep">·</span>
                      <span class="agv-u-usd">${styles.escapeHtml(usdStr)}</span>
                    </span>
                  </div>
                </div>
              `;
            })
            .join('')
        : '<div class="agv-muted">No sessions in selection</div>';

      const dayFilterPill = selectedDateKey
        ? `<span class="agv-badge" style="gap:4px;">${styles.formatDateShort(selectedDateKey)} <button type="button" data-action="clear-day" style="font-size:10px;color:inherit;">×</button></span>`
        : '';

      return `
        <div class="agv-usage-panel">
          ${headerHtml}
          ${summaryHtml}
          <div class="agv-block">
            <div class="agv-sec-head">
              <span>Token Activity</span>
              <span data-slot="heat-detail" style="font-weight:400;font-size:10.5px;">${renderHeatmapDetailLine(report.heatmap)}</span>
            </div>
            <div class="agv-dots">${dotsHtml}</div>
          </div>
          <div class="agv-block">
            <div class="agv-sec-head"><span>Model Breakdown</span><span style="display:inline-flex;align-items:center;gap:5px;">${dayFilterPill}<span class="agv-est-tag">Est. Cost (USD)</span></span></div>
            <div class="agv-model-list">${modelsHtml}</div>
          </div>
          <div class="agv-block">
            <div class="agv-sec-head"><span>Top 3 Sessions</span>${dayFilterPill}</div>
            <div class="agv-top-list">${topHtml}</div>
          </div>
        </div>
      `;
    }

    function renderPopover() {
      if (!openPanel) {
        popoverEl.setAttribute('data-open', 'false');
        popoverEl.hidden = true;
        popoverEl.innerHTML = '';
        syncExpandedAttrs();
        return;
      }
      const prevScroll = popoverEl.scrollTop || 0;
      popoverEl.innerHTML = openPanel === 'quota' ? renderQuotaPanel() : renderUsagePanel();
      popoverEl.hidden = false;
      popoverEl.setAttribute('data-open', 'true');
      popoverEl.scrollTop = prevScroll;
      syncExpandedAttrs();
      reposition();
    }

    function openPanelNamed(name) {
      if (openPanel === name) {
        close();
        return;
      }
      openPanel = name;
      if (typeof onOpenPanel === 'function') onOpenPanel(name);
      renderPopover();
      if (name === 'usage' && typeof onRequestUsage === 'function') {
        onRequestUsage({ period, selectedDateKey });
      }
    }

    function close() {
      if (!openPanel) return;
      openPanel = null;
      hoveredDateKey = null;
      renderPopover();
    }

    btnQuota.addEventListener('click', () => openPanelNamed('quota'));
    btnUsage.addEventListener('click', () => openPanelNamed('usage'));

    popoverEl.addEventListener('click', (e) => {
      const target = e?.target;
      const el = target && typeof target.closest === 'function' ? target : target?.parentElement;
      if (!el) return;

      const refreshBtn = el.closest('[data-action="refresh-quota"]');
      if (refreshBtn && typeof onRefreshQuota === 'function') {
        onRefreshQuota();
        return;
      }

      const periodBtn = el.closest('[data-period]');
      if (periodBtn) {
        const nextPeriod = periodBtn.getAttribute('data-period');
        if (nextPeriod && nextPeriod !== period) {
          period = nextPeriod;
          selectedDateKey = null;
          hoveredDateKey = null;
          if (typeof onRequestUsage === 'function') {
            onRequestUsage({ period, selectedDateKey: null });
          }
          renderPopover();
        }
        return;
      }

      const clearBtn = el.closest('[data-action="clear-day"]');
      if (clearBtn) {
        selectedDateKey = null;
        hoveredDateKey = null;
        if (typeof onRequestUsage === 'function') {
          onRequestUsage({ period, selectedDateKey: null });
        }
        renderPopover();
        return;
      }

      const dotBtn = el.closest('.agv-heat-dot');
      if (dotBtn) {
        const dk = dotBtn.getAttribute('data-date');
        const nextSelected = selectedDateKey === dk ? null : dk;
        selectedDateKey = nextSelected;
        if (nextSelected && period === '7D') {
          const hm = usageState.data?.heatmap || [];
          const sevenDayStart = hm.length >= 7 ? hm[hm.length - 7]?.dateKey : null;
          if (sevenDayStart && nextSelected < sevenDayStart) {
            period = '30D';
          }
        }
        if (typeof onRequestUsage === 'function') {
          onRequestUsage({ period, selectedDateKey });
        }
        renderPopover();
      }
    });

    popoverEl.addEventListener('mouseover', (e) => {
      if (openPanel !== 'usage') return;
      const target = e?.target;
      const dotBtn = target?.closest?.('.agv-heat-dot');
      if (!dotBtn) return;
      const dk = dotBtn.getAttribute('data-date');
      if (dk && dk !== hoveredDateKey) {
        hoveredDateKey = dk;
        const detailEl = popoverEl.querySelector('[data-slot="heat-detail"]');
        if (detailEl) detailEl.innerHTML = renderHeatmapDetailLine(usageState.data?.heatmap);
      }
    });

    popoverEl.addEventListener('mouseout', (e) => {
      if (openPanel !== 'usage' || !hoveredDateKey) return;
      if (!e?.relatedTarget?.closest?.('.agv-dots')) {
        hoveredDateKey = null;
        const detailEl = popoverEl.querySelector('[data-slot="heat-detail"]');
        if (detailEl) detailEl.innerHTML = renderHeatmapDetailLine(usageState.data?.heatmap);
      }
    });

    function updateQuota(snap, { loading = false, error = null } = {}) {
      quotaState = { data: snap || quotaState.data, loading, error };
      const w5 = quotaState.data?.summaryRings?.window5h || null;
      const w7 = quotaState.data?.summaryRings?.window7d || null;

      slotRing5h.innerHTML = styles.buildSvgRing({
        size: 20,
        strokeWidth: 2.2,
        fraction: w5 ? w5.remainingFraction : 0,
        color: styles.COLORS.iceBlue
      });
      slotPct5h.textContent = w5 && w5.percent !== null ? `${w5.percent}%` : '—';

      slotRing7d.innerHTML = styles.buildSvgRing({
        size: 20,
        strokeWidth: 2.2,
        fraction: w7 ? w7.remainingFraction : 0,
        color: styles.COLORS.iceBlue
      });
      slotPct7d.textContent = w7 && w7.percent !== null ? `${w7.percent}%` : '—';

      if (openPanel === 'quota' || openPanel === 'usage') renderPopover();
    }

    function updateToday(today) {
      todayData = today || null;
      slotTodayTok.textContent = todayData ? styles.formatTokensCompact(todayData.totalTokens) : '—';
    }

    function updateUsage(report, { profile = null, loading = false, error = null } = {}) {
      usageState = {
        data: report || usageState.data,
        profile: profile || usageState.profile,
        loading,
        error
      };
      if (report?.today) updateToday(report.today);
      if (openPanel === 'usage') renderPopover();
    }

    return {
      host,
      shadow,
      setPlacement,
      updateQuota,
      updateToday,
      updateUsage,
      openPanel: openPanelNamed,
      close,
      getOpenPanel: () => openPanel,
      getState: () => ({ period, selectedDateKey }),
      reposition,
      dispose: () => {
        close();
        host.remove();
      }
    };
  }

  return {
    createTopbarBar
  };
});

(function (root, factory) {
  const mod =
    typeof module === 'object' && module.exports
      ? {
          styles: require('./styles'),
          composerBar: require('./composer-bar'),
          topbarBar: require('./topbar-bar')
        }
      : {
          styles: root.__AGVarioModules.styles,
          composerBar: root.__AGVarioModules.composerBar,
          topbarBar: root.__AGVarioModules.topbarBar
        };
  const api = factory(mod.styles, mod.composerBar, mod.topbarBar);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  const mods = (root.__AGVarioModules = root.__AGVarioModules || {});
  mods.mount = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (styles, composerBar, topbarBar) {
  'use strict';

  /**
   * Dual-zone DOM mounter for Antigravity v2.34.0.
   *
   * MIT Attribution: Split-pane URL UUID extraction and titlebar/model-selector
   * anchor conventions reference `antigravity-context-viewer`
   * (Copyright (c) 2026 Antigravity Context Viewer Contributors, MIT License).
   */

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const QUOTA_REFRESH_MS = 4 * 60 * 1000;
  const SESSION_REFRESH_MS = 8 * 1000;
  const UNFOCUSED_REFRESH_EVERY = 3;
  const LIVENESS_CHECK_MS = 2500;

  function parseConversationIdsFromUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return { ids: [], focusedId: null };
    try {
      const url = new URL(rawUrl, 'http://127.0.0.1');
      const m = url.pathname.match(/\/c\/([^/?#]+)/);
      if (!m) return { ids: [], focusedId: null };
      const decoded = decodeURIComponent(m[1]);
      const ids = decoded
        .split('+')
        .map((s) => s.trim())
        .filter((s) => UUID_RE.test(s));
      if (!ids.length) return { ids: [], focusedId: null };

      const focused = (url.searchParams.get('focused') || '').trim();
      const focusedId = focused && ids.includes(focused) ? focused : null;
      return { ids, focusedId };
    } catch {
      return { ids: [], focusedId: null };
    }
  }

  function parseActiveConversationFromUrl(rawUrl) {
    const { ids, focusedId } = parseConversationIdsFromUrl(rawUrl);
    return focusedId || ids[0] || null;
  }

  function isComposerHostEl(el) {
    return Boolean(el && (el.id === 'ag-vario-composer' || el.getAttribute?.('data-ag-vario-composer') === 'true'));
  }

  function parseContextWindowHint(raw) {
    if (!raw) return null;
    const s = String(raw).trim().toUpperCase();
    if (!s) return null;
    const m = s.match(/^([\d.]+)\s*([MK])?$/);
    if (!m) return null;
    const val = Number(m[1]);
    if (!Number.isFinite(val) || val <= 0) return null;
    if (m[2] === 'M') return Math.round(val * 1000000);
    if (m[2] === 'K') return Math.round(val * 1000);
    return Math.round(val);
  }

  function extractModelHint(trigger) {
    if (!trigger) return null;
    const aria = trigger.getAttribute?.('aria-label') || '';
    const m = aria.match(/current:\s*(.+)$/i);
    if (m && m[1]) return m[1].trim();
    const txt = (trigger.textContent || '').trim();
    return txt || null;
  }

  function buildComposerAnchor(trigger, key, isFocused) {
    const cascadeEl = trigger.closest?.('[data-cascade-id]') || null;
    const rawCascadeId = (cascadeEl?.getAttribute?.('data-cascade-id') || '').trim();
    const hasCascadeAttr = Boolean(cascadeEl);
    const cascadeId = UUID_RE.test(rawCascadeId) ? rawCascadeId : null;

    const inputBox = trigger.closest?.('[data-testid="agent-input-box"]') || null;
    const composerFooter = trigger.closest?.('.agy-composer-footer') || null;
    let leftCluster = null;
    if (composerFooter) {
      let cur = trigger;
      while (cur && cur.parentElement && cur.parentElement !== composerFooter) {
        cur = cur.parentElement;
      }
      if (cur && cur.parentElement === composerFooter) {
        leftCluster = cur;
      }
    }
    const hostChildren = composerFooter
      ? Array.from(composerFooter.children || []).filter((ch) => ch && !isComposerHostEl(ch))
      : [];
    const lastChild = hostChildren.length >= 2 ? hostChildren[hostChildren.length - 1] : null;
    const rightCluster = lastChild && lastChild !== leftCluster ? lastChild : null;

    const footerRow = trigger.parentElement || null;
    const boxRect =
      composerFooter?.getBoundingClientRect?.() ||
      inputBox?.getBoundingClientRect?.() ||
      footerRow?.getBoundingClientRect?.() ||
      null;
    const width = boxRect && boxRect.width > 0 ? boxRect.width : null;

    return {
      key,
      isFocused,
      trigger,
      composerFooter,
      leftCluster,
      rightCluster,
      footerRow,
      inputBox,
      width,
      contextLimitHint: parseContextWindowHint(trigger.getAttribute?.('data-context-window')),
      modelHint: extractModelHint(trigger),
      hasCascadeAttr,
      cascadeId
    };
  }

  function findComposerAnchors(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return [];
    let triggers =
      typeof doc.querySelectorAll === 'function'
        ? Array.from(doc.querySelectorAll('[data-testid="model-selector-trigger"]'))
        : [];
    if (!triggers.length) {
      const single = doc.querySelector('[data-testid="model-selector-trigger"]');
      if (single) triggers = [single];
    }
    if (!triggers.length) return [];

    const usedKeys = new Set();
    return triggers.map((trigger, idx) => {
      const paneEl = trigger.closest?.('[data-pane-id]') || null;
      const paneId = (paneEl?.getAttribute?.('data-pane-id') || '').trim();
      const isFocused = !trigger.closest?.('[data-pane-unfocused]');
      const baseKey = paneId ? `pane:${paneId}` : `idx:${idx}`;
      let key = baseKey;
      let suffix = 2;
      while (usedKeys.has(key)) {
        key = `${baseKey}#${suffix++}`;
      }
      usedKeys.add(key);
      return buildComposerAnchor(trigger, key, isFocused);
    });
  }

  function resolvePaneConversationId(anchor, href, paneIndex = 0, totalPanes = 1) {
    if (anchor?.hasCascadeAttr) {
      return anchor.cascadeId || null;
    }
    const { ids, focusedId } = parseConversationIdsFromUrl(href);
    if (totalPanes <= 1) {
      return focusedId || ids[0] || null;
    }
    if (ids.length >= totalPanes) {
      return ids[paneIndex] || null;
    }
    if (anchor?.isFocused) {
      return focusedId || ids[0] || null;
    }
    return ids[paneIndex] || null;
  }

  function findTopbarAnchor(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    const titlebar = doc.querySelector('[class*="@container/titlebar"]');
    if (titlebar) {
      const leftGroup = titlebar.firstElementChild;
      if (leftGroup && leftGroup !== titlebar.lastElementChild) {
        return { container: leftGroup, placement: 'after-title' };
      }
      return { container: titlebar, placement: 'after-title' };
    }

    for (const sel of [
      '[data-testid="pane-titlebar-toolbar"]',
      '[data-testid="open-editor-single"]',
      '[data-testid="open-editor-empty"]',
      '[data-testid="toggle-aux-sidebar"]'
    ]) {
      const el = doc.querySelector(sel);
      if (el && el.parentElement) return { container: el.parentElement, placement: 'right' };
    }
    return null;
  }

  function mountController({ win = typeof window !== 'undefined' ? window : null, doc = document, api } = {}) {
    if (win?.__AGVario && typeof win.__AGVario.dispose === 'function') {
      try {
        win.__AGVario.dispose();
      } catch {}
    }

    let disposed = false;
    const paneEntries = new Map();
    const dormantComposer = {
      host: { style: { display: 'none' }, parentElement: null, nextSibling: null },
      getOpenCard: () => null,
      close: () => {},
      reposition: () => {},
      dispose: () => {}
    };

    const initialAnchors = findComposerAnchors(doc);
    const initialFocused = initialAnchors.find((a) => a.isFocused) || initialAnchors[0] || null;
    let activePaneKey = initialFocused?.key || null;
    let activeConversationId = initialFocused
      ? resolvePaneConversationId(
          initialFocused,
          win?.location?.href || '',
          Math.max(0, initialAnchors.indexOf(initialFocused)),
          initialAnchors.length
        )
      : parseActiveConversationFromUrl(win?.location?.href || '');
    let activeModelHint = null;
    let lastCheckedHref = win?.location?.href || '';
    let interactionSyncTimer = null;
    let sessionTick = 0;
    let currentTheme = styles.detectHostTheme(doc, win);

    let topbar = null;

    function syncTheme() {
      const nextTheme = styles.detectHostTheme(doc, win);
      if (nextTheme === currentTheme) return false;
      currentTheme = nextTheme;
      topbar?.setTheme?.(currentTheme);
      for (const entry of paneEntries.values()) {
        entry.composer.setTheme?.(currentTheme);
      }
      return true;
    }

    function closeAllComposers(exceptKey = null) {
      for (const entry of paneEntries.values()) {
        if (entry.key !== exceptKey) {
          entry.composer.close();
        }
      }
    }

    function ensurePaneEntry(anchor) {
      const existing = paneEntries.get(anchor.key);
      if (existing) {
        return { entry: existing, isNew: false };
      }

      const entry = {
        key: anchor.key,
        composer: null,
        conversationId: null,
        contextLimitHint: anchor.contextLimitHint,
        modelHint: anchor.modelHint,
        isFocused: anchor.isFocused,
        lastRefreshedAtMs: 0,
        sessionReqSeq: 0,
        contextReqSeq: 0,
        disposed: false
      };

      const composer = composerBar.createComposerBar({
        doc,
        win,
        hostId: null,
        theme: currentTheme,
        onOpenCard: () => {
          closeAllComposers(entry.key);
          topbar?.close();
          if (entry.conversationId && Date.now() - entry.lastRefreshedAtMs > 4000) {
            void refreshPaneSession(entry);
          }
        },
        onOpenContext: () => {
          const reqConvId = entry.conversationId;
          if (!reqConvId || !api?.getContext) return;
          const seq = ++entry.contextReqSeq;
          composer.updateContext(null, { loading: true, error: null, reset: true });
          void api
            .getContext({
              conversationId: reqConvId,
              contextLimitHint: entry.contextLimitHint
            })
            .then((res) => {
              if (
                disposed ||
                entry.disposed ||
                reqConvId !== entry.conversationId ||
                seq !== entry.contextReqSeq
              ) {
                return;
              }
              if (res && res.ok) composer.updateContext(res.data, { loading: false, error: null });
              else composer.updateContext(null, { loading: false, error: res?.error || 'Unavailable' });
            })
            .catch((err) => {
              if (
                !disposed &&
                !entry.disposed &&
                reqConvId === entry.conversationId &&
                seq === entry.contextReqSeq
              ) {
                composer.updateContext(null, { loading: false, error: err?.message || 'Error' });
              }
            });
        }
      });

      composer.host.setAttribute('data-pane-key', anchor.key);
      entry.composer = composer;
      paneEntries.set(anchor.key, entry);
      return { entry, isNew: true };
    }

    function mountPaneEntryDom(entry, anchor) {
      const comp = entry.composer;
      const w = anchor.width;
      const useFallback = w !== null && w < 340;
      const useCompact = w !== null && w < 520;
      comp.setCompact(useCompact);
      comp.setFallbackRow(useFallback);
      comp.setFocused(anchor.isFocused);

      if (useFallback && anchor.inputBox && anchor.inputBox.parentElement) {
        const nextSib = anchor.inputBox.nextSibling;
        if (comp.host.parentElement !== anchor.inputBox.parentElement || nextSib !== comp.host) {
          anchor.inputBox.parentElement.insertBefore(comp.host, nextSib);
        }
      } else if (anchor.composerFooter && anchor.rightCluster) {
        if (comp.host.parentElement !== anchor.composerFooter || comp.host.nextSibling !== anchor.rightCluster) {
          anchor.composerFooter.insertBefore(comp.host, anchor.rightCluster);
        }
      } else if (anchor.footerRow) {
        if (comp.host.parentElement !== anchor.footerRow || comp.host.nextSibling !== anchor.trigger) {
          anchor.footerRow.insertBefore(comp.host, anchor.trigger);
        }
      }
      comp.host.style.display = 'inline-flex';
      comp.reposition();
    }

    topbar = topbarBar.createTopbarBar({
      doc,
      win,
      theme: currentTheme,
      onOpenPanel: () => {
        closeAllComposers(null);
      },
      onRefreshQuota: () => {
        void refreshQuota(true);
      },
      onRequestUsage: ({ period, selectedDateKey }) => {
        void refreshUsage({ period, selectedDateKey });
      }
    });

    function syncTopbarAnchor() {
      const topAnchor = findTopbarAnchor(doc);
      if (topAnchor && topAnchor.container) {
        const { container, placement } = topAnchor;
        topbar.setPlacement?.(placement);
        if (placement === 'after-title') {
          if (topbar.host.parentElement !== container || topbar.host.nextSibling !== null) {
            container.appendChild(topbar.host);
          }
        } else {
          const first = container.firstElementChild || container.firstChild;
          if (topbar.host.parentElement !== container || (first && first !== topbar.host)) {
            if (first) container.insertBefore(topbar.host, first);
            else container.appendChild(topbar.host);
          }
        }
      }
    }

    async function refreshQuota(force = false) {
      if (disposed || !api?.getQuota) return;
      if (force) topbar.updateQuota(null, { loading: true, error: null });
      try {
        const res = await api.getQuota({ force, currentModel: activeModelHint });
        if (disposed) return;
        if (res && res.ok) topbar.updateQuota(res.data, { loading: false, error: null });
        else topbar.updateQuota(null, { loading: false, error: res?.error || 'Quota unavailable' });
      } catch (err) {
        if (!disposed) topbar.updateQuota(null, { loading: false, error: err?.message || 'Quota error' });
      }
    }

    async function refreshToday() {
      if (disposed || !api?.getToday) return;
      try {
        const res = await api.getToday();
        if (!disposed && res && res.ok) topbar.updateToday(res.data);
      } catch {}
    }

    async function refreshPaneSession(entry) {
      const reqConvId = entry?.conversationId;
      if (disposed || !entry || entry.disposed || !reqConvId || !api?.getSession) return;
      const seq = ++entry.sessionReqSeq;
      try {
        const res = await api.getSession({
          conversationId: reqConvId,
          contextLimitHint: entry.contextLimitHint
        });
        if (
          !disposed &&
          !entry.disposed &&
          reqConvId === entry.conversationId &&
          seq === entry.sessionReqSeq &&
          res &&
          res.ok
        ) {
          entry.lastRefreshedAtMs = Date.now();
          entry.composer.updateSession(res.data);
        }
      } catch {}
    }

    async function refreshUsage({ period = '7D', selectedDateKey = null } = {}) {
      if (disposed || !api?.getUsage) return;
      topbar.updateUsage(null, { loading: true, error: null });
      try {
        const res = await api.getUsage({ period, selectedDateKey });
        if (disposed) return;
        if (res && res.ok) {
          topbar.updateUsage(res.data, { profile: res.profile || null, loading: false, error: null });
        } else {
          topbar.updateUsage(null, { loading: false, error: res?.error || 'Usage unavailable' });
        }
      } catch (err) {
        if (!disposed) topbar.updateUsage(null, { loading: false, error: err?.message || 'Usage error' });
      }
    }

    function syncAll(prefetchedAnchors = null, { forceRefreshAll = false } = {}) {
      if (disposed) return false;
      const href = win?.location?.href || '';
      const hrefChanged = href !== lastCheckedHref;
      lastCheckedHref = href;

      syncTheme();
      syncTopbarAnchor();

      const anchors = Array.isArray(prefetchedAnchors) ? prefetchedAnchors : findComposerAnchors(doc);
      const focusedAnchor = anchors.find((a) => a.isFocused) || anchors[0] || null;
      const anchorKeys = new Set(anchors.map((a) => a.key));

      for (const [key, entry] of paneEntries.entries()) {
        if (!anchorKeys.has(key)) {
          entry.disposed = true;
          entry.composer.dispose();
          paneEntries.delete(key);
        }
      }

      const nextPaneKey = focusedAnchor?.key || null;
      if (nextPaneKey !== activePaneKey) {
        if (activePaneKey && paneEntries.has(activePaneKey)) {
          paneEntries.get(activePaneKey).composer.close();
        }
        activePaneKey = nextPaneKey;
      }

      let anyRefreshed = false;
      const nowMs = Date.now();

      for (let i = 0; i < anchors.length; i++) {
        const anchor = anchors[i];
        const { entry, isNew } = ensurePaneEntry(anchor);
        const nextConvId = resolvePaneConversationId(anchor, href, i, anchors.length);
        const convChanged = nextConvId !== entry.conversationId;
        const becameFocused = anchor.isFocused && !entry.isFocused;

        entry.isFocused = anchor.isFocused;
        entry.contextLimitHint = anchor.contextLimitHint;
        entry.modelHint = anchor.modelHint;

        if (convChanged) {
          entry.conversationId = nextConvId;
          entry.sessionReqSeq++;
          entry.contextReqSeq++;
          entry.lastRefreshedAtMs = 0;
          entry.composer.close();
          entry.composer.updateSession(null);
        }

        mountPaneEntryDom(entry, anchor);

        if (
          entry.conversationId &&
          (isNew ||
            convChanged ||
            forceRefreshAll ||
            (becameFocused && nowMs - entry.lastRefreshedAtMs > 4000))
        ) {
          anyRefreshed = true;
          void refreshPaneSession(entry);
        }
      }

      activeConversationId = focusedAnchor
        ? paneEntries.get(focusedAnchor.key)?.conversationId || null
        : parseActiveConversationFromUrl(href);

      const nextModelHint = focusedAnchor?.modelHint || null;
      const prevModelHint = activeModelHint;
      activeModelHint = nextModelHint;
      if (prevModelHint !== activeModelHint && activeModelHint) {
        void refreshQuota(false);
      }

      topbar.reposition();
      return anyRefreshed || hrefChanged;
    }

    function handleLocationOrFocusChange() {
      return syncAll(null, { forceRefreshAll: false });
    }

    function scheduleInteractionSync() {
      if (disposed) return;
      Promise.resolve().then(() => {
        if (!disposed) handleLocationOrFocusChange();
      });
      if (interactionSyncTimer) clearTimeout(interactionSyncTimer);
      interactionSyncTimer = setTimeout(() => {
        interactionSyncTimer = null;
        if (!disposed) handleLocationOrFocusChange();
      }, 80);
    }

    function scheduleNavSync() {
      if (disposed) return;
      Promise.resolve().then(() => {
        if (!disposed) handleLocationOrFocusChange();
      });
      scheduleInteractionSync();
    }

    const onDocKeyDown = (e) => {
      if (e?.key === 'Escape') {
        closeAllComposers(null);
        topbar.close();
      }
    };
    const onDocMouseDown = () => {
      closeAllComposers(null);
      topbar.close();
    };
    const onDocFocusIn = (e) => {
      const target = e?.target;
      if (target?.closest?.('[role="dialog"], [aria-modal="true"]')) {
        closeAllComposers(null);
        topbar.close();
      }
    };
    const PANE_EVENT_SELECTOR =
      '[data-pane-id], [data-sidebar-row-id], [data-testid="model-selector-trigger"], [role="menuitem"], [role="option"], [role="listbox"], a[href]';
    const onPaneEvent = (e) => {
      const target = e?.target;
      if (target?.closest?.(PANE_EVENT_SELECTOR)) {
        handleLocationOrFocusChange();
        scheduleInteractionSync();
      }
    };
    const onWinFocus = () => {
      if (disposed) return;
      handleLocationOrFocusChange();
      void refreshToday();
    };
    const onResize = () => {
      if (!disposed) syncAll();
    };

    let themeObserver = null;
    const MutationObsCtor = win?.MutationObserver || (typeof MutationObserver === 'function' ? MutationObserver : null);
    if (MutationObsCtor) {
      try {
        themeObserver = new MutationObsCtor(() => {
          if (!disposed) syncTheme();
        });
        const obsOpts = { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] };
        if (doc.documentElement) themeObserver.observe(doc.documentElement, obsOpts);
        if (doc.body) themeObserver.observe(doc.body, obsOpts);
      } catch {
        themeObserver = null;
      }
    }

    let themeMediaQuery = null;
    const onThemeMediaChange = () => {
      if (!disposed) syncTheme();
    };
    try {
      if (typeof win?.matchMedia === 'function') {
        themeMediaQuery = win.matchMedia('(prefers-color-scheme: light)');
        if (themeMediaQuery && typeof themeMediaQuery.addEventListener === 'function') {
          themeMediaQuery.addEventListener('change', onThemeMediaChange);
        }
      }
    } catch {
      themeMediaQuery = null;
    }

    const hasNavigationApi =
      Boolean(win?.navigation) && typeof win.navigation.addEventListener === 'function';
    const origPushState = win?.history?.pushState;
    const origReplaceState = win?.history?.replaceState;

    if (hasNavigationApi) {
      win.navigation.addEventListener('currententrychange', scheduleNavSync);
    } else {
      if (win?.history && typeof origPushState === 'function') {
        win.history.pushState = function (...args) {
          const ret = origPushState.apply(win.history, args);
          scheduleNavSync();
          return ret;
        };
      }
      if (win?.history && typeof origReplaceState === 'function') {
        win.history.replaceState = function (...args) {
          const ret = origReplaceState.apply(win.history, args);
          scheduleNavSync();
          return ret;
        };
      }
    }

    doc.addEventListener?.('keydown', onDocKeyDown);
    doc.addEventListener?.('mousedown', onDocMouseDown);
    doc.addEventListener?.('focusin', onDocFocusIn, true);
    doc.addEventListener?.('click', onPaneEvent, true);
    doc.addEventListener?.('focusin', onPaneEvent, true);
    win?.addEventListener?.('popstate', handleLocationOrFocusChange);
    win?.addEventListener?.('focus', onWinFocus);
    win?.addEventListener?.('resize', onResize);

    const quotaTimer = setInterval(() => {
      if (!doc.hidden) void refreshQuota(false);
    }, QUOTA_REFRESH_MS);

    const sessionTimer = setInterval(() => {
      if (disposed || doc.hidden) return;
      sessionTick++;
      for (const entry of paneEntries.values()) {
        if (!entry.conversationId) continue;
        if (entry.isFocused || entry.composer.getOpenCard() || sessionTick % UNFOCUSED_REFRESH_EVERY === 0) {
          void refreshPaneSession(entry);
        }
      }
    }, SESSION_REFRESH_MS);

    const livenessTimer = setInterval(() => {
      if (disposed || doc.hidden) return;
      handleLocationOrFocusChange();
    }, LIVENESS_CHECK_MS);

    syncAll(initialAnchors, { forceRefreshAll: true });
    void refreshQuota(false);
    void refreshToday();

    function dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(quotaTimer);
      clearInterval(sessionTimer);
      clearInterval(livenessTimer);
      if (interactionSyncTimer) {
        clearTimeout(interactionSyncTimer);
        interactionSyncTimer = null;
      }
      if (themeObserver) {
        try {
          themeObserver.disconnect();
        } catch {}
        themeObserver = null;
      }
      if (themeMediaQuery && typeof themeMediaQuery.removeEventListener === 'function') {
        try {
          themeMediaQuery.removeEventListener('change', onThemeMediaChange);
        } catch {}
        themeMediaQuery = null;
      }
      if (hasNavigationApi) {
        win.navigation.removeEventListener?.('currententrychange', scheduleNavSync);
      } else {
        if (win?.history && origPushState) win.history.pushState = origPushState;
        if (win?.history && origReplaceState) win.history.replaceState = origReplaceState;
      }
      doc.removeEventListener?.('keydown', onDocKeyDown);
      doc.removeEventListener?.('mousedown', onDocMouseDown);
      doc.removeEventListener?.('focusin', onDocFocusIn, true);
      doc.removeEventListener?.('click', onPaneEvent, true);
      doc.removeEventListener?.('focusin', onPaneEvent, true);
      win?.removeEventListener?.('popstate', handleLocationOrFocusChange);
      win?.removeEventListener?.('focus', onWinFocus);
      win?.removeEventListener?.('resize', onResize);
      for (const entry of paneEntries.values()) {
        entry.disposed = true;
        entry.composer.dispose();
      }
      paneEntries.clear();
      topbar.dispose();
    }

    function getActiveComposer() {
      if (activePaneKey && paneEntries.has(activePaneKey)) {
        return paneEntries.get(activePaneKey).composer;
      }
      return paneEntries.values().next().value?.composer || dormantComposer;
    }

    const controller = {
      version: '0.3.0',
      isAlive: () => !disposed && Boolean(topbar?.host?.isConnected),
      dispose,
      refreshNow: () => {
        syncAll(null, { forceRefreshAll: true });
        void refreshQuota(true);
        void refreshToday();
      },
      getState: () => ({
        disposed,
        theme: currentTheme,
        activeConversationId,
        activePaneKey,
        paneCount: paneEntries.size,
        composerOpen: getActiveComposer().getOpenCard(),
        topbarOpen: topbar.getOpenPanel()
      }),
      get composer() {
        return getActiveComposer();
      },
      get composers() {
        return new Map(Array.from(paneEntries.entries()).map(([k, e]) => [k, e.composer]));
      },
      topbar
    };

    if (win) win.__AGVario = controller;
    return controller;
  }

  function start(options = {}) {
    const win = options.win || (typeof window !== 'undefined' ? window : null);
    const doc = options.doc || (typeof document !== 'undefined' ? document : null);
    const api = options.api || win?.agVarioAPI || null;
    if (!doc) return null;
    return mountController({ win, doc, api });
  }

  return {
    parseConversationIdsFromUrl,
    parseActiveConversationFromUrl,
    parseContextWindowHint,
    findComposerAnchors,
    resolvePaneConversationId,
    findTopbarAnchor,
    mountController,
    start
  };
});

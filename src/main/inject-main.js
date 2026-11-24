'use strict';

/**
 * Main-process bridge and renderer injector for Antigravity v2.34.0.
 *
 * MIT Attribution: BaseWindow/contentView WebContents discovery and loopback
 * main-frame IPC sender verification reference `antigravity-context-viewer`
 * (Copyright (c) 2026 Antigravity Context Viewer Contributors, MIT License).
 */

const fs = require('node:fs');
const path = require('node:path');
const { normalizeLoopbackOrigin } = require('./rpc-client');
const { createCollector } = require('./collector');

const DEFAULT_RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const RENDERER_FILES = ['styles.js', 'composer-bar.js', 'topbar-bar.js', 'mount.js'];

const PRELOAD_BRIDGE_SNIPPET = `
try {
  if (typeof electron_1 !== "undefined" && electron_1.contextBridge && electron_1.ipcRenderer) {
    electron_1.contextBridge.exposeInMainWorld("agVarioAPI", {
      ping: () => electron_1.ipcRenderer.invoke("ag-vario:ping"),
      getSession: (payload) => electron_1.ipcRenderer.invoke("ag-vario:get-session", payload),
      getContext: (payload) => electron_1.ipcRenderer.invoke("ag-vario:get-context", payload),
      getQuota: (payload) => electron_1.ipcRenderer.invoke("ag-vario:get-quota", payload),
      getUsage: (payload) => electron_1.ipcRenderer.invoke("ag-vario:get-usage", payload),
      getToday: () => electron_1.ipcRenderer.invoke("ag-vario:get-today")
    });
  }
} catch (_agVarioPreloadErr) {}
`.trim();

const registeredIpcMains = new WeakSet();
const boundWindows = new WeakSet();
const boundWebContents = new WeakSet();
const injectionTimers = new WeakMap();
const probeTimers = new WeakMap();

let defaultCollector = null;
function getDefaultCollector() {
  if (!defaultCollector) defaultCollector = createCollector();
  return defaultCollector;
}

function isLocalMainFrameSender(event) {
  try {
    const rawUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    const origin = normalizeLoopbackOrigin(rawUrl);
    if (!origin) return null;
    if (event.senderFrame && event.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame) {
      return null;
    }
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function getWindowWebContents(win, options = {}) {
  if (!win || win.isDestroyed?.()) return null;
  if (win.webContents && !win.webContents.isDestroyed?.()) return win.webContents;

  let utils = options.utils || null;
  if (!utils) {
    try {
      utils = require('../../utils');
    } catch {
      try {
        utils = require('./utils');
      } catch {}
    }
  }
  try {
    if (utils && typeof utils.getHubWebContents === 'function') {
      const wc = utils.getHubWebContents(win);
      if (wc && !wc.isDestroyed?.()) return wc;
    }
  } catch {}

  try {
    const children = win.contentView?.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const wc = child?.webContents;
        if (wc && !wc.isDestroyed?.()) {
          const url = wc.getURL?.() || '';
          if (/^https?:\/\/127\.0\.0\.1:\d+\//.test(url)) return wc;
        }
      }
      for (const child of children) {
        const wc = child?.webContents;
        if (wc && !wc.isDestroyed?.()) {
          const url = wc.getURL?.() || '';
          if (!url.startsWith('data:')) return wc;
        }
      }
    }
  } catch {}

  return null;
}

function buildRendererBundle(options = {}) {
  const rendererDir = options.rendererDir || DEFAULT_RENDERER_DIR;
  const parts = RENDERER_FILES.map((filename) =>
    fs.readFileSync(path.join(rendererDir, filename), 'utf8')
  );
  return [
    '(function(){',
    '"use strict";',
    parts.join('\n'),
    'try{if(globalThis.__AGVarioModules&&globalThis.__AGVarioModules.mount){globalThis.__AGVarioModules.mount.start();}}catch(_e){}',
    '})();',
    'true;'
  ].join('\n');
}

function registerIpcHandlers(options = {}) {
  let ipcMain = options.ipcMain || null;
  if (!ipcMain) {
    try {
      ipcMain = require('electron').ipcMain;
    } catch {}
  }
  if (!ipcMain || typeof ipcMain.handle !== 'function') return false;
  if (registeredIpcMains.has(ipcMain)) return true;
  registeredIpcMains.add(ipcMain);

  const collector = options.collector || getDefaultCollector();

  const guardAndRun = (handler) => async (event, payload) => {
    const url = isLocalMainFrameSender(event);
    if (!url) {
      return { ok: false, error: 'Unauthorized sender' };
    }
    try {
      return await handler({ origin: url.origin, payload: payload && typeof payload === 'object' ? payload : {} });
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  };

  ipcMain.handle('ag-vario:ping', guardAndRun(async ({ origin }) => ({ ok: true, origin })));

  ipcMain.handle(
    'ag-vario:get-session',
    guardAndRun(async ({ origin, payload }) =>
      collector.getSessionSnapshot({
        origin,
        conversationId: payload.conversationId || '',
        contextLimitHint: payload.contextLimitHint ?? null
      })
    )
  );

  ipcMain.handle(
    'ag-vario:get-context',
    guardAndRun(async ({ origin, payload }) =>
      collector.getContextBreakdown({
        origin,
        conversationId: payload.conversationId || '',
        contextLimitHint: payload.contextLimitHint ?? null
      })
    )
  );

  ipcMain.handle(
    'ag-vario:get-quota',
    guardAndRun(async ({ origin, payload }) =>
      collector.getQuotaSnapshot({
        origin,
        force: payload.force === true,
        currentModel: payload.currentModel || null
      })
    )
  );

  ipcMain.handle(
    'ag-vario:get-usage',
    guardAndRun(async ({ payload }) =>
      collector.getUsageReport({
        period: payload.period || '7D',
        selectedDateKey: payload.selectedDateKey || null,
        force: payload.force === true
      })
    )
  );

  ipcMain.handle(
    'ag-vario:get-today',
    guardAndRun(async () => collector.getTodayUsageSummary())
  );

  return true;
}

async function ensureInjected(win, options = {}) {
  try {
    if (!win || win.isDestroyed?.()) return false;
    const wc = getWindowWebContents(win, options);
    const url = wc?.getURL?.() || '';
    if (!wc || wc.isDestroyed?.() || !/^https?:\/\/127\.0\.0\.1:\d+\//.test(url)) {
      const attempt = Number(options.attempt || 0);
      const delays = [300, 700, 1500];
      if (attempt < delays.length && !win.isDestroyed?.()) {
        const prev = injectionTimers.get(win);
        if (prev) clearTimeout(prev);
        const timer = setTimeout(() => {
          injectionTimers.delete(win);
          void ensureInjected(win, { ...options, attempt: attempt + 1 });
        }, delays[attempt]);
        injectionTimers.set(win, timer);
      }
      return false;
    }

    if (!options.force) {
      try {
        const alive = await wc.executeJavaScript('Boolean(window.__AGVario && window.__AGVario.isAlive())');
        if (alive === true) return true;
      } catch {}
    }

    const bundle = buildRendererBundle(options);
    await wc.executeJavaScript(bundle);
    return true;
  } catch {
    return false;
  }
}

function installAgVario(win, options = {}) {
  registerIpcHandlers(options);
  if (!win || win.isDestroyed?.()) return;

  if (!boundWindows.has(win)) {
    boundWindows.add(win);
    const onActive = () => {
      void ensureInjected(win, { ...options, force: false });
    };
    win.on?.('show', onActive);
    win.on?.('focus', onActive);
  }

  const bindWc = (wc) => {
    if (!wc || boundWebContents.has(wc)) return;
    boundWebContents.add(wc);
    wc.on?.('did-finish-load', () => {
      void ensureInjected(win, { ...options, force: true });
    });
    wc.on?.('dom-ready', () => {
      void ensureInjected(win, { ...options, force: false });
    });
    wc.on?.('did-navigate', () => {
      void ensureInjected(win, { ...options, force: false });
    });
    wc.on?.('did-navigate-in-page', () => {
      void ensureInjected(win, { ...options, force: false });
    });
  };

  const initialWc = getWindowWebContents(win, options);
  if (initialWc) {
    bindWc(initialWc);
    void ensureInjected(win, { ...options, force: false });
  } else {
    const prevProbe = probeTimers.get(win);
    if (prevProbe) clearInterval(prevProbe);
    let retries = 0;
    const timer = setInterval(() => {
      retries++;
      const candidate = getWindowWebContents(win, options);
      if (candidate) {
        clearInterval(timer);
        probeTimers.delete(win);
        bindWc(candidate);
        void ensureInjected(win, { ...options, force: false });
      } else if (retries >= 10 || win.isDestroyed?.()) {
        clearInterval(timer);
        probeTimers.delete(win);
      }
    }, 150);
    probeTimers.set(win, timer);
    win.once?.('closed', () => {
      const t = probeTimers.get(win);
      if (t) {
        clearInterval(t);
        probeTimers.delete(win);
      }
    });
  }
}

module.exports = {
  PRELOAD_BRIDGE_SNIPPET,
  RENDERER_FILES,
  isLocalMainFrameSender,
  getWindowWebContents,
  buildRendererBundle,
  registerIpcHandlers,
  ensureInjected,
  installAgVario
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const injectMain = require('../src/main/inject-main');

test('inject-main: isLocalMainFrameSender validates loopback and mainFrame', () => {
  const mf = { url: 'https://127.0.0.1:43000/c/123' };
  const okUrl = injectMain.isLocalMainFrameSender({
    senderFrame: mf,
    sender: { mainFrame: mf, getURL: () => mf.url }
  });
  assert.equal(okUrl.origin, 'https://127.0.0.1:43000');

  // Subframe rejected
  const subRejected = injectMain.isLocalMainFrameSender({
    senderFrame: { url: 'https://127.0.0.1:43000/iframe' },
    sender: { mainFrame: mf, getURL: () => mf.url }
  });
  assert.equal(subRejected, null);

  // External host rejected
  const extRejected = injectMain.isLocalMainFrameSender({
    senderFrame: { url: 'https://evil.example/c/123' },
    sender: { getURL: () => 'https://evil.example/c/123' }
  });
  assert.equal(extRejected, null);
});

test('inject-main: getWindowWebContents supports BrowserWindow, utils, and BaseWindow contentView', () => {
  const directWc = { isDestroyed: () => false, getURL: () => 'https://127.0.0.1:1000/' };
  assert.equal(injectMain.getWindowWebContents({ webContents: directWc }), directWc);

  const hubWc = { isDestroyed: () => false, getURL: () => 'https://127.0.0.1:2000/' };
  assert.equal(
    injectMain.getWindowWebContents({}, { utils: { getHubWebContents: () => hubWc } }),
    hubWc
  );

  const curtainWc = { isDestroyed: () => false, getURL: () => 'data:text/html,loading' };
  const mainViewWc = { isDestroyed: () => false, getURL: () => 'https://127.0.0.1:3000/' };
  assert.equal(
    injectMain.getWindowWebContents({
      contentView: { children: [{ webContents: curtainWc }, { webContents: mainViewWc }] }
    }),
    mainViewWc
  );
});

test('inject-main: registerIpcHandlers binds 6 channels once and enforces loopback origin', async () => {
  const handlers = new Map();
  const fakeIpcMain = {
    handle(channel, fn) {
      handlers.set(channel, fn);
    }
  };
  let seenOrigin = null;
  const fakeCollector = {
    getSessionSnapshot: async ({ origin }) => {
      seenOrigin = origin;
      return { ok: true, data: {} };
    },
    getContextBreakdown: async () => ({ ok: true, data: {} }),
    getQuotaSnapshot: async () => ({ ok: true, data: {} }),
    getUsageReport: async () => ({ ok: true, data: {} }),
    getTodayUsageSummary: async () => ({ ok: true, data: {} })
  };

  assert.equal(injectMain.registerIpcHandlers({ ipcMain: fakeIpcMain, collector: fakeCollector }), true);
  assert.equal(handlers.size, 6);
  for (const ch of [
    'ag-vario:ping',
    'ag-vario:get-session',
    'ag-vario:get-context',
    'ag-vario:get-quota',
    'ag-vario:get-usage',
    'ag-vario:get-today'
  ]) {
    assert.ok(handlers.has(ch));
  }

  // Unauthorized sender rejected
  const badRes = await handlers.get('ag-vario:get-session')(
    { sender: { getURL: () => 'https://example.com/' } },
    { conversationId: '1' }
  );
  assert.equal(badRes.ok, false);

  // Authorized sender passes origin from event (not payload)
  const mf = { url: 'http://127.0.0.1:44444/c/abc' };
  const goodRes = await handlers.get('ag-vario:get-session')(
    { senderFrame: mf, sender: { mainFrame: mf, getURL: () => mf.url } },
    { conversationId: '1', origin: 'https://spoofed.example' }
  );
  assert.equal(goodRes.ok, true);
  assert.equal(seenOrigin, 'http://127.0.0.1:44444');
});

test('inject-main: buildRendererBundle compiles cleanly with vm.Script', () => {
  const bundle = injectMain.buildRendererBundle();
  assert.ok(bundle.length > 5000);
  const script = new vm.Script(bundle, { filename: 'ag-vario-renderer-bundle.js' });
  assert.ok(script);
  assert.ok(injectMain.PRELOAD_BRIDGE_SNIPPET.includes('agVarioAPI'));
});

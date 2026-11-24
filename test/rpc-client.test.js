'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rpcClient = require('../src/main/rpc-client');

test('rpc-client: normalizeLoopbackOrigin accepts loopback and rejects non-loopback', () => {
  assert.equal(rpcClient.normalizeLoopbackOrigin('https://127.0.0.1:42100/foo'), 'https://127.0.0.1:42100');
  assert.equal(rpcClient.normalizeLoopbackOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(rpcClient.normalizeLoopbackOrigin('https://example.com:443'), null);
  assert.equal(rpcClient.normalizeLoopbackOrigin('http://localhost:8080'), null);
  assert.equal(rpcClient.normalizeLoopbackOrigin('http://127.0.0.1:99999'), null);
  assert.equal(rpcClient.normalizeLoopbackOrigin('not-a-url'), null);
});

test('rpc-client: resolveCsrfToken prioritizes authBootstrap > daemon hub > HTML __APP_CONFIG__', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-vario-rpc-'));
  try {
    const daemonDir = path.join(tmpDir, 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(
      path.join(daemonDir, 'hub_1.json'),
      JSON.stringify({ pid: process.pid, httpsPort: 45100, csrfToken: 'daemon-tok' }),
      'utf8'
    );

    const tokenFromBootstrap = await rpcClient.resolveCsrfToken('https://127.0.0.1:45100', {
      dataDir: tmpDir,
      authBootstrap: {
        getActiveLsBaseUrl: () => 'https://127.0.0.1:45100',
        getActiveLsCsrfToken: () => 'boot-tok'
      }
    });
    assert.equal(tokenFromBootstrap, 'boot-tok');

    // Different origin must NOT leak bootstrap token -> falls back to daemon hub
    const tokenMismatch = await rpcClient.resolveCsrfToken('https://127.0.0.1:45100', {
      dataDir: tmpDir,
      authBootstrap: {
        getActiveLsBaseUrl: () => 'https://127.0.0.1:45999',
        getActiveLsCsrfToken: () => 'wrong-origin-tok'
      }
    });
    assert.equal(tokenMismatch, 'daemon-tok');

    // Port without daemon hub falls back to HTML __APP_CONFIG__
    const tokenHtml = await rpcClient.resolveCsrfToken('http://127.0.0.1:45200', {
      dataDir: tmpDir,
      authBootstrap: null,
      fetchHtml: async () => '<html><script>window.__APP_CONFIG__ = {"csrfToken":"html-tok"};</script></html>'
    });
    assert.equal(tokenHtml, 'html-tok');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('rpc-client: createRpcClient sends Connect headers and retries once on 401/403', async () => {
  let tokenVersion = 1;
  const seenCalls = [];

  const client = rpcClient.createRpcClient('https://127.0.0.1:45300', {
    authBootstrap: {
      getActiveLsBaseUrl: () => 'https://127.0.0.1:45300',
      getActiveLsCsrfToken: () => `tok-${tokenVersion}`
    },
    transport: async ({ url, method, headers, body }) => {
      seenCalls.push({ url, method, headers, body });
      if (headers['x-codeium-csrf-token'] === 'tok-1') {
        tokenVersion = 2;
        return { statusCode: 401, text: 'Unauthorized' };
      }
      return { statusCode: 200, text: JSON.stringify({ ok: true, groups: [] }) };
    }
  });

  const res = await client.retrieveUserQuotaSummary();
  assert.deepEqual(res, { ok: true, groups: [] });
  assert.equal(seenCalls.length, 2);
  assert.equal(seenCalls[0].headers['Connect-Protocol-Version'], '1');
  assert.equal(seenCalls[0].headers['x-codeium-csrf-token'], 'tok-1');
  assert.equal(seenCalls[1].headers['x-codeium-csrf-token'], 'tok-2');
  assert.ok(seenCalls[0].url.endsWith('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'));

  assert.throws(() => rpcClient.createRpcClient('https://evil.com:443'), /Invalid loopback origin/);
});

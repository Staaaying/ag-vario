'use strict';

/**
 * Loopback-only read-only RPC client for Antigravity v2.34.0 LanguageServerService.
 *
 * MIT Attribution: authBootstrap resolution, daemon/hub_*.json discovery, and
 * Connect-Protocol CSRF retry conventions reference `antigravity-context-viewer`
 * (Copyright (c) 2026 Antigravity Context Viewer Contributors, MIT License).
 */

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { DEFAULT_DATA_DIR } = require('./sqlite-reader');

const LOOPBACK_ORIGIN_RE = /^https?:\/\/127\.0\.0\.1:(\d+)$/;

function normalizeLoopbackOrigin(rawOrigin) {
  if (!rawOrigin || typeof rawOrigin !== 'string') return null;
  try {
    const parsed = new URL(rawOrigin.trim());
    const origin = parsed.origin;
    const m = origin.match(LOOPBACK_ORIGIN_RE);
    if (!m) return null;
    const port = Number(m[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return origin;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function discoverLiveDaemonHubs(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const checkPid = typeof options.isPidAliveFn === 'function' ? options.isPidAliveFn : isPidAlive;
  const daemonDir = path.join(dataDir, 'daemon');
  const hubs = [];
  if (!fs.existsSync(daemonDir)) return hubs;

  let files = [];
  try {
    files = fs.readdirSync(daemonDir).filter((f) => /^hub_.*\.json$/i.test(f));
  } catch {
    return hubs;
  }

  for (const file of files) {
    const filePath = path.join(daemonDir, file);
    try {
      const st = fs.statSync(filePath);
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const pid = Number(raw?.pid);
      const csrfToken = typeof raw?.csrfToken === 'string' ? raw.csrfToken.trim() : '';
      if (!csrfToken || !checkPid(pid)) continue;

      const httpsPort = Number(raw?.httpsPort);
      const httpPort = Number(raw?.httpPort);
      const httpsOrigin =
        Number.isInteger(httpsPort) && httpsPort >= 1 && httpsPort <= 65535
          ? normalizeLoopbackOrigin(`https://127.0.0.1:${httpsPort}`)
          : null;
      const httpOrigin =
        Number.isInteger(httpPort) && httpPort >= 1 && httpPort <= 65535
          ? normalizeLoopbackOrigin(`http://127.0.0.1:${httpPort}`)
          : null;
      const origin = httpsOrigin || httpOrigin;
      if (!origin) continue;

      hubs.push({
        origin,
        httpsOrigin,
        httpOrigin,
        csrfToken,
        pid,
        mtimeMs: Number(st.mtimeMs) || 0
      });
    } catch {}
  }

  hubs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return hubs;
}

function loadHostAuthBootstrap(options = {}) {
  if (options.authBootstrap === null) return null;
  if (options.dataDir && !options.authBootstrap) return null;

  let mod = options.authBootstrap || null;
  if (!mod) {
    try {
      mod = require('../../authBootstrap');
    } catch {
      try {
        mod = require('./authBootstrap');
      } catch {
        return null;
      }
    }
  }
  if (!mod || typeof mod !== 'object') return null;

  let origin = null;
  try {
    if (typeof mod.getActiveLsBaseUrl === 'function') {
      origin = normalizeLoopbackOrigin(mod.getActiveLsBaseUrl());
    }
  } catch {}

  if (!origin) {
    try {
      if (typeof mod.getActiveLsPort === 'function') {
        const port = Number(mod.getActiveLsPort());
        if (Number.isInteger(port) && port >= 1 && port <= 65535) {
          origin = normalizeLoopbackOrigin(`https://127.0.0.1:${port}`);
        }
      }
    } catch {}
  }

  let csrfToken = '';
  try {
    if (typeof mod.getActiveLsCsrfToken === 'function') {
      csrfToken = String(mod.getActiveLsCsrfToken() || '').trim();
    }
  } catch {}

  if (!origin || !csrfToken) return null;
  return { origin, csrfToken };
}

function defaultTransport({ url, method = 'GET', headers = {}, body = null, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1') {
      reject(new Error('Refusing non-loopback RPC request'));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      parsed,
      {
        agent: false,
        rejectUnauthorized: false,
        method,
        headers
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode || 0, text });
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Local RPC timeout')));
    req.on('error', reject);
    if (body !== null && body !== undefined) {
      req.end(typeof body === 'string' ? body : JSON.stringify(body));
    } else {
      req.end();
    }
  });
}

async function resolveCsrfToken(rawOrigin, options = {}) {
  const origin = normalizeLoopbackOrigin(rawOrigin);
  if (!origin) return null;

  const bootstrap = loadHostAuthBootstrap(options);
  if (bootstrap && bootstrap.origin === origin) {
    return bootstrap.csrfToken;
  }

  const hubs = discoverLiveDaemonHubs(options);
  for (const hub of hubs) {
    if (hub.httpsOrigin === origin || hub.httpOrigin === origin) {
      return hub.csrfToken;
    }
  }

  const transport = typeof options.transport === 'function' ? options.transport : defaultTransport;
  try {
    let html = '';
    if (typeof options.fetchHtml === 'function') {
      html = await options.fetchHtml(origin);
    } else {
      const res = await transport({
        url: `${origin}/`,
        method: 'GET',
        headers: {},
        timeoutMs: options.timeoutMs || 3000
      });
      if (res && res.statusCode === 200) html = res.text || '';
    }
    const m = String(html || '').match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\})\s*;/s);
    if (m) {
      const cfg = JSON.parse(m[1]);
      const token = typeof cfg?.csrfToken === 'string' ? cfg.csrfToken.trim() : '';
      if (token) return token;
    }
  } catch {}

  return null;
}

function createRpcClient(rawOrigin, options = {}) {
  const origin = normalizeLoopbackOrigin(rawOrigin);
  if (!origin) {
    throw new Error(`Invalid loopback origin: ${String(rawOrigin || '')}`);
  }

  const transport = typeof options.transport === 'function' ? options.transport : defaultTransport;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 15000;
  let activeToken = '';

  async function ensureToken(forceRefresh = false) {
    if (activeToken && !forceRefresh) return activeToken;
    const token = await resolveCsrfToken(origin, options);
    if (!token) {
      throw new Error(`Unable to resolve CSRF token for ${origin}`);
    }
    activeToken = token;
    return activeToken;
  }

  async function sendOnce(method, body, token) {
    const endpoint = `${origin}/exa.language_server_pb.LanguageServerService/${method}`;
    const res = await transport({
      url: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': token
      },
      body: JSON.stringify(body || {}),
      timeoutMs
    });
    if (res.statusCode !== 200) {
      const err = new Error(`HTTP ${res.statusCode}: ${String(res.text || '').slice(0, 200)}`);
      err.statusCode = res.statusCode;
      throw err;
    }
    try {
      return JSON.parse(res.text || '{}');
    } catch (parseErr) {
      throw new Error(`Invalid JSON from ${method}: ${parseErr.message}`);
    }
  }

  async function call(method, body = {}) {
    const token = await ensureToken(false);
    try {
      return await sendOnce(method, body, token);
    } catch (err) {
      if (err && (err.statusCode === 401 || err.statusCode === 403 || /^HTTP 40[13]\b/.test(err.message))) {
        activeToken = '';
        const refreshed = await ensureToken(true);
        return sendOnce(method, body, refreshed);
      }
      throw err;
    }
  }

  return {
    origin,
    call,
    getUserStatus: () => call('GetUserStatus', {}),
    retrieveUserQuotaSummary: () => call('RetrieveUserQuotaSummary', {}),
    getCascadeTrajectory: (cascadeId) =>
      call('GetCascadeTrajectory', { cascadeId, trajectoryVerbosity: 3 }),
    getCascadeTrajectorySteps: (cascadeId, stepOffset = 0) =>
      call('GetCascadeTrajectorySteps', { cascadeId, stepOffset, trajectoryVerbosity: 3 }),
    getCascadeTrajectoryGeneratorMetadata: (cascadeId, { offset = 0, includeMessages = false } = {}) =>
      call('GetCascadeTrajectoryGeneratorMetadata', {
        cascadeId,
        generatorMetadataOffset: offset,
        includeMessages
      })
  };
}

module.exports = {
  normalizeLoopbackOrigin,
  isPidAlive,
  discoverLiveDaemonHubs,
  loadHostAuthBootstrap,
  resolveCsrfToken,
  createRpcClient
};

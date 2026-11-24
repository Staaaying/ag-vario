'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const rpcClient = require('./rpc-client');
const sqliteReader = require('./sqlite-reader');
const pricing = require('../core/pricing');
const pricingSync = require('../core/pricing-sync');
const quota = require('../core/quota');
const session = require('../core/session');
const context = require('../core/context');
const usage = require('../core/usage');

const DEFAULT_STATE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'ag-vario');
const DEFAULT_QUOTA_TTL_MS = 4 * 60 * 1000;
const DEFAULT_USAGE_SCAN_THROTTLE_MS = 10 * 1000;
const DEFAULT_PRICING_TTL_MS = 24 * 60 * 60 * 1000;
const PRICING_RETRY_MS = 6 * 60 * 60 * 1000;
const MAX_PRICING_DOC_BYTES = 512 * 1024;
const PRICING_CACHE_VERSION = 1;
const AVATAR_POS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AVATAR_NEG_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_AVATAR_BYTES = 256 * 1024;

function defaultFetchText(url, timeoutMs = 6000, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('Invalid URL'));
      return;
    }
    if (parsed.protocol !== 'https:') {
      reject(new Error('Pricing sync only permits HTTPS'));
      return;
    }
    const req = https.get(parsed, { timeout: timeoutMs, headers: { 'User-Agent': 'ag-vario/0.1' } }, (res) => {
      if (
        (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) &&
        res.headers.location &&
        redirectsLeft > 0
      ) {
        const nextUrl = new URL(res.headers.location, parsed).toString();
        res.resume();
        resolve(defaultFetchText(nextUrl, timeoutMs, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_PRICING_DOC_BYTES) {
          req.destroy(new Error('Pricing doc exceeds size limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Pricing fetch timeout')));
    req.on('error', reject);
  });
}

function defaultFetchImage(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('Invalid URL'));
      return;
    }
    if (parsed.protocol !== 'https:') {
      reject(new Error('Avatar fetch only permits HTTPS'));
      return;
    }
    const req = https.get(parsed, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const contentType = String(res.headers['content-type'] || 'image/png').split(';')[0].trim();
      if (!contentType.startsWith('image/')) {
        res.resume();
        reject(new Error('Non-image content type'));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_AVATAR_BYTES) {
          req.destroy(new Error('Avatar exceeds size limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({ contentType, buffer: Buffer.concat(chunks) });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Avatar fetch timeout')));
    req.on('error', reject);
  });
}

function readCustomAvatar(stateDir) {
  const candidates = [
    ['avatar-custom.png', 'image/png'],
    ['avatar-custom.jpg', 'image/jpeg'],
    ['avatar-custom.jpeg', 'image/jpeg'],
    ['avatar-custom.webp', 'image/webp']
  ];
  for (const [filename, mime] of candidates) {
    const filePath = path.join(stateDir, filename);
    try {
      if (!fs.existsSync(filePath)) continue;
      const st = fs.statSync(filePath);
      if (st.size <= 0 || st.size > MAX_AVATAR_BYTES) continue;
      const b64 = fs.readFileSync(filePath).toString('base64');
      return `data:${mime};base64,${b64}`;
    } catch {}
  }
  return null;
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, filePath);
}

function extractChatModelCalls(generatorMetadata = []) {
  const out = [];
  for (const item of Array.isArray(generatorMetadata) ? generatorMetadata : []) {
    if (!item || typeof item !== 'object') continue;
    const cm = item.chatModel || item;
    if (!cm || typeof cm !== 'object') continue;
    out.push({
      ...item,
      chatModel: cm
    });
  }
  return out;
}

function hasContextSectionsOrTools(cm) {
  if (!cm || typeof cm !== 'object') return false;
  const secs = cm.promptSections || cm.prompt_sections || [];
  const tools = cm.tools || [];
  const msgs = cm.messagePrompts || cm.message_prompts || [];
  return secs.length > 0 || tools.length > 0 || msgs.length > 0;
}

function countUserTurnsFromSteps(steps = []) {
  let turns = 0;
  for (const s of Array.isArray(steps) ? steps : []) {
    const t = s?.type ?? s?.stepType ?? s?.step_type;
    if (t === 14 || t === 'CORTEX_STEP_TYPE_USER_INPUT') turns++;
  }
  return turns;
}

function createCollector(options = {}) {
  const dataDir = options.dataDir || sqliteReader.DEFAULT_DATA_DIR;
  const stateDir = options.stateDir || DEFAULT_STATE_DIR;
  const quotaTtlMs = Number.isFinite(Number(options.quotaTtlMs)) ? Number(options.quotaTtlMs) : DEFAULT_QUOTA_TTL_MS;
  const usageScanThrottleMs = Number.isFinite(Number(options.usageScanThrottleMs))
    ? Number(options.usageScanThrottleMs)
    : DEFAULT_USAGE_SCAN_THROTTLE_MS;
  const pricingTtlMs = Number.isFinite(Number(options.pricingTtlMs))
    ? Number(options.pricingTtlMs)
    : DEFAULT_PRICING_TTL_MS;
  const pricingSyncEnabled = options.pricingSyncEnabled !== false;
  const createRpcClientFn = typeof options.createRpcClientFn === 'function'
    ? options.createRpcClientFn
    : rpcClient.createRpcClient;
  const fetchUrlFn = typeof options.fetchUrlFn === 'function' ? options.fetchUrlFn : defaultFetchImage;
  const fetchTextFn = typeof options.fetchTextFn === 'function' ? options.fetchTextFn : defaultFetchText;
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;

  const rpcClientsByOrigin = new Map();
  const quotaCacheByOrigin = new Map();
  let latestProfile = null;
  let cachedClientModelConfigs = [];
  let usageScanCache = null;

  const pricingCachePath = path.join(stateDir, 'pricing-cache-v1.json');
  let pricingState = {
    fetchedAtMs: 0,
    lastAttemptAtMs: 0,
    byVendor: {},
    models: {}
  };
  let pricingRefreshInFlight = null;

  try {
    if (fs.existsSync(pricingCachePath)) {
      const cached = JSON.parse(fs.readFileSync(pricingCachePath, 'utf8'));
      if (cached && cached.version === PRICING_CACHE_VERSION && cached.models && typeof cached.models === 'object') {
        pricingState = {
          fetchedAtMs: Number(cached.fetchedAtMs) || 0,
          lastAttemptAtMs: Number(cached.fetchedAtMs) || 0,
          byVendor: cached.byVendor && typeof cached.byVendor === 'object' ? cached.byVendor : {},
          models: cached.models
        };
        pricing.setDynamicPricing(pricingState.models);
      }
    }
  } catch {}

  async function refreshPricing({ force = false } = {}) {
    if (pricingRefreshInFlight) return pricingRefreshInFlight;
    const nowMs = nowFn();
    if (!force) {
      if (pricingState.fetchedAtMs > 0 && nowMs - pricingState.fetchedAtMs < pricingTtlMs) {
        return {
          ok: true,
          updated: false,
          cached: true,
          count: Object.keys(pricingState.models).length,
          sources: { gemini: false, claude: false }
        };
      }
      if (pricingState.lastAttemptAtMs > 0 && nowMs - pricingState.lastAttemptAtMs < PRICING_RETRY_MS) {
        return {
          ok: false,
          updated: false,
          throttled: true,
          count: Object.keys(pricingState.models).length,
          sources: { gemini: false, claude: false }
        };
      }
    }

    pricingRefreshInFlight = (async () => {
      pricingState.lastAttemptAtMs = nowMs;
      const [gemRes, cldRes] = await Promise.allSettled([
        fetchTextFn(pricingSync.OFFICIAL_PRICING_URLS.gemini),
        fetchTextFn(pricingSync.OFFICIAL_PRICING_URLS.claude)
      ]);

      let gemModels = null;
      let cldModels = null;
      if (gemRes.status === 'fulfilled' && typeof gemRes.value === 'string') {
        try {
          const parsed = pricingSync.parseGeminiPricingMarkdown(gemRes.value);
          if (Object.keys(parsed).length > 0) gemModels = parsed;
        } catch {}
      }
      if (cldRes.status === 'fulfilled' && typeof cldRes.value === 'string') {
        try {
          const parsed = pricingSync.parseClaudePricingMarkdown(cldRes.value);
          if (Object.keys(parsed).length > 0) cldModels = parsed;
        } catch {}
      }

      const sources = { gemini: Boolean(gemModels), claude: Boolean(cldModels) };
      if (!sources.gemini && !sources.claude) {
        return {
          ok: false,
          updated: false,
          count: Object.keys(pricingState.models).length,
          sources
        };
      }

      const merged = pricingSync.mergeSyncedPricing(pricingState.byVendor, {
        gemini: gemModels,
        claude: cldModels
      });
      pricingState = {
        fetchedAtMs: nowMs,
        lastAttemptAtMs: nowMs,
        byVendor: merged.byVendor,
        models: merged.models
      };
      try {
        writeJsonAtomic(pricingCachePath, {
          version: PRICING_CACHE_VERSION,
          fetchedAtMs: nowMs,
          sources,
          byVendor: merged.byVendor,
          models: merged.models
        });
      } catch {}
      pricing.setDynamicPricing(merged.models);

      return {
        ok: true,
        updated: true,
        count: Object.keys(merged.models).length,
        sources
      };
    })().finally(() => {
      pricingRefreshInFlight = null;
    });

    return pricingRefreshInFlight;
  }

  function maybeRefreshPricing() {
    if (!pricingSyncEnabled || pricingRefreshInFlight) return;
    const nowMs = nowFn();
    if (pricingState.fetchedAtMs > 0 && nowMs - pricingState.fetchedAtMs < pricingTtlMs) return;
    if (pricingState.lastAttemptAtMs > 0 && nowMs - pricingState.lastAttemptAtMs < PRICING_RETRY_MS) return;
    void refreshPricing({ force: false }).catch(() => {});
  }

  function getClient(origin) {
    if (!origin) return null;
    const norm = rpcClient.normalizeLoopbackOrigin(origin);
    if (!norm) return null;
    if (!rpcClientsByOrigin.has(norm)) {
      rpcClientsByOrigin.set(norm, createRpcClientFn(norm, { dataDir, authBootstrap: options.authBootstrap }));
    }
    return rpcClientsByOrigin.get(norm);
  }

  async function resolveAvatarDataUrl({ profilePictureUrl = null, email = '' } = {}) {
    const custom = readCustomAvatar(stateDir);
    if (custom) return custom;

    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanUrl = String(profilePictureUrl || '').trim();
    if (
      /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(cleanUrl) &&
      cleanUrl.length <= MAX_AVATAR_BYTES * 1.4
    ) {
      return cleanUrl;
    }
    const cacheKeySource = cleanUrl || (cleanEmail ? `gravatar:${cleanEmail}` : '');
    if (!cacheKeySource) return null;

    const nowMs = nowFn();
    const hash = crypto.createHash('sha256').update(cacheKeySource).digest('hex');
    const cacheFile = path.join(stateDir, 'avatars', `${hash}.json`);

    try {
      if (fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        const age = nowMs - Number(cached?.fetchedAtMs || 0);
        if (cached.dataUrl && age < AVATAR_POS_TTL_MS) return cached.dataUrl;
        if (cached.dataUrl === null && age < AVATAR_NEG_TTL_MS) return null;
      }
    } catch {}

    const tryUrls = [];
    if (cleanUrl.startsWith('https://')) tryUrls.push(cleanUrl);
    if (cleanEmail) {
      const md5 = crypto.createHash('md5').update(cleanEmail).digest('hex');
      tryUrls.push(`https://www.gravatar.com/avatar/${md5}?d=404&s=96`);
    }

    for (const targetUrl of tryUrls) {
      try {
        const res = await fetchUrlFn(targetUrl);
        if (res && res.buffer && res.buffer.length > 0) {
          const mime = res.contentType || 'image/png';
          const dataUrl = `data:${mime};base64,${res.buffer.toString('base64')}`;
          try {
            writeJsonAtomic(cacheFile, { dataUrl, fetchedAtMs: nowMs });
          } catch {}
          return dataUrl;
        }
      } catch {}
    }

    try {
      writeJsonAtomic(cacheFile, { dataUrl: null, fetchedAtMs: nowMs });
    } catch {}
    return null;
  }

  function resolveContextLimit(modelInput, contextLimitHint, callLimit = null) {
    const direct = Number(callLimit);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const fromConfigs = quota.lookupContextLimit(modelInput, cachedClientModelConfigs);
    if (fromConfigs) return fromConfigs;
    const hint = Number(contextLimitHint);
    return Number.isFinite(hint) && hint > 0 ? hint : null;
  }

  async function getQuotaSnapshot({ origin, force = false, currentModel = null } = {}) {
    maybeRefreshPricing();
    const nowMs = nowFn();
    const normOrigin = rpcClient.normalizeLoopbackOrigin(origin) || '__default__';
    const existing = quotaCacheByOrigin.get(normOrigin);

    if (!force && existing && nowMs - existing.fetchedAtMs < quotaTtlMs) {
      const rebuilt = quota.buildQuotaSnapshot({
        quotaSummaryRes: existing.quotaSummaryRes,
        userStatusRes: existing.userStatusRes,
        nowMs,
        updatedAtMs: existing.fetchedAtMs,
        currentModel
      });
      rebuilt.profile.avatarDataUrl = existing.avatarDataUrl || null;
      return { ok: true, cached: true, data: rebuilt };
    }

    const client = getClient(origin);
    if (!client) {
      return { ok: false, error: 'Invalid or unavailable local server origin' };
    }

    const [summaryRes, statusRes] = await Promise.allSettled([
      client.retrieveUserQuotaSummary(),
      client.getUserStatus()
    ]);

    const quotaSummaryRes = summaryRes.status === 'fulfilled' ? summaryRes.value : null;
    const userStatusRes = statusRes.status === 'fulfilled' ? statusRes.value : null;

    if (!quotaSummaryRes && !userStatusRes) {
      const errMsg = summaryRes.reason?.message || statusRes.reason?.message || 'Quota RPC failed';
      return { ok: false, error: errMsg };
    }

    const snap = quota.buildQuotaSnapshot({
      quotaSummaryRes,
      userStatusRes,
      nowMs,
      updatedAtMs: nowMs,
      currentModel
    });

    if (Array.isArray(snap.clientModelConfigs) && snap.clientModelConfigs.length > 0) {
      cachedClientModelConfigs = snap.clientModelConfigs;
    }

    let avatarDataUrl = existing?.avatarDataUrl || null;
    try {
      avatarDataUrl = await resolveAvatarDataUrl({
        profilePictureUrl: snap.profile.profilePictureUrl,
        email: snap.profile.email
      });
    } catch {}
    snap.profile.avatarDataUrl = avatarDataUrl;
    latestProfile = snap.profile;

    quotaCacheByOrigin.set(normOrigin, {
      fetchedAtMs: nowMs,
      quotaSummaryRes,
      userStatusRes,
      avatarDataUrl
    });

    return { ok: true, cached: false, data: snap };
  }

  async function loadCallsForConversation(origin, conversationId, { includeMessages = false } = {}) {
    const dbPath = path.join(dataDir, 'conversations', `${conversationId}.db`);
    let calls = null;
    let turns = null;
    let lastStepHasError = false;
    let source = 'rpc';

    const client = getClient(origin);
    if (client) {
      try {
        const res = await client.getCascadeTrajectoryGeneratorMetadata(conversationId, {
          offset: 0,
          includeMessages
        });
        const list = extractChatModelCalls(res?.generatorMetadata);
        if (list.length > 0) calls = list;
      } catch {}
    }

    if (fs.existsSync(dbPath)) {
      try {
        const dbRes = sqliteReader.readConversationDb(dbPath, { includeContext: false });
        turns = dbRes.turns;
        lastStepHasError = dbRes.lastStepHasError;
        if (!calls) {
          calls = dbRes.calls;
          source = 'sqlite';
        }
      } catch {}
    }

    if (turns === null && client) {
      try {
        const traj = await client.getCascadeTrajectory(conversationId);
        turns = countUserTurnsFromSteps(traj?.trajectory?.steps);
      } catch {}
    }

    return {
      calls: calls || [],
      turns: turns || 0,
      lastStepHasError,
      source
    };
  }

  async function getSessionSnapshot({ origin = null, conversationId, contextLimitHint = null } = {}) {
    maybeRefreshPricing();
    if (!conversationId) {
      return { ok: false, error: 'Missing conversationId' };
    }

    const summaries = sqliteReader.readConversationSummaries(dataDir);
    const meta = summaries.byId.get(conversationId);
    const mainData = await loadCallsForConversation(origin, conversationId, { includeMessages: false });

    const preStats = session.computeSessionStats({
      conversationId,
      title: meta?.title || conversationId.slice(0, 8),
      turns: mainData.turns,
      calls: mainData.calls,
      contextLimit: null
    });
    const resolvedLimit = resolveContextLimit(
      preStats.latestModel || preStats.primaryModel,
      contextLimitHint,
      preStats.waterline?.contextLimit
    );
    const mainStats = resolvedLimit
      ? session.computeSessionStats({
          conversationId,
          title: meta?.title || conversationId.slice(0, 8),
          turns: mainData.turns,
          calls: mainData.calls,
          contextLimit: resolvedLimit
        })
      : preStats;

    const children = summaries.childrenByRoot.get(conversationId) || [];
    const childStatsList = [];
    for (const childMeta of children) {
      const childId = childMeta.conversationId;
      const dbPath = path.join(dataDir, 'conversations', `${childId}.db`);
      let childCalls = [];
      let childLastErr = false;

      if (childMeta.normalizedStatus === 'Running' && origin) {
        const loaded = await loadCallsForConversation(origin, childId, { includeMessages: false });
        childCalls = loaded.calls;
        childLastErr = loaded.lastStepHasError;
      } else if (fs.existsSync(dbPath)) {
        try {
          const dbRes = sqliteReader.readConversationDb(dbPath, { includeContext: false });
          childCalls = dbRes.calls;
          childLastErr = dbRes.lastStepHasError;
        } catch {}
      }

      const preChild = session.computeSessionStats({
        conversationId: childId,
        title: childMeta.title,
        calls: childCalls
      });
      const childLimit = resolveContextLimit(
        preChild.latestModel || preChild.primaryModel,
        contextLimitHint,
        preChild.waterline?.contextLimit
      );
      const childStats = childLimit
        ? session.computeSessionStats({
            conversationId: childId,
            title: childMeta.title,
            calls: childCalls,
            contextLimit: childLimit
          })
        : preChild;

      childStatsList.push({
        ...childStats,
        kind: childMeta.kind,
        status: childMeta.status,
        killed: childMeta.killed,
        lastStepHasError: childLastErr,
        normalizedStatus: session.normalizeSubagentStatus({
          status: childMeta.status,
          killed: childMeta.killed,
          lastStepHasError: childLastErr
        })
      });
    }

    const combined = session.combineSessionWithSubagents(mainStats, childStatsList);
    return {
      ok: true,
      conversationId,
      source: mainData.source,
      data: combined
    };
  }

  async function getContextBreakdown({ origin = null, conversationId, contextLimitHint = null } = {}) {
    if (!conversationId) {
      return { ok: false, error: 'Missing conversationId' };
    }

    let chatModel = null;
    let source = 'rpc';
    const client = getClient(origin);
    if (client) {
      try {
        const res = await client.getCascadeTrajectoryGeneratorMetadata(conversationId, {
          offset: 0,
          includeMessages: true
        });
        const list = Array.isArray(res?.generatorMetadata) ? res.generatorMetadata : [];
        for (let i = list.length - 1; i >= 0; i--) {
          const cm = list[i]?.chatModel;
          if (cm && hasContextSectionsOrTools(cm)) {
            chatModel = cm;
            break;
          }
        }
        if (!chatModel && list.length > 0) {
          chatModel = list[list.length - 1]?.chatModel || null;
        }
      } catch {}
    }

    if (!chatModel || !hasContextSectionsOrTools(chatModel)) {
      const dbPath = path.join(dataDir, 'conversations', `${conversationId}.db`);
      if (fs.existsSync(dbPath)) {
        try {
          const detail = sqliteReader.readConversationDb(dbPath, { includeContext: true });
          if (detail.contextChatModel) {
            chatModel = detail.contextChatModel;
            source = 'sqlite';
          }
        } catch {}
      }
    }

    if (!chatModel) {
      return { ok: false, error: 'Context metadata unavailable for this session' };
    }

    const callLimit =
      chatModel.maxContextTokens ??
      chatModel.chatStartMetadata?.contextWindowMetadata?.maxContextTokens ??
      chatModel.chat_start_metadata?.context_window_metadata?.max_context_tokens ??
      null;
    const limit = resolveContextLimit(chatModel, contextLimitHint, callLimit);
    return {
      ok: true,
      conversationId,
      source,
      data: context.computeContextBreakdown(chatModel, { contextLimit: limit })
    };
  }

  function ensureUsageScan(force = false) {
    const nowMs = nowFn();
    if (!force && usageScanCache && nowMs - usageScanCache.scannedAtMs < usageScanThrottleMs) {
      return usageScanCache.scan;
    }
    const cachePath = path.join(stateDir, 'conversations-cache-v1.json');
    const scan = sqliteReader.scanConversationsIncremental({ dataDir, cachePath });
    usageScanCache = { scannedAtMs: nowMs, scan };
    return scan;
  }

  async function getUsageReport({ period = '7D', selectedDateKey = null, force = false } = {}) {
    maybeRefreshPricing();
    const scan = ensureUsageScan(force);
    const report = usage.computeUsageReport(scan.sessions, {
      period,
      nowMs: nowFn(),
      selectedDateKey
    });
    return {
      ok: true,
      data: report,
      profile: latestProfile,
      scanStats: scan.stats
    };
  }

  async function getTodayUsageSummary({ force = false } = {}) {
    const scan = ensureUsageScan(force);
    const report = usage.computeUsageReport(scan.sessions, {
      period: '7D',
      nowMs: nowFn()
    });
    return {
      ok: true,
      data: report.today
    };
  }

  return {
    getQuotaSnapshot,
    getSessionSnapshot,
    getContextBreakdown,
    getUsageReport,
    getTodayUsageSummary,
    resolveAvatarDataUrl,
    refreshPricing
  };
}

module.exports = {
  DEFAULT_STATE_DIR,
  createCollector
};

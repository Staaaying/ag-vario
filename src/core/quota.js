'use strict';

/**
 * Quota pool classification, user tier/profile parsing, and dual-window (5h / 7d) aggregation.
 *
 * MIT Attribution: Quota fraction rules, userTier precedence, and Orchestrator
 * pool-matching conventions reference `antigravity-context-viewer`
 * (Copyright (c) 2026 Antigravity Context Viewer Contributors, MIT License).
 */

const { resolveModelIdentity } = require('./pricing');

const POOL_TITLES = {
  gemini_main: 'Gemini Models',
  gemini_carbon: 'Gemini Carbon',
  gemini_argon: 'Gemini Argon',
  claude_3p: 'Claude and GPT models'
};

function parseTimestampMs(val) {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) && val > 0 ? val : null;
  if (typeof val === 'string') {
    const ms = Date.parse(val);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof val === 'object') {
    const sec = Number(val.seconds || 0);
    const nanos = Number(val.nanos || 0);
    if (!Number.isFinite(sec) || !Number.isFinite(nanos)) return null;
    const ms = sec * 1000 + nanos / 1e6;
    return ms > 0 ? ms : null;
  }
  return null;
}

function formatCountdown(resetAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(resetAtMs)) return null;
  const diffMs = resetAtMs - nowMs;
  if (diffMs <= 0) return 'Resetting';
  const totalMin = Math.floor(diffMs / 60000);
  if (totalMin < 1) return '<1m';
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function computeInitials(name, email) {
  const source = String(name || '').trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    return source.slice(0, 2).toUpperCase();
  }
  const mail = String(email || '').trim();
  if (mail) return mail.slice(0, 2).toUpperCase();
  return '?';
}

/**
 * Parse user profile and subscription tier from GetUserStatus response.
 * Precedence: userTier.id / userTier.name / g1Tier FIRST, planInfo ONLY as fallback.
 */
function parseUserProfile(userStatusRes) {
  const us = userStatusRes?.userStatus || userStatusRes || {};
  const userTier = us.userTier || us.user_tier || {};
  const g1Tier = us.g1Tier || us.g1_tier || {};
  const planInfo = us.planInfo || us.plan_info || {};

  const primaryHints = [
    userTier.id,
    userTier.name,
    typeof g1Tier === 'string' ? g1Tier : g1Tier.id || g1Tier.name
  ]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ');

  const fallbackHints = [planInfo.planName, planInfo.plan_name, planInfo.teamsTier, planInfo.teams_tier]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ');

  const tierSource = primaryHints || fallbackHints;
  const userTierName = String(userTier.name || '').trim();
  let tier = null;
  let planBadge = null;
  let planFullName = null;
  if (/ultra/i.test(tierSource)) {
    tier = 'ultra';
    planBadge = 'Ultra';
    planFullName = /ultra[-_\s]?lite/i.test(tierSource)
      ? 'Google AI Ultra (5x)'
      : 'Google AI Ultra (20x)';
  } else if (/pro/i.test(tierSource)) {
    tier = 'pro';
    planBadge = 'Pro';
    planFullName = userTierName || 'Google AI Pro';
  } else if (/plus/i.test(tierSource)) {
    tier = 'plus';
    planBadge = 'Plus';
    planFullName = userTierName || 'Google AI Plus';
  } else if (/free/i.test(tierSource)) {
    tier = 'free';
    planBadge = 'Free';
    planFullName = userTierName || 'Free';
  } else {
    planFullName = userTierName || null;
  }

  const name = String(us.name || '').trim();
  const email = String(us.email || '').trim();
  const profilePictureUrl = String(us.profilePictureUrl || us.profile_picture_url || '').trim() || null;

  return {
    name,
    email,
    profilePictureUrl,
    initials: computeInitials(name, email),
    tier,
    planBadge,
    planFullName,
    rawTierId: userTier.id || null
  };
}

function resolveQuotaPoolKey(input) {
  if (!input) return 'unknown';
  const text =
    typeof input === 'string'
      ? input
      : [
          input.groupId,
          input.displayName,
          input.label,
          input.modelDisplayName,
          input.responseModel,
          input.modelEnum,
          input.modelId,
          input.modelOrAlias?.model,
          typeof input.model === 'string' ? input.model : '',
          input.description
        ]
          .filter(Boolean)
          .join(' ');

  const s = text.toLowerCase();
  if (!s.trim()) return 'unknown';
  if (s.includes('3p') || s.includes('claude') || s.includes('opus') || s.includes('sonnet') || s.includes('gpt-oss')) {
    return 'claude_3p';
  }
  if (s.includes('carbon') || /\bm667\b|\bm670\b/.test(s)) {
    return 'gemini_carbon';
  }
  if (s.includes('argon') || /\bm668\b|\bm681\b|\bgemini-pro-orchestrator\b/.test(s)) {
    return 'gemini_argon';
  }
  if (s.includes('neon') || s.includes('hydrogen') || s.includes('flash') || s.includes('gemini')) {
    return 'gemini_main';
  }
  return `group_${s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'other'}`;
}

function parseBucketWindow(windowStr, bucketId = '') {
  const raw = String(windowStr || bucketId || '').trim().toLowerCase();
  if (raw.includes('5h') || raw.includes('5_hour') || raw === 'hour') {
    return { windowKey: '5h', shortLabel: '5h', label: '5h limit' };
  }
  if (raw.includes('weekly') || raw.includes('7d') || raw.includes('week')) {
    return { windowKey: '7d', shortLabel: '7d', label: 'Weekly limit' };
  }
  if (raw.includes('daily') || raw.includes('24h') || raw === 'day') {
    return { windowKey: '24h', shortLabel: '24h', label: 'Daily limit' };
  }
  const match = raw.match(/^(\d+[smhd])$/);
  if (match) {
    return { windowKey: match[1], shortLabel: match[1], label: `${match[1]} limit` };
  }
  return { windowKey: raw || 'quota', shortLabel: '', label: 'Quota limit' };
}

function parseQuotaFraction(raw, { schemaKind = 'quota_summary_bucket', unavailable = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  for (const val of [raw.remainingFraction, raw.remaining_fraction, raw.fraction]) {
    if (typeof val === 'number' && Number.isFinite(val)) {
      return Math.max(0, Math.min(1, val));
    }
  }
  const hasReset = parseTimestampMs(raw.resetTime || raw.reset_time) !== null;
  if (schemaKind === 'codeium_quota_info' && !unavailable && !raw.disabled && hasReset) {
    return 0;
  }
  return null;
}

function extractContextLimitFromConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const direct = Number(cfg.maxContextTokens ?? cfg.contextWindow ?? cfg.contextWindowSize ?? cfg.maxTokens);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const options = cfg.contextWindowOptions || cfg.context_window_options;
  if (Array.isArray(options) && options.length > 0) {
    const nums = options
      .map((opt) => (typeof opt === 'number' ? opt : Number(opt?.maxTokens ?? opt?.tokens ?? opt?.value)))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (nums.length > 0) return Math.max(...nums);
  }
  return null;
}

function normalizeModelLabel(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(low|medium|high|xhigh|extra\s*high)\b/g, ' ')
    .replace(/[^a-z0-9.]+/g, ' ')
    .trim();
}

function lookupContextLimit(modelInput, clientModelConfigs = []) {
  if (!modelInput || !Array.isArray(clientModelConfigs) || clientModelConfigs.length === 0) return null;
  const target = resolveModelIdentity(modelInput);
  const rawHints = typeof modelInput === 'string'
    ? [modelInput]
    : [modelInput.modelDisplayName, modelInput.label, modelInput.modelEnum, modelInput.responseModel, modelInput.modelId];
  const cleanHints = rawHints.filter(Boolean).map((s) => String(s).trim().toLowerCase());

  for (const cfg of clientModelConfigs) {
    const cfgIds = [cfg.modelOrAlias?.model, cfg.modelId, cfg.model, cfg.label]
      .filter(Boolean)
      .map((s) => String(s).trim().toLowerCase());
    if (cleanHints.some((h) => cfgIds.includes(h))) {
      const limit = extractContextLimitFromConfig(cfg);
      if (limit) return limit;
    }
  }

  for (const cfg of clientModelConfigs) {
    const cfgNorm = normalizeModelLabel(cfg.label || cfg.modelId);
    const targetNorm = normalizeModelLabel(target.displayName);
    if (cfgNorm && targetNorm && (cfgNorm === targetNorm || cfgNorm.includes(targetNorm) || targetNorm.includes(cfgNorm))) {
      const limit = extractContextLimitFromConfig(cfg);
      if (limit) return limit;
    }
    const cfgFamily = resolveModelIdentity(cfg).modelKey;
    if (target.modelKey && target.modelKey !== 'unknown' && cfgFamily === target.modelKey) {
      const limit = extractContextLimitFromConfig(cfg);
      if (limit) return limit;
    }
  }
  return null;
}

function buildBucketRecord(rawBucket, nowMs, schemaKind) {
  const resetAtMs = parseTimestampMs(rawBucket.resetTime || rawBucket.reset_time);
  const win = parseBucketWindow(rawBucket.window, rawBucket.bucketId || rawBucket.id);
  const fraction = parseQuotaFraction(rawBucket, { schemaKind, unavailable: Boolean(rawBucket.disabled) });
  return {
    bucketId: rawBucket.bucketId || rawBucket.id || win.windowKey,
    windowKey: win.windowKey,
    shortLabel: win.shortLabel,
    label: win.label,
    remainingFraction: fraction,
    percent: fraction !== null ? Math.round(fraction * 100) : null,
    resetAtMs,
    resetTimeIso: resetAtMs !== null ? new Date(resetAtMs).toISOString() : null,
    countdown: formatCountdown(resetAtMs, nowMs),
    disabled: Boolean(rawBucket.disabled)
  };
}

function resolveSummaryGroupMeta(group) {
  if (!group || typeof group !== 'object') {
    return { poolKey: 'unknown', title: 'Quota' };
  }
  const rawTitle = String(group.displayName || group.name || group.groupId || '').trim();
  const hints = [group.groupId, group.displayName, group.name, group.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (hints.includes('3p') || hints.includes('claude') || hints.includes('opus') || hints.includes('sonnet') || hints.includes('gpt-oss')) {
    return { poolKey: 'claude_3p', title: POOL_TITLES.claude_3p };
  }
  const mentionsArgon = hints.includes('argon') || /\bm668\b|\bm681\b/.test(hints);
  const mentionsCarbon = hints.includes('carbon') || /\bm667\b|\bm670\b/.test(hints);
  const mentionsMainGemini = hints.includes('hydrogen') || hints.includes('neon') || hints.includes('flash');

  if (mentionsArgon && !mentionsMainGemini && !mentionsCarbon) {
    return { poolKey: 'gemini_argon', title: POOL_TITLES.gemini_argon };
  }
  if (mentionsCarbon && !mentionsMainGemini && !mentionsArgon) {
    return { poolKey: 'gemini_carbon', title: POOL_TITLES.gemini_carbon };
  }
  if (hints.includes('gemini') || mentionsMainGemini || mentionsCarbon || mentionsArgon) {
    return { poolKey: 'gemini_main', title: POOL_TITLES.gemini_main };
  }
  return {
    poolKey: resolveQuotaPoolKey(group),
    title: rawTitle || 'Quota'
  };
}

const WEEK_MS = 7 * 24 * 3600 * 1000;
const EARLY_WINDOW_MS = 3 * 3600 * 1000;

function computeWeeklyCycleInfo(bucket7d, nowMs = Date.now()) {
  if (!bucket7d) return null;
  let lastResetAtMs = null;
  let elapsedMs = null;

  if (Number.isFinite(bucket7d.resetAtMs)) {
    const remainingMs = bucket7d.resetAtMs - nowMs;
    if (bucket7d.remainingFraction === 1 && remainingMs >= WEEK_MS - 60000) {
      lastResetAtMs = null;
      elapsedMs = 0;
    } else if (remainingMs > 0 && remainingMs <= WEEK_MS + 60000) {
      lastResetAtMs = bucket7d.resetAtMs - WEEK_MS;
      elapsedMs = Math.max(0, Math.min(WEEK_MS, nowMs - lastResetAtMs));
    }
  }

  const rem = bucket7d.remainingFraction;
  let pace = null;
  if (rem === null || rem === undefined) {
    pace = null;
  } else if (rem >= 1) {
    pace = { state: 'on_track', label: 'On track · 0.0×', multiplier: 0, tone: 'ok' };
  } else if (rem <= 0) {
    pace = { state: 'depleted', label: 'Depleted', multiplier: null, tone: 'risk' };
  } else if (elapsedMs !== null) {
    const used = 1 - rem;
    if (elapsedMs < EARLY_WINDOW_MS && used < 0.10) {
      pace = { state: 'early', label: 'Early cycle', multiplier: null, tone: 'muted' };
    } else {
      const effElapsedMs = Math.max(elapsedMs, 15 * 60 * 1000);
      const projectedUsed = used * (WEEK_MS / effElapsedMs);
      const multText = projectedUsed > 9.9 ? '>9.9×' : `${projectedUsed.toFixed(1)}×`;
      if (projectedUsed <= 0.90) {
        pace = { state: 'on_track', label: `On track · ${multText}`, multiplier: projectedUsed, tone: 'ok' };
      } else if (projectedUsed <= 1.05) {
        pace = { state: 'on_pace', label: `On pace · ${multText}`, multiplier: projectedUsed, tone: 'ice' };
      } else {
        pace = {
          state: 'high_burn',
          label: `High burn · ${multText}`,
          multiplier: projectedUsed,
          tone: projectedUsed > 1.30 ? 'risk' : 'warn'
        };
      }
    }
  }

  return { lastResetAtMs, elapsedMs, pace };
}

function selectActivePool(pools, currentModel) {
  if (!Array.isArray(pools) || pools.length === 0) return null;
  const desiredKey = currentModel ? resolveQuotaPoolKey(currentModel) : null;
  if (desiredKey) {
    const exact = pools.find((p) => p.poolKey === desiredKey);
    if (exact) return exact;
    if (desiredKey.startsWith('gemini_')) {
      const geminiFallback = pools.find((p) => p.poolKey === 'gemini_main') || pools.find((p) => p.poolKey.startsWith('gemini_'));
      if (geminiFallback) return geminiFallback;
    }
  }
  return pools.find((p) => p.poolKey === 'gemini_main') || pools.find((p) => p.poolKey.startsWith('gemini_')) || pools[0];
}

function buildQuotaSnapshot({
  quotaSummaryRes = null,
  userStatusRes = null,
  nowMs = Date.now(),
  updatedAtMs = null,
  currentModel = null
} = {}) {
  const profile = parseUserProfile(userStatusRes);
  const us = userStatusRes?.userStatus || userStatusRes || {};
  const configs = Array.isArray(us?.cascadeModelConfigData?.clientModelConfigs)
    ? us.cascadeModelConfigData.clientModelConfigs
    : [];

  const summaryRoot = quotaSummaryRes?.response || quotaSummaryRes || {};
  const rawGroups = Array.isArray(summaryRoot.groups) ? summaryRoot.groups : [];
  const topBuckets = Array.isArray(summaryRoot.buckets) ? summaryRoot.buckets : [];

  const poolMap = new Map();
  const ensurePool = (poolKey, titleHint) => {
    let pool = poolMap.get(poolKey);
    if (!pool) {
      pool = {
        poolKey,
        title: POOL_TITLES[poolKey] || titleHint || poolKey,
        models: [],
        buckets: []
      };
      poolMap.set(poolKey, pool);
    }
    return pool;
  };

  const hasAuthoritativeSummary = rawGroups.length > 0 || topBuckets.length > 0;

  for (const g of rawGroups) {
    const meta = resolveSummaryGroupMeta(g);
    const pool = ensurePool(meta.poolKey, meta.title);
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      pool.buckets.push(buildBucketRecord(b, nowMs, 'quota_summary_bucket'));
    }
  }

  for (const b of topBuckets) {
    const meta = resolveSummaryGroupMeta(b);
    const pool = ensurePool(meta.poolKey, meta.title);
    pool.buckets.push(buildBucketRecord(b, nowMs, 'quota_summary_bucket'));
  }

  for (const cfg of configs) {
    if (!cfg || cfg.isInternal || cfg.isHistorical) continue;
    const rawId = String(cfg.modelId || cfg.modelOrAlias?.model || '').toLowerCase();
    if (/^chat_\d+$/.test(rawId) || rawId.startsWith('tab_')) continue;

    const poolKey = resolveQuotaPoolKey(cfg);
    const modelName = resolveModelIdentity(cfg).displayName;

    if (hasAuthoritativeSummary) {
      let targetPool = poolMap.get(poolKey) || null;
      if (!targetPool && poolKey.startsWith('gemini_')) {
        targetPool = poolMap.get('gemini_main') || Array.from(poolMap.values()).find((p) => p.poolKey.startsWith('gemini_')) || null;
      }
      if (targetPool && modelName && !targetPool.models.includes(modelName)) {
        targetPool.models.push(modelName);
      }
      continue;
    }

    const pool = ensurePool(poolKey, cfg.label || poolKey);
    if (modelName && !pool.models.includes(modelName)) pool.models.push(modelName);

    if (pool.buckets.length === 0 && cfg.quotaInfo) {
      const qi = buildBucketRecord(
        {
          bucketId: 'config-default',
          window: poolKey === 'gemini_argon' ? '7d' : '5h',
          ...cfg.quotaInfo
        },
        nowMs,
        'codeium_quota_info'
      );
      if (qi.remainingFraction !== null || qi.resetAtMs !== null) {
        pool.buckets.push(qi);
      }
    }
  }

  const pools = [];
  let nextResetAtMs = null;

  for (const pool of poolMap.values()) {
    const bucket5h = pool.buckets.find((b) => b.windowKey === '5h') || null;
    const bucket7d = pool.buckets.find((b) => b.windowKey === '7d') || null;
    const priced = pool.buckets.filter((b) => b.remainingFraction !== null);
    const tightest = priced.length
      ? priced.slice().sort((a, b) => a.remainingFraction - b.remainingFraction)[0]
      : null;

    let poolNextReset = null;
    for (const b of pool.buckets) {
      if (b.resetAtMs !== null && (poolNextReset === null || b.resetAtMs < poolNextReset)) {
        poolNextReset = b.resetAtMs;
      }
      if (b.resetAtMs !== null && b.resetAtMs > nowMs && (nextResetAtMs === null || b.resetAtMs < nextResetAtMs)) {
        nextResetAtMs = b.resetAtMs;
      }
    }

    pools.push({
      ...pool,
      bucket5h,
      bucket7d,
      weeklyCycle: computeWeeklyCycleInfo(bucket7d, nowMs),
      tightestFraction: tightest ? tightest.remainingFraction : null,
      tightestPercent: tightest ? tightest.percent : null,
      nextResetAtMs: poolNextReset,
      nextResetCountdown: formatCountdown(poolNextReset, nowMs)
    });
  }

  const activePool = selectActivePool(pools, currentModel);
  const lastResetAtMs = parseTimestampMs(summaryRoot.lastResetTime || summaryRoot.last_reset_time);

  const ringFor = (bucket) =>
    bucket && bucket.remainingFraction !== null && activePool
      ? { ...bucket, poolKey: activePool.poolKey, poolTitle: activePool.title }
      : null;

  return {
    profile,
    updatedAtMs: updatedAtMs ?? nowMs,
    lastReset: lastResetAtMs
      ? { atMs: lastResetAtMs, iso: new Date(lastResetAtMs).toISOString() }
      : null,
    nextReset: nextResetAtMs
      ? {
          atMs: nextResetAtMs,
          iso: new Date(nextResetAtMs).toISOString(),
          countdown: formatCountdown(nextResetAtMs, nowMs)
        }
      : null,
    summaryRings: {
      window5h: ringFor(activePool?.bucket5h),
      window7d: ringFor(activePool?.bucket7d)
    },
    pools,
    clientModelConfigs: configs
  };
}

module.exports = {
  parseTimestampMs,
  formatCountdown,
  parseUserProfile,
  resolveQuotaPoolKey,
  parseBucketWindow,
  parseQuotaFraction,
  lookupContextLimit,
  computeWeeklyCycleInfo,
  buildQuotaSnapshot
};

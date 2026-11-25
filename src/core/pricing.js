'use strict';

/**
 * Official API public pricing table (USD per 1M tokens) & model normalization.
 * Output price already covers thinking + response tokens (never double-counted).
 *
 * MIT Attribution: Pricing tier rules and model normalization conventions
 * reference `antigravity-context-viewer` (Copyright (c) 2026 Antigravity Context
 * Viewer Contributors, MIT License).
 */

const PRICING_TABLE = {
  'gemini-4-hydrogen': [
    { inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.075 }
  ],
  'gemini-4-carbon': [
    { effectiveTo: '2026-11-30', inputPerMillion: 2.00, outputPerMillion: 10.00, cacheReadPerMillion: 0.10 },
    { effectiveFrom: '2026-12-01', inputPerMillion: 4.00, outputPerMillion: 20.00, cacheReadPerMillion: 0.20 }
  ],
  'gemini-4-argon': [
    { effectiveTo: '2026-11-30', inputPerMillion: 2.00, outputPerMillion: 10.00, cacheReadPerMillion: 0.10 },
    { effectiveFrom: '2026-12-01', inputPerMillion: 4.00, outputPerMillion: 20.00, cacheReadPerMillion: 0.20 }
  ],
  'gemini-3.8-flash': [
    { effectiveTo: '2026-12-31', inputPerMillion: 0.75, outputPerMillion: 3.75, cacheReadPerMillion: 0.075 },
    { effectiveFrom: '2027-01-01', inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.15 }
  ],
  'gemini-3.5-flash-lite': [
    { inputPerMillion: 0.30, outputPerMillion: 2.50, cacheReadPerMillion: 0.03 }
  ],
  'gemini-3.1-pro-preview': [
    { maxPromptTokens: 200000, inputPerMillion: 2.00, outputPerMillion: 12.00, cacheReadPerMillion: 0.20 },
    { minPromptTokens: 200001, inputPerMillion: 4.00, outputPerMillion: 18.00, cacheReadPerMillion: 0.40 }
  ],
  'gemini-2.5-pro': [
    { maxPromptTokens: 200000, inputPerMillion: 1.25, outputPerMillion: 10.00, cacheReadPerMillion: 0.125 },
    { minPromptTokens: 200001, inputPerMillion: 2.50, outputPerMillion: 15.00, cacheReadPerMillion: 0.25 }
  ],
  'claude-opus-5-5': [
    { inputPerMillion: 4.00, outputPerMillion: 20.00, cacheReadPerMillion: 0.20 }
  ],
  'claude-sonnet-5-5': [
    { inputPerMillion: 2.00, outputPerMillion: 10.00, cacheReadPerMillion: 0.10 }
  ],
  'gemini-4-neon': [
    { inputPerMillion: 3.00, outputPerMillion: 15.00, cacheReadPerMillion: 0.15 }
  ]
};

const dynamicPricing = new Map();
const dynamicDisplayNames = new Map();

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function validatePricingRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const out = [];
  for (const r of rules) {
    if (!r || typeof r !== 'object') return null;
    const inputPerMillion = Number(r.inputPerMillion);
    const outputPerMillion = Number(r.outputPerMillion);
    const cacheReadPerMillion = r.cacheReadPerMillion !== undefined ? Number(r.cacheReadPerMillion) : 0;
    if (!Number.isFinite(inputPerMillion) || inputPerMillion <= 0 || inputPerMillion >= 500) return null;
    if (!Number.isFinite(outputPerMillion) || outputPerMillion <= 0 || outputPerMillion >= 1000) return null;
    if (!Number.isFinite(cacheReadPerMillion) || cacheReadPerMillion < 0 || cacheReadPerMillion > inputPerMillion) {
      return null;
    }

    const normalized = { inputPerMillion, outputPerMillion, cacheReadPerMillion };
    if (r.effectiveFrom !== undefined && r.effectiveFrom !== null) {
      const s = String(r.effectiveFrom).trim();
      if (!DATE_KEY_RE.test(s)) return null;
      normalized.effectiveFrom = s;
    }
    if (r.effectiveTo !== undefined && r.effectiveTo !== null) {
      const s = String(r.effectiveTo).trim();
      if (!DATE_KEY_RE.test(s)) return null;
      normalized.effectiveTo = s;
    }
    if (r.minPromptTokens !== undefined && r.minPromptTokens !== null) {
      const n = Number(r.minPromptTokens);
      if (!Number.isFinite(n) || n < 0) return null;
      normalized.minPromptTokens = Math.floor(n);
    }
    if (r.maxPromptTokens !== undefined && r.maxPromptTokens !== null) {
      const n = Number(r.maxPromptTokens);
      if (!Number.isFinite(n) || n < 0) return null;
      normalized.maxPromptTokens = Math.floor(n);
    }
    out.push(normalized);
  }
  return out;
}

function setDynamicPricing(modelsMap) {
  dynamicPricing.clear();
  dynamicDisplayNames.clear();
  if (!modelsMap || typeof modelsMap !== 'object') return 0;

  let loaded = 0;
  for (const [rawKey, entry] of Object.entries(modelsMap)) {
    const modelKey = String(rawKey || '').trim().toLowerCase();
    if (!modelKey) continue;
    const rawRules = Array.isArray(entry) ? entry : entry?.rules;
    const valid = validatePricingRules(rawRules);
    if (!valid) continue;
    dynamicPricing.set(modelKey, valid);
    if (entry && !Array.isArray(entry) && typeof entry.displayName === 'string' && entry.displayName.trim()) {
      dynamicDisplayNames.set(modelKey, entry.displayName.trim());
    }
    loaded++;
  }
  return loaded;
}

function clearDynamicPricing() {
  dynamicPricing.clear();
  dynamicDisplayNames.clear();
}

function hasPricingKey(key) {
  return Boolean(key && (dynamicPricing.has(key) || Object.prototype.hasOwnProperty.call(PRICING_TABLE, key)));
}

function getEffectivePricingTable() {
  return {
    ...PRICING_TABLE,
    ...Object.fromEntries(dynamicPricing.entries())
  };
}

const FAMILY_DISPLAY_NAMES = {
  'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
  'gemini-4-carbon': 'Gemini 4 Carbon',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-4-neon': 'Gemini 4 Neon',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5'
};

// Verified v2.34.0 integer Model enum fallbacks from local SQLite databases
const MODEL_ENUM_FALLBACK = {
  1400: 'Claude Opus 5.5 (Low)',
  1402: 'Claude Opus 5.5 (High)',
  1417: 'Gemini 4 Argon (High)',
  1418: 'Gemini 4 Argon (Medium)',
  1437: 'Gemini 4 Carbon (Medium)',
  1525: 'Gemini 4 Hydrogen (High)',
  1526: 'Gemini 4 Hydrogen (Medium)',
  1527: 'Gemini 4 Hydrogen (Low)',
  1530: 'Gemini 4 Hydrogen (High)',
  1532: 'Gemini 4 Neon (High)',
  1533: 'Gemini 4 Neon (Medium)',
  1534: 'Gemini 4 Neon (Low)',
  1535: 'Gemini 4 Neon (XHigh)',
  1667: 'Orchestrator (Carbon)'
};

function stripEffortSuffix(name) {
  return String(name || '')
    .replace(/\s*\((?:Minimal|Low|Medium|High|XHigh|Extra\s*High|Max)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEffortSuffix(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  let m = s.match(/\((Minimal|Low|Medium|High|XHigh|Extra\s*High|Max)\)\s*$/i);
  if (!m) {
    m = s.match(/\s+(Extra\s*High|XHigh|Minimal|Medium|High|Low|Max)\s*$/i);
  }
  if (!m) return null;
  const raw = m[1].toLowerCase().replace(/\s+/g, '');
  if (raw === 'minimal') return 'minimal';
  if (raw === 'low') return 'low';
  if (raw === 'medium') return 'medium';
  if (raw === 'high') return 'high';
  if (raw === 'xhigh' || raw === 'extrahigh') return 'xhigh';
  if (raw === 'max') return 'max';
  return null;
}

function matchModelFamily(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  if (s.includes('4-neon') || s.includes('4 neon') || s.includes('neon')) return 'gemini-4-neon';
  if (s.includes('4-hydrogen') || s.includes('4 hydrogen') || s.includes('hydrogen') || /\bm669\b/.test(s)) {
    return 'gemini-4-hydrogen';
  }
  if (s.includes('4-carbon') || s.includes('4 carbon') || s.includes('carbon') || /\bm667\b|\bm670\b|m667|m670/.test(s)) {
    return 'gemini-4-carbon';
  }
  if (s.includes('4-argon') || s.includes('4 argon') || s.includes('argon') || /\bm668\b|\bm681\b|m668|m681/.test(s)) {
    return 'gemini-4-argon';
  }
  if (s.includes('3.8-flash') || s.includes('3.8 flash') || s.includes('flash-n')) return 'gemini-3.8-flash';
  if (s.includes('3.5-flash-lite') || s.includes('3.5 flash-lite') || s.includes('flash-lite')) return 'gemini-3.5-flash-lite';
  if (s.includes('3.1-pro') || s.includes('3.1 pro')) return 'gemini-3.1-pro-preview';
  if (s.includes('2.5-pro') || s.includes('2.5 pro')) return 'gemini-2.5-pro';
  if (/(?:opus[-_ ]5[._-]5|5[._-]5[-_ ]opus|claude-opus-5-5)/.test(s)) return 'claude-opus-5-5';
  if (/(?:sonnet[-_ ]5[._-]5|5[._-]5[-_ ]sonnet|claude-sonnet-5-5)/.test(s)) return 'claude-sonnet-5-5';
  return null;
}

/**
 * Resolve model identity, display name, and pricing key from a string or metadata object.
 */
function resolveModelIdentity(input) {
  if (!input) {
    return {
      modelKey: 'unknown',
      displayName: 'Unknown',
      effort: null,
      displayNameWithEffort: 'Unknown',
      rawName: '',
      pricingKey: null,
      isPriced: false
    };
  }
  if (typeof input === 'object' && input.modelKey && 'isPriced' in input && 'pricingKey' in input) {
    if ('displayNameWithEffort' in input) return input;
    const effort = extractEffortSuffix(input.rawName);
    return {
      ...input,
      effort,
      displayNameWithEffort: effort ? `${input.displayName} (${effort})` : input.displayName
    };
  }

  let candidates = [];
  let rawName = '';
  if (typeof input === 'string') {
    rawName = input.trim();
    candidates = [rawName];
  } else if (typeof input === 'object') {
    const cm = input.chatModel || input;
    const enumFallback = Number.isFinite(Number(cm.modelNum)) ? MODEL_ENUM_FALLBACK[Number(cm.modelNum)] : '';
    candidates = [
      cm.modelDisplayName,
      cm.label,
      cm.modelEnum,
      cm.responseModel,
      typeof cm.model === 'string' ? cm.model : '',
      cm.modelOrAlias?.model,
      cm.modelId,
      enumFallback
    ]
      .filter((v) => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());
    rawName = candidates[0] || '';
  }

  let effort = null;
  for (const c of candidates) {
    effort = extractEffortSuffix(c);
    if (effort) break;
  }

  let matchedKey = null;
  for (const c of candidates) {
    matchedKey = matchModelFamily(c);
    if (matchedKey) break;
  }

  if (!matchedKey && dynamicPricing.size > 0) {
    for (const c of candidates) {
      const cleaned = stripEffortSuffix(c);
      const variants = [cleaned];
      const orchMatch = cleaned.match(/^orchestrator\s*(?:\(([^)]+)\)|(.+))$/i);
      if (orchMatch) variants.push((orchMatch[1] || orchMatch[2] || '').trim());
      for (const v of variants) {
        const dotSlug = v.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
        const dashSlug = dotSlug.replace(/\./g, '-');
        if (dotSlug && dynamicPricing.has(dotSlug)) {
          matchedKey = dotSlug;
          break;
        }
        if (dashSlug && dynamicPricing.has(dashSlug)) {
          matchedKey = dashSlug;
          break;
        }
      }
      if (matchedKey) break;
    }
  }

  if (matchedKey) {
    const pricingKey = hasPricingKey(matchedKey) ? matchedKey : null;
    const displayName =
      dynamicDisplayNames.get(matchedKey) ||
      FAMILY_DISPLAY_NAMES[matchedKey] ||
      stripEffortSuffix(rawName) ||
      matchedKey;
    return {
      modelKey: matchedKey,
      displayName,
      effort,
      displayNameWithEffort: effort ? `${displayName} (${effort})` : displayName,
      rawName,
      pricingKey,
      isPriced: pricingKey !== null
    };
  }

  const cleaned = stripEffortSuffix(rawName);
  const fallbackKey = (cleaned || rawName || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
  const displayName = cleaned || rawName || 'Unknown';

  return {
    modelKey: fallbackKey,
    displayName,
    effort,
    displayNameWithEffort: effort ? `${displayName} (${effort})` : displayName,
    rawName,
    pricingKey: null,
    isPriced: false
  };
}

function getPriceRule(pricingKey, { dateKey = null, promptTokens = 0 } = {}) {
  if (!hasPricingKey(pricingKey)) return null;
  const rules = dynamicPricing.get(pricingKey) || PRICING_TABLE[pricingKey];
  const prompt = Math.max(0, Number(promptTokens) || 0);

  let dateFiltered = rules;
  if (dateKey && /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey))) {
    const d = String(dateKey);
    const matching = rules.filter((r) => {
      if (r.effectiveFrom && d < r.effectiveFrom) return false;
      if (r.effectiveTo && d > r.effectiveTo) return false;
      return true;
    });
    if (matching.length > 0) dateFiltered = matching;
  }

  const promptMatched = dateFiltered.find((r) => {
    if (r.minPromptTokens !== undefined && prompt < r.minPromptTokens) return false;
    if (r.maxPromptTokens !== undefined && prompt > r.maxPromptTokens) return false;
    return true;
  });

  return promptMatched || dateFiltered[dateFiltered.length - 1] || null;
}

function calculateCallCost(usage, modelInput, { dateKey = null } = {}) {
  const model = resolveModelIdentity(modelInput);
  if (!model.isPriced) {
    return {
      priced: false,
      costUsd: null,
      pricingKey: null,
      modelKey: model.modelKey,
      displayName: model.displayName,
      label: 'Unpriced'
    };
  }

  const inputTokens = Math.max(0, Number(usage?.inputTokens ?? usage?.input_tokens) || 0);
  const cacheReadTokens = Math.max(0, Number(usage?.cacheReadTokens ?? usage?.cache_read_tokens) || 0);
  const outputTokens = Math.max(0, Number(usage?.outputTokens ?? usage?.output_tokens) || 0);
  const promptTokens = inputTokens + cacheReadTokens;

  const rule = getPriceRule(model.pricingKey, { dateKey, promptTokens });
  if (!rule) {
    return {
      priced: false,
      costUsd: null,
      pricingKey: null,
      modelKey: model.modelKey,
      displayName: model.displayName,
      label: 'Unpriced'
    };
  }

  const costUsd =
    (inputTokens * rule.inputPerMillion +
      cacheReadTokens * rule.cacheReadPerMillion +
      outputTokens * rule.outputPerMillion) /
    1e6;

  return {
    priced: true,
    costUsd,
    pricingKey: model.pricingKey,
    modelKey: model.modelKey,
    displayName: model.displayName,
    rule
  };
}

/**
 * Price an entire session using its single primary model (first valid call).
 * Mid-session model switches do not create blended pricing.
 */
function calculateSessionCost(calls, primaryModelInput) {
  const model = resolveModelIdentity(primaryModelInput);
  if (!model.isPriced) {
    return {
      priced: false,
      costUsd: null,
      pricingKey: null,
      modelKey: model.modelKey,
      displayName: model.displayName,
      label: 'Unpriced'
    };
  }

  let totalCostUsd = 0;
  for (const call of calls || []) {
    const res = calculateCallCost(call, model, { dateKey: call?.dateKey || null });
    if (res.priced && res.costUsd !== null) {
      totalCostUsd += res.costUsd;
    }
  }

  return {
    priced: true,
    costUsd: totalCostUsd,
    pricingKey: model.pricingKey,
    modelKey: model.modelKey,
    displayName: model.displayName
  };
}

module.exports = {
  PRICING_TABLE,
  MODEL_ENUM_FALLBACK,
  validatePricingRules,
  setDynamicPricing,
  clearDynamicPricing,
  getEffectivePricingTable,
  extractEffortSuffix,
  resolveModelIdentity,
  getPriceRule,
  calculateCallCost,
  calculateSessionCost
};

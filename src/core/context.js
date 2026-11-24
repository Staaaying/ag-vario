'use strict';

const CONTEXT_CATEGORIES = [
  { key: 'system_prompt', label: 'System Prompt' },
  { key: 'skills_rules', label: 'Skills & Rules' },
  { key: 'mcp_tools', label: 'MCP Tools' },
  { key: 'builtin_tools', label: 'Built-in Tools' },
  { key: 'messages_outputs', label: 'Messages & Outputs' }
];

function toNonNegInt(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Fast CJK-aware token heuristic (~0.25 tok/ASCII char, ~0.65 tok/CJK char).
 */
function estimateTextTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 0x7f) asciiCount++;
    else nonAsciiCount++;
  }
  return Math.round(asciiCount * 0.25 + nonAsciiCount * 0.65);
}

/**
 * Compute context waterline percentage and 3-color warning level:
 * green (<50%), orange (50%-79%), red (>=80%), or unknown when limit missing.
 */
function computeContextWaterline(usedTokens, contextLimit) {
  const used = toNonNegInt(usedTokens);
  const limitNum = Number(contextLimit);
  if (!Number.isFinite(limitNum) || limitNum <= 0) {
    return {
      usedTokens: used,
      contextLimit: null,
      ratio: null,
      percent: null,
      level: 'unknown'
    };
  }
  const ratio = used / limitNum;
  const percent = Math.round(ratio * 100);
  const level = percent < 50 ? 'green' : percent < 80 ? 'orange' : 'red';
  return {
    usedTokens: used,
    contextLimit: limitNum,
    ratio,
    percent,
    level
  };
}

/**
 * Classify PromptSection into system_prompt, skills_rules, or mcp_tools.
 * Handles numeric and protojson string enums, plus title fallback for legacy rows
 * that tag `skills` / `user_rules` as SYSTEM_PROMPT (1).
 */
function classifyPromptSection(section) {
  if (!section || typeof section !== 'object') return 'system_prompt';
  const rawType = section.tokenType ?? section.token_type ?? 0;
  const typeStr = typeof rawType === 'string' ? rawType.trim().toUpperCase() : '';
  const typeNum = typeof rawType === 'number' ? rawType : ( /^\d+$/.test(typeStr) ? Number(typeStr) : 0 );

  if (typeNum === 4 || typeStr === 'TOKEN_TYPE_MCP_TOOLS') return 'mcp_tools';
  if (typeNum === 3 || typeNum === 5 || typeStr === 'TOKEN_TYPE_RULES' || typeStr === 'TOKEN_TYPE_SKILLS') {
    return 'skills_rules';
  }
  if (typeNum === 6 || typeNum === 9 || typeStr === 'TOKEN_TYPE_SUBAGENTS' || typeStr === 'TOKEN_TYPE_PLUGINS') {
    return 'system_prompt';
  }

  const title = String(section.title || '').trim().toLowerCase();
  if (title === 'skills' || title === 'user_rules') return 'skills_rules';
  return 'system_prompt';
}

function allocateProportional(rawValues, targetTotal) {
  const totalRaw = rawValues.reduce((sum, v) => sum + v, 0);
  if (targetTotal <= 0 || totalRaw <= 0) return rawValues.map(() => 0);

  const exacts = rawValues.map((v) => (v / totalRaw) * targetTotal);
  const floors = exacts.map((v) => Math.floor(v));
  let remainder = targetTotal - floors.reduce((sum, v) => sum + v, 0);

  if (remainder > 0) {
    const order = exacts
      .map((v, idx) => ({ idx, frac: v - floors[idx] }))
      .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
    for (let i = 0; i < remainder; i++) {
      floors[order[i % order.length].idx]++;
    }
  }
  return floors;
}

/**
 * Compute estimated 5-category context breakdown aligned to exact prompt tokens.
 * Accepts either SQLite-decoded ChatModelMetadata or RPC JSON ChatModelMetadata.
 */
function computeContextBreakdown(chatModel, { contextLimit = null } = {}) {
  const cm = chatModel && typeof chatModel === 'object' ? chatModel : {};
  const usage = cm.usage && typeof cm.usage === 'object' ? cm.usage : {};
  const inputTokens = toNonNegInt(usage.inputTokens ?? usage.input_tokens);
  const cacheReadTokens = toNonNegInt(usage.cacheReadTokens ?? usage.cache_read_tokens);
  const exactPromptTokens = inputTokens + cacheReadTokens;
  const rawLimit =
    contextLimit ??
    cm.maxContextTokens ??
    cm.chatStartMetadata?.contextWindowMetadata?.maxContextTokens ??
    cm.chat_start_metadata?.context_window_metadata?.max_context_tokens ??
    null;
  const inferredLimit = Number.isFinite(Number(rawLimit)) && Number(rawLimit) > 0 ? Number(rawLimit) : null;
  const waterline = computeContextWaterline(exactPromptTokens, inferredLimit);

  const rawByKey = {
    system_prompt: 0,
    skills_rules: 0,
    mcp_tools: 0,
    builtin_tools: 0,
    messages_outputs: 0
  };

  const sections = cm.promptSections || cm.prompt_sections || [];
  for (const sec of sections) {
    const cat = classifyPromptSection(sec);
    const text = `${sec?.title || ''}\n${sec?.content || ''}`;
    rawByKey[cat] += estimateTextTokens(text);
  }

  const tools = cm.tools || [];
  for (const tool of tools) {
    const serverName = String(tool?.serverName ?? tool?.server_name ?? '').trim();
    const schema = tool?.jsonSchemaString ?? tool?.json_schema_string ?? '';
    const text = `${tool?.name || ''}\n${tool?.description || ''}\n${schema}`;
    if (serverName) rawByKey.mcp_tools += estimateTextTokens(text);
    else rawByKey.builtin_tools += estimateTextTokens(text);
  }

  const messages = cm.messagePrompts || cm.message_prompts || [];
  for (const msg of messages) {
    const numTokens = toNonNegInt(msg?.numTokens ?? msg?.num_tokens);
    if (numTokens > 0) {
      rawByKey.messages_outputs += numTokens;
    } else {
      const promptText = msg?.prompt ?? msg?.content ?? '';
      rawByKey.messages_outputs += estimateTextTokens(promptText);
    }
  }

  const rawList = CONTEXT_CATEGORIES.map((c) => rawByKey[c.key]);
  const rawSum = rawList.reduce((sum, v) => sum + v, 0);

  if (exactPromptTokens > 0 && rawSum === 0) {
    return {
      isEstimated: true,
      breakdownAvailable: false,
      exactPromptTokens,
      waterline,
      categories: CONTEXT_CATEGORIES.map((c) => ({
        key: c.key,
        label: c.label,
        tokens: null,
        rawTokens: 0,
        ratio: null,
        percent: null
      }))
    };
  }

  const scaledList = exactPromptTokens === 0
    ? CONTEXT_CATEGORIES.map(() => 0)
    : allocateProportional(rawList, exactPromptTokens);

  const categories = CONTEXT_CATEGORIES.map((c, idx) => {
    const tokens = scaledList[idx];
    const ratio = exactPromptTokens > 0 ? tokens / exactPromptTokens : 0;
    return {
      key: c.key,
      label: c.label,
      tokens,
      rawTokens: rawList[idx],
      ratio,
      percent: exactPromptTokens > 0 ? Math.round(ratio * 1000) / 10 : 0
    };
  });

  return {
    isEstimated: true,
    breakdownAvailable: true,
    exactPromptTokens,
    waterline,
    categories
  };
}

module.exports = {
  CONTEXT_CATEGORIES,
  estimateTextTokens,
  computeContextWaterline,
  classifyPromptSection,
  computeContextBreakdown
};

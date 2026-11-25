'use strict';

const { resolveModelIdentity, calculateCallCost } = require('./pricing');
const { normalizeCall, isValidCall, pickFirstValidModel, toLocalDateKey } = require('./session');

function parseLocalDateKey(dateKey) {
  const m = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

function addDays(dateKey, deltaDays) {
  const dt = parseLocalDateKey(dateKey);
  if (!dt) return null;
  dt.setDate(dt.getDate() + deltaDays);
  return toLocalDateKey(dt.getTime());
}

function buildDateRange(period, nowMs, earliestDateKey = null) {
  const todayKey = toLocalDateKey(nowMs);
  const p = String(period || '7D').toUpperCase();
  let startKey = todayKey;

  if (p === '7D') {
    startKey = addDays(todayKey, -6);
  } else if (p === '30D') {
    startKey = addDays(todayKey, -29);
  } else if (p === 'ALL') {
    startKey = earliestDateKey && earliestDateKey <= todayKey ? earliestDateKey : todayKey;
  } else {
    startKey = addDays(todayKey, -6);
  }

  const days = [];
  let cursor = startKey;
  let guard = 0;
  while (cursor && cursor <= todayKey && guard < 3660) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
    guard++;
  }
  return { todayKey, startKey, endKey: todayKey, days };
}

function createEmptyDay(dateKey) {
  return {
    dateKey,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    hasUnpriced: false,
    unpricedTokens: 0,
    modelTimeMs: 0,
    activeRootIds: new Set(),
    sessionCount: 0,
    level: 0
  };
}

function computeUsageReport(sessions = [], { period = '7D', nowMs = Date.now(), selectedDateKey = null } = {}) {
  const normalizedSessions = [];
  const sessionById = new Map();
  let earliestDateKey = null;

  for (const sess of sessions || []) {
    if (!sess || typeof sess !== 'object') continue;
    const rawCalls = Array.isArray(sess.calls) ? sess.calls : [];
    const calls = rawCalls.map(normalizeCall).filter(isValidCall);
    const fallbackKey = sess.lastModifiedMs ? toLocalDateKey(sess.lastModifiedMs) : null;

    const enrichedCalls = calls.map((c) => {
      const dateKey = c.dateKey || fallbackKey;
      if (dateKey && (!earliestDateKey || dateKey < earliestDateKey)) {
        earliestDateKey = dateKey;
      }
      return { ...c, dateKey };
    });

    const primaryModel = sess.primaryModel?.modelKey
      ? sess.primaryModel
      : pickFirstValidModel(rawCalls);

    const normalizedEntry = {
      conversationId: sess.conversationId || '',
      rootConversationId: sess.rootConversationId || sess.conversationId || '',
      isChild: Boolean(sess.isChild),
      title: sess.title || sess.conversationId?.slice(0, 8) || 'Untitled',
      lastModifiedMs: Number(sess.lastModifiedMs) || 0,
      primaryModel,
      calls: enrichedCalls
    };
    normalizedSessions.push(normalizedEntry);
    if (normalizedEntry.conversationId && !sessionById.has(normalizedEntry.conversationId)) {
      sessionById.set(normalizedEntry.conversationId, normalizedEntry);
    }
  }

  const range = buildDateRange(period, nowMs, earliestDateKey);
  const heatmapRange = buildDateRange('30D', nowMs);
  const trailing7Start = addDays(range.endKey, -6);

  const dayMap = new Map(heatmapRange.days.map((k) => [k, createEmptyDay(k)]));
  const todayStats = { dateKey: range.todayKey, totalTokens: 0, costUsd: 0, hasUnpriced: false, modelTimeMs: 0 };
  let trailing7Tokens = 0;

  let periodTokens = 0;
  let periodPricedUsd = 0;
  let periodAnyPriced = false;
  let periodUnpricedTokens = 0;
  let periodModelTimeMs = 0;
  let selectedModelTokens = 0;
  const activeRootInPeriod = new Set();
  const periodActiveDays = new Set();

  const modelMap = new Map();
  const rootMap = new Map();

  for (const sess of normalizedSessions) {
    const model = resolveModelIdentity(sess.primaryModel);
    let sessInSelection = false;

    for (const call of sess.calls) {
      const dk = call.dateKey;
      if (!dk) continue;

      const callCost = calculateCallCost(call, model, { dateKey: dk });
      const callTimeMs = (call.ttftMs || 0) + (call.streamingMs || 0);

      if (dk === range.todayKey) {
        todayStats.totalTokens += call.totalTokens;
        todayStats.modelTimeMs += callTimeMs;
        if (callCost.priced && callCost.costUsd !== null) todayStats.costUsd += callCost.costUsd;
        else todayStats.hasUnpriced = true;
      }

      if (dk >= trailing7Start && dk <= range.endKey) {
        trailing7Tokens += call.totalTokens;
      }

      // Fixed trailing 30-day heatmap (invariant across 7D / 30D / ALL)
      const dayEntry = dayMap.get(dk);
      if (dayEntry) {
        dayEntry.totalTokens += call.totalTokens;
        dayEntry.inputTokens += call.inputTokens;
        dayEntry.outputTokens += call.outputTokens;
        dayEntry.cacheReadTokens += call.cacheReadTokens;
        dayEntry.modelTimeMs += callTimeMs;
        dayEntry.activeRootIds.add(sess.rootConversationId);
        if (callCost.priced && callCost.costUsd !== null) {
          dayEntry.costUsd += callCost.costUsd;
        } else {
          dayEntry.hasUnpriced = true;
          dayEntry.unpricedTokens += call.totalTokens;
        }
      }

      const inPeriod = dk >= range.startKey && dk <= range.endKey;
      if (inPeriod) {
        periodTokens += call.totalTokens;
        periodModelTimeMs += callTimeMs;
        activeRootInPeriod.add(sess.rootConversationId);
        if (call.totalTokens > 0) periodActiveDays.add(dk);

        if (callCost.priced && callCost.costUsd !== null) {
          periodPricedUsd += callCost.costUsd;
          periodAnyPriced = true;
        } else {
          periodUnpricedTokens += call.totalTokens;
        }
      }

      const inModelAndTopScope = selectedDateKey ? dk === selectedDateKey : inPeriod;
      if (!inModelAndTopScope) continue;
      sessInSelection = true;

      selectedModelTokens += call.totalTokens;
      let mEntry = modelMap.get(model.modelKey);
      if (!mEntry) {
        mEntry = {
          modelKey: model.modelKey,
          displayName: model.displayName,
          isPriced: model.isPriced,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0,
          callCount: 0,
          sessionIds: new Set()
        };
        modelMap.set(model.modelKey, mEntry);
      }
      mEntry.totalTokens += call.totalTokens;
      mEntry.inputTokens += call.inputTokens;
      mEntry.outputTokens += call.outputTokens;
      mEntry.cacheReadTokens += call.cacheReadTokens;
      mEntry.callCount += 1;
      mEntry.sessionIds.add(sess.conversationId);
      if (callCost.priced && callCost.costUsd !== null) {
        mEntry.costUsd += callCost.costUsd;
      }

      // Accumulate root-session rollups for Top 3 (period or selectedDateKey)
      let rootEntry = rootMap.get(sess.rootConversationId);
      if (!rootEntry) {
        rootEntry = {
          conversationId: sess.rootConversationId,
          title: '',
          primaryModel: null,
          totalTokens: 0,
          mainTokens: 0,
          subagentTokens: 0,
          childIds: new Set(),
          costUsd: 0,
          anyPriced: false,
          hasUnpriced: false,
          modelTimeMs: 0,
          lastActiveMs: 0
        };
        rootMap.set(sess.rootConversationId, rootEntry);
      }
      if (!sess.isChild) {
        rootEntry.title = sess.title;
        rootEntry.primaryModel = model;
        rootEntry.mainTokens += call.totalTokens;
      } else {
        rootEntry.subagentTokens += call.totalTokens;
        rootEntry.childIds.add(sess.conversationId);
        if (!rootEntry.primaryModel) rootEntry.primaryModel = model;
      }
      rootEntry.totalTokens += call.totalTokens;
      rootEntry.modelTimeMs += callTimeMs;
      rootEntry.lastActiveMs = Math.max(rootEntry.lastActiveMs, call.timestampMs || sess.lastModifiedMs || 0);
      if (callCost.priced && callCost.costUsd !== null) {
        rootEntry.costUsd += callCost.costUsd;
        rootEntry.anyPriced = true;
      } else {
        rootEntry.hasUnpriced = true;
      }
    }

    // Ensure root title is filled from main session metadata even if only child had calls on selectedDateKey
    if (!sess.isChild && rootMap.has(sess.rootConversationId)) {
      const r = rootMap.get(sess.rootConversationId);
      if (!r.title || r.title === r.conversationId.slice(0, 8)) r.title = sess.title;
      r.primaryModel = model;
    } else if (sessInSelection && rootMap.has(sess.rootConversationId) && !rootMap.get(sess.rootConversationId).title) {
      const mainMeta = sessionById.get(sess.rootConversationId);
      if (mainMeta) {
        rootMap.get(sess.rootConversationId).title = mainMeta.title;
        rootMap.get(sess.rootConversationId).primaryModel = mainMeta.primaryModel;
      }
    }
  }

  const heatmapRaw = Array.from(dayMap.values());
  const maxDayTokens = heatmapRaw.reduce((m, d) => Math.max(m, d.totalTokens), 0);
  const heatmap = heatmapRaw.map((d) => {
    let level = 0;
    if (d.totalTokens > 0 && maxDayTokens > 0) {
      const ratio = d.totalTokens / maxDayTokens;
      level = ratio <= 0.25 ? 1 : ratio <= 0.5 ? 2 : ratio <= 0.75 ? 3 : 4;
    }
    return {
      dateKey: d.dateKey,
      totalTokens: d.totalTokens,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheReadTokens: d.cacheReadTokens,
      costUsd: d.hasUnpriced && d.costUsd === 0 ? null : d.costUsd,
      hasUnpriced: d.hasUnpriced,
      modelTimeMs: d.modelTimeMs,
      sessionCount: d.activeRootIds.size,
      level
    };
  });

  const activeDays = periodActiveDays.size;

  const modelShareDenom = selectedDateKey ? selectedModelTokens : periodTokens;
  const byModel = Array.from(modelMap.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((m) => ({
      modelKey: m.modelKey,
      displayName: m.displayName,
      totalTokens: m.totalTokens,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheReadTokens: m.cacheReadTokens,
      shareRatio: modelShareDenom > 0 ? m.totalTokens / modelShareDenom : 0,
      costUsd: m.isPriced ? m.costUsd : null,
      isPriced: m.isPriced,
      callCount: m.callCount,
      sessionCount: m.sessionIds.size
    }));

  const topSessions = Array.from(rootMap.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 3)
    .map((r) => ({
      conversationId: r.conversationId,
      title: r.title || r.conversationId.slice(0, 8),
      primaryModel: r.primaryModel,
      totalTokens: r.totalTokens,
      mainTokens: r.mainTokens,
      subagentTokens: r.subagentTokens,
      subagentCount: r.childIds.size,
      costUsd: r.anyPriced ? r.costUsd : null,
      isPriced: r.anyPriced,
      hasUnpriced: r.hasUnpriced,
      modelTimeMs: r.modelTimeMs,
      lastActiveMs: r.lastActiveMs
    }));

  const calendarDays = Math.max(1, range.days.length);
  const activeRootCount = activeRootInPeriod.size;

  return {
    period: String(period || '7D').toUpperCase(),
    selectedDateKey: selectedDateKey || null,
    range: { startKey: range.startKey, endKey: range.endKey, days: range.days.length },
    today: todayStats,
    summary: {
      tokens: periodTokens,
      estUsd: periodTokens === 0 ? 0 : (periodAnyPriced ? periodPricedUsd : null),
      hasUnpriced: periodUnpricedTokens > 0,
      unpricedTokens: periodUnpricedTokens,
      avg7dTokens: trailing7Tokens / 7,
      dailyAvgTokens: activeDays > 0 ? periodTokens / activeDays : 0,
      avgPerChatTokens: activeRootCount > 0 ? periodTokens / activeRootCount : 0,
      dailyTimeMs: periodModelTimeMs / calendarDays,
      activeDays,
      activeDailyTimeMs: activeDays > 0 ? periodModelTimeMs / activeDays : 0,
      activeChats: activeRootCount
    },
    heatmap,
    byModel,
    topSessions
  };
}

module.exports = {
  buildDateRange,
  computeUsageReport
};

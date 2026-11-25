'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { parseRawSummary, parseStepMetadata, parseGenMetadata } = require('../core/pb');
const { resolveModelIdentity } = require('../core/pricing');
const { computeContextBreakdown } = require('../core/context');
const {
  toLocalDateKey,
  pickFirstValidModel,
  normalizeSubagentStatus
} = require('../core/session');

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity');
const CACHE_VERSION = 1;

function toSqliteFileUri(dbPath, immutable) {
  const abs = path.resolve(dbPath);
  const encodedPath = abs
    .split('/')
    .map((seg, idx) => (idx === 0 && seg === '' ? '' : encodeURIComponent(seg)))
    .join('/');
  return immutable
    ? `file:${encodedPath}?mode=ro&immutable=1`
    : `file:${encodedPath}?mode=ro`;
}

function hasActiveWal(dbPath) {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  try {
    if (!fs.existsSync(shmPath) || !fs.existsSync(walPath)) return false;
    return fs.statSync(walPath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Open a SQLite database strictly read-only in a WAL-safe manner.
 */
function openReadOnlyDb(dbPath) {
  const immutable = !hasActiveWal(dbPath);
  const uri = toSqliteFileUri(dbPath, immutable);
  return new DatabaseSync(uri, { open: true, readOnly: true });
}

function parseSqlTimestampMs(value) {
  if (!value || typeof value !== 'string') return null;
  const isoLike = value.trim().replace(' ', 'T');
  const ms = Date.parse(isoLike);
  return Number.isFinite(ms) ? ms : null;
}

function firstLine(text, maxLen = 80) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean) || '';
  return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

/**
 * Read conversation_summaries.db and classify main, regular subagent, and workflow child sessions.
 */
function readConversationSummaries(dataDir = DEFAULT_DATA_DIR) {
  const dbPath = path.join(dataDir, 'conversation_summaries.db');
  const byId = new Map();
  const list = [];
  const childrenByRoot = new Map();

  if (!fs.existsSync(dbPath)) {
    return { byId, list, childrenByRoot };
  }

  const db = openReadOnlyDb(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT conversation_id, title, preview, step_count, last_modified_time,
                status, project_id, agent_name, parent_conversation_id,
                nesting_depth, killed, last_user_input_time, raw_summary
         FROM conversation_summaries`
      )
      .all();

    for (const r of rows) {
      const id = r.conversation_id;
      const pbInfo = r.raw_summary ? parseRawSummary(r.raw_summary) : {};
      const parentId = r.parent_conversation_id || pbInfo.parentConversationId || '';
      const rootFromPb = pbInfo.rootConversationId || '';
      const agentName = r.agent_name || pbInfo.subagentSpec?.typeName || '';
      const nestingDepth = Number(r.nesting_depth) || 0;

      let kind = 'main';
      if (nestingDepth > 0 || parentId) {
        kind = 'subagent';
      } else if (agentName) {
        kind = 'workflow';
      }

      let rootConversationId = id;
      if (kind !== 'main') {
        rootConversationId = rootFromPb || parentId || id;
      }

      const role = pbInfo.subagentSpec?.role || '';
      const displayTitle =
        r.title ||
        role ||
        pbInfo.rawTitle ||
        firstLine(r.preview) ||
        agentName ||
        id.slice(0, 8);

      const lastModifiedMs = parseSqlTimestampMs(r.last_modified_time) || 0;
      const item = {
        conversationId: id,
        kind,
        isChild: kind !== 'main',
        title: displayTitle,
        role,
        agentName,
        parentConversationId: parentId || (kind === 'workflow' && rootConversationId !== id ? rootConversationId : ''),
        rootConversationId,
        status: r.status || '',
        killed: Boolean(r.killed),
        normalizedStatus: normalizeSubagentStatus({ status: r.status, killed: Boolean(r.killed) }),
        stepCount: Number(r.step_count) || 0,
        lastModifiedMs,
        subagentModelNum: pbInfo.subagentSpec?.modelEnum || null
      };

      byId.set(id, item);
      list.push(item);

      if (item.isChild && item.rootConversationId) {
        const kids = childrenByRoot.get(item.rootConversationId) || [];
        kids.push(item);
        childrenByRoot.set(item.rootConversationId, kids);
      }
    }
  } finally {
    db.close();
  }

  return { byId, list, childrenByRoot };
}

/**
 * Read a single conversations/<id>.db file read-only.
 */
function readConversationDb(dbPath, { includeContext = false, fallbackTimestampMs = null } = {}) {
  const db = openReadOnlyDb(dbPath);
  try {
    const stepRows = db
      .prepare('SELECT idx, step_type, status, metadata, error_details FROM steps ORDER BY idx ASC')
      .all();

    let turns = 0;
    let checkpointCount = 0;
    let errorStepCount = 0;
    let lastStepHasError = false;
    const stepTimeByIdx = new Map();

    for (let i = 0; i < stepRows.length; i++) {
      const s = stepRows[i];
      const stepType = Number(s.step_type);
      if (stepType === 14) turns++;
      if (stepType === 23) checkpointCount++;
      const hasErr = Boolean(s.error_details && s.error_details.length > 0);
      if (hasErr) errorStepCount++;
      if (i === stepRows.length - 1) lastStepHasError = hasErr;
      if (s.metadata) {
        const meta = parseStepMetadata(s.metadata);
        if (meta.createdAtMs !== null) stepTimeByIdx.set(s.idx, meta.createdAtMs);
      }
    }

    const gmRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    const calls = [];
    let lastContextGmIdx = null;
    let lastKnownTs = fallbackTimestampMs;

    for (const gm of gmRows) {
      if (!gm.data) continue;
      const parsed = parseGenMetadata(gm.data, { includeContext: false });
      const cm = parsed.chatModel;
      if (!cm) continue;

      if (cm.hasContextPayload) lastContextGmIdx = gm.idx;

      let timestampMs = null;
      for (const si of parsed.stepIndices) {
        if (stepTimeByIdx.has(si)) {
          timestampMs = stepTimeByIdx.get(si);
          break;
        }
      }
      if (timestampMs === null) timestampMs = lastKnownTs;
      else lastKnownTs = timestampMs;

      calls.push({
        idx: gm.idx,
        timestampMs,
        dateKey: timestampMs !== null ? toLocalDateKey(timestampMs) : null,
        modelNum: cm.modelNum,
        modelEnum: cm.modelEnum,
        responseModel: cm.responseModel,
        modelDisplayName: cm.modelDisplayName,
        inputTokens: cm.usage.inputTokens,
        outputTokens: cm.usage.outputTokens,
        cacheReadTokens: cm.usage.cacheReadTokens,
        cacheWriteTokens: cm.usage.cacheWriteTokens,
        thinkingOutputTokens: cm.usage.thinkingOutputTokens,
        responseOutputTokens: cm.usage.responseOutputTokens,
        ttftMs: cm.ttftMs,
        streamingMs: cm.streamingMs,
        maxContextTokens: cm.maxContextTokens ?? null,
        startStepIndex: cm.startStepIndex ?? null,
        checkpointIndex: cm.checkpointIndex ?? null,
        truncationReason: cm.truncationReason ?? null
      });
    }

    let contextChatModel = null;
    if (includeContext && lastContextGmIdx !== null) {
      const ctxRow = db.prepare('SELECT data FROM gen_metadata WHERE idx = ?').get(lastContextGmIdx);
      if (ctxRow && ctxRow.data) {
        contextChatModel = parseGenMetadata(ctxRow.data, { includeContext: true }).chatModel;
      }
    }

    return {
      turns,
      checkpointCount,
      errorStepCount,
      lastStepHasError,
      calls,
      contextChatModel
    };
  } finally {
    db.close();
  }
}

function getDbFingerprint(dbPath) {
  const st = fs.statSync(dbPath);
  let walMtime = 0;
  let walSize = 0;
  const walPath = `${dbPath}-wal`;
  try {
    if (fs.existsSync(walPath)) {
      const wst = fs.statSync(walPath);
      walMtime = wst.mtimeMs;
      walSize = wst.size;
    }
  } catch {}
  return `${st.mtimeMs}:${st.size}:${walMtime}:${walSize}`;
}

function loadCache(cachePath) {
  if (!cachePath) return { version: CACHE_VERSION, entries: {} };
  try {
    if (!fs.existsSync(cachePath)) return { version: CACHE_VERSION, entries: {} };
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed && parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
      return parsed;
    }
  } catch {}
  return { version: CACHE_VERSION, entries: {} };
}

function saveCacheAtomic(cachePath, cacheObj) {
  if (!cachePath) return;
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(cacheObj), 'utf8');
  fs.renameSync(tmpPath, cachePath);
}

/**
 * Incrementally scan conversations/*.db using mtime+size+wal fingerprints.
 * Pass cachePath = null for 100% disk-write-free dry-runs.
 */
function scanConversationsIncremental({ dataDir = DEFAULT_DATA_DIR, cachePath = null } = {}) {
  const startMs = Date.now();
  const summaries = readConversationSummaries(dataDir);
  const convDir = path.join(dataDir, 'conversations');

  const cache = loadCache(cachePath);
  let cacheDirty = false;
  let cacheHits = 0;
  let scanned = 0;
  const errors = [];

  const files = fs.existsSync(convDir)
    ? fs.readdirSync(convDir).filter((f) => f.endsWith('.db')).sort()
    : [];

  const sessions = [];

  for (const file of files) {
    const id = file.slice(0, -3);
    const dbPath = path.join(convDir, file);
    const sum = summaries.byId.get(id);

    let fp = null;
    try {
      fp = getDbFingerprint(dbPath);
    } catch (err) {
      errors.push({ conversationId: id, error: err.message });
      continue;
    }

    let dbData = null;
    const cached = cache.entries[id];
    if (cached && cached.fingerprint === fp) {
      dbData = cached.data;
      cacheHits++;
    } else {
      try {
        const fallbackTs = sum?.lastModifiedMs || fs.statSync(dbPath).mtimeMs;
        dbData = readConversationDb(dbPath, { includeContext: false, fallbackTimestampMs: fallbackTs });
        cache.entries[id] = { fingerprint: fp, data: dbData };
        cacheDirty = true;
        scanned++;
      } catch (err) {
        errors.push({ conversationId: id, error: err.message });
        continue;
      }
    }

    const calls = Array.isArray(dbData.calls) ? dbData.calls : [];
    const primaryModel = calls.length > 0
      ? pickFirstValidModel(calls)
      : resolveModelIdentity(sum?.subagentModelNum ? { modelNum: sum.subagentModelNum } : null);

    sessions.push({
      conversationId: id,
      kind: sum?.kind || 'main',
      isChild: sum ? sum.isChild : false,
      title: sum?.title || id.slice(0, 8),
      role: sum?.role || '',
      agentName: sum?.agentName || '',
      parentConversationId: sum?.parentConversationId || '',
      rootConversationId: sum?.rootConversationId || id,
      status: sum?.status || '',
      killed: sum?.killed || false,
      normalizedStatus: normalizeSubagentStatus({
        status: sum?.status,
        killed: sum?.killed,
        lastStepHasError: dbData.lastStepHasError
      }),
      lastModifiedMs: sum?.lastModifiedMs || fs.statSync(dbPath).mtimeMs,
      turns: dbData.turns || 0,
      errorStepCount: dbData.errorStepCount || 0,
      lastStepHasError: Boolean(dbData.lastStepHasError),
      primaryModel,
      calls
    });
  }

  if (cachePath && cacheDirty) {
    saveCacheAtomic(cachePath, cache);
  }

  return {
    summaries,
    sessions,
    stats: {
      totalDbs: files.length,
      cacheHits,
      scanned,
      errors,
      elapsedMs: Date.now() - startMs
    }
  };
}

function readConversationContext(dataDir = DEFAULT_DATA_DIR, conversationId, { contextLimit = null } = {}) {
  const dbPath = path.join(dataDir, 'conversations', `${conversationId}.db`);
  if (!fs.existsSync(dbPath)) return null;
  const detail = readConversationDb(dbPath, { includeContext: true });
  if (!detail.contextChatModel) return null;
  return computeContextBreakdown(detail.contextChatModel, { contextLimit });
}

module.exports = {
  DEFAULT_DATA_DIR,
  toSqliteFileUri,
  hasActiveWal,
  openReadOnlyDb,
  parseSqlTimestampMs,
  readConversationSummaries,
  readConversationDb,
  getDbFingerprint,
  scanConversationsIncremental,
  readConversationContext
};

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
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
const CONVERSATION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function resolveConversationDbPath(dataDir, conversationId) {
  if (typeof conversationId !== 'string' || !CONVERSATION_ID_RE.test(conversationId)) {
    return null;
  }
  return path.join(dataDir, 'conversations', `${conversationId}.db`);
}

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
    if (!fs.existsSync(shmPath)) return false;
    return fs.statSync(walPath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Open a SQLite database strictly read-only in a WAL-safe manner.
 * When -shm is absent, immutable=1 avoids creating a -shm file in ~/.gemini/antigravity/,
 * intentionally trading off visibility of uncheckpointed -wal frames after an abnormal host exit.
 */
function openReadOnlyDb(dbPath) {
  const immutable = !hasActiveWal(dbPath);
  const uri = toSqliteFileUri(dbPath, immutable);
  const db = new DatabaseSync(uri, { open: true, readOnly: true });
  if (!immutable) {
    try {
      db.exec('PRAGMA busy_timeout = 100');
    } catch (err) {
      db.close();
      throw err;
    }
  }
  return db;
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
function readConversationDb(dbPath, { includeCalls = true, includeContext = false, fallbackTimestampMs = null } = {}) {
  const db = openReadOnlyDb(dbPath);
  try {
    if (!includeCalls && !includeContext) {
      const agg = db
        .prepare(
          `SELECT
             SUM(CASE WHEN step_type = 14 THEN 1 ELSE 0 END) AS turns,
             SUM(CASE WHEN step_type = 23 THEN 1 ELSE 0 END) AS checkpointCount,
             SUM(CASE WHEN error_details IS NOT NULL AND length(error_details) > 0 THEN 1 ELSE 0 END) AS errorStepCount
           FROM steps`
        )
        .get();
      const lastRow = db.prepare('SELECT error_details FROM steps ORDER BY idx DESC LIMIT 1').get();
      return {
        turns: Number(agg?.turns) || 0,
        checkpointCount: Number(agg?.checkpointCount) || 0,
        errorStepCount: Number(agg?.errorStepCount) || 0,
        lastStepHasError: Boolean(lastRow?.error_details && lastRow.error_details.length > 0),
        calls: [],
        contextChatModel: null
      };
    }

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

function getDbFingerprintInfo(dbPath) {
  const st = fs.statSync(dbPath);
  let walMtime = 0;
  let walSize = 0;
  try {
    const wst = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
    if (wst) {
      walMtime = wst.mtimeMs;
      walSize = wst.size;
    }
  } catch {}
  return {
    fingerprint: `${st.mtimeMs}:${st.size}:${walMtime}:${walSize}`,
    mtimeMs: st.mtimeMs,
    size: st.size,
    walSize
  };
}

function getDbFingerprint(dbPath) {
  return getDbFingerprintInfo(dbPath).fingerprint;
}

function getSummaryDbFingerprint(dataDir = DEFAULT_DATA_DIR) {
  const dbPath = path.join(dataDir, 'conversation_summaries.db');
  try {
    return getDbFingerprintInfo(dbPath).fingerprint;
  } catch {
    return null;
  }
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
  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cacheObj), 'utf8');
    fs.renameSync(tmpPath, cachePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

async function saveCacheAtomicAsync(cachePath, cacheObj) {
  if (!cachePath) return;
  const dir = path.dirname(cachePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(cacheObj), 'utf8');
    await fs.promises.rename(tmpPath, cachePath);
  } catch (err) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {}
    throw err;
  }
}

function scanSingleConversationFile({ file, convDir, summaries, cache, errors }) {
  const id = file.slice(0, -3);
  const dbPath = path.join(convDir, file);
  const sum = summaries.byId.get(id);

  let fpInfo;
  try {
    fpInfo = getDbFingerprintInfo(dbPath);
  } catch (err) {
    errors.push({ conversationId: id, error: err.message });
    return { session: null, cacheHit: false, scanned: false, cacheDirty: false };
  }

  let dbData = null;
  let cacheHit = false;
  let scanned = false;
  let cacheDirty = false;
  const cached = cache.entries[id];
  if (cached && cached.fingerprint === fpInfo.fingerprint) {
    dbData = cached.data;
    cacheHit = true;
  } else {
    try {
      const fallbackTs = sum?.lastModifiedMs || fpInfo.mtimeMs;
      dbData = readConversationDb(dbPath, { includeContext: false, fallbackTimestampMs: fallbackTs });
      cache.entries[id] = { fingerprint: fpInfo.fingerprint, data: dbData };
      cacheDirty = true;
      scanned = true;
    } catch (err) {
      errors.push({ conversationId: id, error: err.message });
      return { session: null, cacheHit: false, scanned: false, cacheDirty: false };
    }
  }

  const calls = Array.isArray(dbData.calls) ? dbData.calls : [];
  const primaryModel = calls.length > 0
    ? pickFirstValidModel(calls)
    : resolveModelIdentity(sum?.subagentModelNum ? { modelNum: sum.subagentModelNum } : null);

  const session = {
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
    lastModifiedMs: sum?.lastModifiedMs || fpInfo.mtimeMs,
    turns: dbData.turns || 0,
    errorStepCount: dbData.errorStepCount || 0,
    lastStepHasError: Boolean(dbData.lastStepHasError),
    primaryModel,
    calls
  };

  return { session, cacheHit, scanned, cacheDirty };
}

function prepareScanContext({ dataDir, cachePath, summaries, cache }) {
  const activeSummaries = summaries || readConversationSummaries(dataDir);
  const convDir = path.join(dataDir, 'conversations');
  const activeCache = cache || loadCache(cachePath);
  const convDirExists = fs.existsSync(convDir);
  const files = convDirExists
    ? fs.readdirSync(convDir).filter((f) => f.endsWith('.db')).sort()
    : [];
  return { activeSummaries, convDir, convDirExists, activeCache, files };
}

function pruneStaleCacheEntries(cache, files, convDirExists) {
  if (!convDirExists || !cache?.entries) return false;
  const presentIds = new Set(files.map((f) => f.slice(0, -3)));
  let pruned = false;
  for (const id of Object.keys(cache.entries)) {
    if (!presentIds.has(id)) {
      delete cache.entries[id];
      pruned = true;
    }
  }
  return pruned;
}

/**
 * Incrementally scan conversations/*.db using mtime+size+wal fingerprints.
 * Pass cachePath = null (or persist = false) for disk-write-free runs.
 */
function scanConversationsIncremental({
  dataDir = DEFAULT_DATA_DIR,
  cachePath = null,
  summaries = null,
  cache = null,
  persist = true
} = {}) {
  const startMs = Date.now();
  const { activeSummaries, convDir, convDirExists, activeCache, files } = prepareScanContext({
    dataDir,
    cachePath,
    summaries,
    cache
  });

  let cacheDirty = pruneStaleCacheEntries(activeCache, files, convDirExists);
  let cacheHits = 0;
  let scanned = 0;
  const errors = [];
  const sessions = [];

  for (const file of files) {
    const res = scanSingleConversationFile({
      file,
      convDir,
      summaries: activeSummaries,
      cache: activeCache,
      errors
    });
    if (res.cacheHit) cacheHits++;
    if (res.scanned) scanned++;
    if (res.cacheDirty) cacheDirty = true;
    if (res.session) sessions.push(res.session);
  }

  if (persist && cachePath && cacheDirty) {
    saveCacheAtomic(cachePath, activeCache);
  }

  return {
    summaries: activeSummaries,
    sessions,
    cacheDirty,
    stats: {
      totalDbs: files.length,
      cacheHits,
      scanned,
      errors,
      elapsedMs: Date.now() - startMs
    }
  };
}

/**
 * Time-sliced async incremental scan yielding via setImmediate so cold scans
 * do not block the Electron main-process event loop.
 */
async function scanConversationsIncrementalAsync({
  dataDir = DEFAULT_DATA_DIR,
  cachePath = null,
  summaries = null,
  cache = null,
  persist = true,
  timeSliceMs = 12
} = {}) {
  const startMs = Date.now();
  const { activeSummaries, convDir, convDirExists, activeCache, files } = prepareScanContext({
    dataDir,
    cachePath,
    summaries,
    cache
  });

  let cacheDirty = pruneStaleCacheEntries(activeCache, files, convDirExists);
  let cacheHits = 0;
  let scanned = 0;
  const errors = [];
  const sessions = [];
  let sliceStart = performance.now();
  let scannedInSlice = 0;
  let processedInSlice = 0;

  for (const file of files) {
    const res = scanSingleConversationFile({
      file,
      convDir,
      summaries: activeSummaries,
      cache: activeCache,
      errors
    });
    processedInSlice++;
    if (res.cacheHit) cacheHits++;
    if (res.scanned) {
      scanned++;
      scannedInSlice++;
    }
    if (res.cacheDirty) cacheDirty = true;
    if (res.session) sessions.push(res.session);

    if ((scannedInSlice > 0 || processedInSlice >= 16) && performance.now() - sliceStart >= timeSliceMs) {
      await new Promise((r) => setImmediate(r));
      sliceStart = performance.now();
      scannedInSlice = 0;
      processedInSlice = 0;
    }
  }

  if (persist && cachePath && cacheDirty) {
    await saveCacheAtomicAsync(cachePath, activeCache);
  }

  return {
    summaries: activeSummaries,
    sessions,
    cacheDirty,
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
  const dbPath = resolveConversationDbPath(dataDir, conversationId);
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const detail = readConversationDb(dbPath, { includeContext: true });
  if (!detail.contextChatModel) return null;
  return computeContextBreakdown(detail.contextChatModel, { contextLimit });
}

module.exports = {
  DEFAULT_DATA_DIR,
  resolveConversationDbPath,
  toSqliteFileUri,
  hasActiveWal,
  openReadOnlyDb,
  parseSqlTimestampMs,
  readConversationSummaries,
  readConversationDb,
  getDbFingerprintInfo,
  getDbFingerprint,
  getSummaryDbFingerprint,
  loadCache,
  saveCacheAtomic,
  saveCacheAtomicAsync,
  scanConversationsIncremental,
  scanConversationsIncrementalAsync,
  readConversationContext
};

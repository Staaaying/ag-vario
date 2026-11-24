'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const reader = require('../src/main/sqlite-reader');

function encodeVarint(value) {
  let v = BigInt(value);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}
function fVarint(n, v) {
  return Buffer.concat([encodeVarint((n << 3) | 0), encodeVarint(v)]);
}
function fBytes(n, b) {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8');
  return Buffer.concat([encodeVarint((n << 3) | 2), encodeVarint(buf.length), buf]);
}

function buildRawSummary({ title = '', parent = '', root = '', role = '', agent = '' } = {}) {
  const inner = [];
  if (parent) inner.push(fBytes(5, parent));
  if (root) inner.push(fBytes(6, root));
  if (role || agent) {
    inner.push(fBytes(8, Buffer.concat([fBytes(1, agent), fBytes(2, role), fVarint(7, 1525)])));
  }
  const parts = [];
  if (title) parts.push(fBytes(1, title));
  if (inner.length) parts.push(fBytes(17, Buffer.concat(inner)));
  return Buffer.concat(parts);
}

function buildConversationFixture(dbPath, { wal = false, inputTokens = 1000 } = {}) {
  const db = new DatabaseSync(dbPath);
  if (wal) db.exec('PRAGMA journal_mode=WAL;');
  db.exec(`
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, error_details BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0);
  `);

  const tsBuf = Buffer.concat([fVarint(1, 1795508720), fVarint(2, 0)]);
  const stepMeta = fBytes(1, tsBuf);
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata, error_details) VALUES (?, ?, ?, ?, ?)').run(
    0, 14, 3, stepMeta, null
  );
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata, error_details) VALUES (?, ?, ?, ?, ?)').run(
    1, 15, 3, stepMeta, null
  );

  const cmBuf = Buffer.concat([
    fVarint(3, 1525),
    fBytes(4, Buffer.concat([fVarint(2, inputTokens), fVarint(3, 250), fVarint(5, 4000)])),
    fBytes(11, Buffer.concat([fVarint(1, 1), fVarint(2, 500000000)])),
    fBytes(12, Buffer.concat([fVarint(1, 2), fVarint(2, 0)])),
    fBytes(19, 'gemini-4-hydrogen'),
    fBytes(21, 'Gemini 4 Hydrogen (High)'),
    fBytes(16, Buffer.concat([fBytes(1, 'identity'), fBytes(2, 'hello world'), fVarint(6, 1)])),
    fBytes(2, Buffer.concat([fVarint(2, 1), fVarint(4, 1000)]))
  ]);
  const gmBuf = Buffer.concat([fBytes(1, cmBuf), fBytes(2, encodeVarint(1))]);
  db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, gmBuf, 0);
  db.close();
}

test('sqlite-reader: WAL-safe read-only summaries, incremental cache, and context breakdown', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-vario-test-'));
  try {
    const convDir = path.join(tmpDir, 'conversations');
    fs.mkdirSync(convDir, { recursive: true });

    // Create conversation_summaries.db with 1 main, 1 subagent, 1 workflow child
    const sumDb = new DatabaseSync(path.join(tmpDir, 'conversation_summaries.db'));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY, title TEXT DEFAULT '', preview TEXT DEFAULT '',
        step_count INTEGER DEFAULT 0, last_modified_time TEXT NOT NULL, status TEXT DEFAULT '',
        project_id TEXT DEFAULT '', agent_name TEXT DEFAULT '', parent_conversation_id TEXT DEFAULT '',
        nesting_depth INTEGER DEFAULT 0, killed INTEGER DEFAULT 0, last_user_input_time TEXT NOT NULL,
        raw_summary BLOB
      );
    `);
    const ins = sumDb.prepare(`
      INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    ins.run('main-1', 'Main Conversation', 'Main Conversation', 2, '2026-11-24 08:00:00+00:00',
      'CASCADE_RUN_STATUS_IDLE', 'proj-1', '', '', 0, 0, '2026-11-24 08:00:00+00:00',
      buildRawSummary({ title: 'Main Conversation', root: 'main-1' }));
    ins.run('sub-1', '', '', 2, '2026-11-24 08:01:00+00:00',
      'CASCADE_RUN_STATUS_RUNNING', 'proj-1', 'self', 'main-1', 1, 0, '2026-11-24 08:01:00+00:00',
      buildRawSummary({ parent: 'main-1', root: 'main-1', role: 'Code Verifier', agent: 'self' }));
    ins.run('wf-1', '', 'Analyze batch 1\nDetails', 2, '2026-11-24 08:02:00+00:00',
      'CASCADE_RUN_STATUS_IDLE', 'proj-1', 'research', '', 0, 0, '2026-11-24 08:02:00+00:00',
      buildRawSummary({ title: 'Analyze batch 1', root: 'main-1' }));
    sumDb.close();

    buildConversationFixture(path.join(convDir, 'main-1.db'), { wal: false, inputTokens: 1000 });
    buildConversationFixture(path.join(convDir, 'sub-1.db'), { wal: true, inputTokens: 2000 });
    buildConversationFixture(path.join(convDir, 'wf-1.db'), { wal: false, inputTokens: 3000 });

    const cachePath = path.join(tmpDir, 'cache.json');

    // First scan: 3 scanned, 0 cache hits
    const first = reader.scanConversationsIncremental({ dataDir: tmpDir, cachePath });
    assert.equal(first.stats.totalDbs, 3);
    assert.equal(first.stats.scanned, 3);
    assert.equal(first.stats.cacheHits, 0);
    assert.equal(first.stats.errors.length, 0);
    assert.equal(first.summaries.childrenByRoot.get('main-1').length, 2);
    assert.equal(first.summaries.byId.get('sub-1').title, 'Code Verifier');
    assert.equal(first.summaries.byId.get('sub-1').normalizedStatus, 'Running');
    assert.equal(first.summaries.byId.get('wf-1').kind, 'workflow');
    assert.equal(first.summaries.byId.get('wf-1').rootConversationId, 'main-1');

    // Second scan: 3 cache hits, 0 scanned
    const second = reader.scanConversationsIncremental({ dataDir: tmpDir, cachePath });
    assert.equal(second.stats.cacheHits, 3);
    assert.equal(second.stats.scanned, 0);

    // Mutate sub-1.db in WAL mode without checkpointing -> cache invalidates via WAL fingerprint
    const subDbMut = new DatabaseSync(path.join(convDir, 'sub-1.db'));
    subDbMut.prepare('UPDATE steps SET step_type = 14 WHERE idx = 1').run();
    subDbMut.close();

    const third = reader.scanConversationsIncremental({ dataDir: tmpDir, cachePath });
    assert.equal(third.stats.scanned, 1);
    assert.equal(third.stats.cacheHits, 2);

    // On-demand context breakdown
    const ctx = reader.readConversationContext(tmpDir, 'main-1', { contextLimit: 1000000 });
    assert.equal(ctx.breakdownAvailable, true);
    assert.equal(ctx.exactPromptTokens, 5000);
    assert.equal(ctx.categories.reduce((s, c) => s + c.tokens, 0), 5000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

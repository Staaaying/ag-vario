'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createCollector } = require('../src/main/collector');
const pricing = require('../src/core/pricing');

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

function buildConversationDb(dbPath, { inputTokens = 1000, sectionText = 'System info' } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, error_details BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0);
  `);
  const tsBuf = Buffer.concat([fVarint(1, 1795508720), fVarint(2, 0)]);
  const stepMeta = fBytes(1, tsBuf);
  db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(0, 14, 3, stepMeta, null);
  db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(1, 15, 3, stepMeta, null);
  db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(2, 23, 3, stepMeta, null);

  const cmBuf = Buffer.concat([
    fVarint(3, 1525),
    fBytes(4, Buffer.concat([fVarint(2, inputTokens), fVarint(3, 200), fVarint(5, 3000)])),
    fBytes(9, Buffer.concat([fVarint(1, 2), fBytes(10, fVarint(2, 2))])),
    fBytes(19, 'gemini-4-hydrogen'),
    fBytes(21, 'Gemini 4 Hydrogen (High)'),
    fBytes(16, Buffer.concat([fBytes(1, 'identity'), fBytes(2, sectionText), fVarint(6, 1)])),
    fBytes(2, Buffer.concat([fVarint(2, 1), fVarint(4, 1500)]))
  ]);
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(0, Buffer.concat([fBytes(1, cmBuf), fBytes(2, encodeVarint(1))]), 0);
  db.close();
}

test('collector: quota TTL, session RPC + SQLite fallback, on-demand context, usage stateDir isolation, avatar', async () => {
  const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-vario-col-'));
  const dataDir = path.join(rootTmp, 'data');
  const stateDir = path.join(rootTmp, 'state');
  const convDir = path.join(dataDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  try {
    const sumDb = new DatabaseSync(path.join(dataDir, 'conversation_summaries.db'));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY, title TEXT DEFAULT '', preview TEXT DEFAULT '',
        step_count INTEGER DEFAULT 0, last_modified_time TEXT NOT NULL, status TEXT DEFAULT '',
        project_id TEXT DEFAULT '', agent_name TEXT DEFAULT '', parent_conversation_id TEXT DEFAULT '',
        nesting_depth INTEGER DEFAULT 0, killed INTEGER DEFAULT 0, last_user_input_time TEXT NOT NULL,
        raw_summary BLOB
      );
    `);
    const ins = sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run('main-1', 'Main Session', 'Main Session', 2, '2026-11-24 08:00:00+00:00',
      'CASCADE_RUN_STATUS_IDLE', 'p1', '', '', 0, 0, '2026-11-24 08:00:00+00:00', fBytes(1, 'Main Session'));
    ins.run('sub-1', '', '', 2, '2026-11-24 08:01:00+00:00',
      'CASCADE_RUN_STATUS_RUNNING', 'p1', 'self', 'main-1', 1, 0, '2026-11-24 08:01:00+00:00',
      fBytes(17, Buffer.concat([fBytes(5, 'main-1'), fBytes(6, 'main-1'), fBytes(8, Buffer.concat([fBytes(1, 'self'), fBytes(2, 'Worker')]))])));
    sumDb.close();

    buildConversationDb(path.join(convDir, 'main-1.db'), { inputTokens: 1000 });
    buildConversationDb(path.join(convDir, 'sub-1.db'), { inputTokens: 2000 });

    let nowMs = Date.parse('2026-11-24T10:00:00Z');
    let quotaRpcCount = 0;
    let rpcShouldFail = false;

    const collector = createCollector({
      dataDir,
      stateDir,
      pricingSyncEnabled: false,
      nowFn: () => nowMs,
      fetchUrlFn: async () => ({ contentType: 'image/png', buffer: Buffer.from('fakepng') }),
      createRpcClientFn: () => ({
        retrieveUserQuotaSummary: async () => {
          quotaRpcCount++;
          return {
            response: {
              groups: [
                {
                  groupId: 'gemini-main',
                  displayName: 'Gemini',
                  buckets: [{ bucketId: 'b1', window: '5h', remainingFraction: 0.8, resetTime: '2026-11-24T12:00:00Z' }]
                }
              ]
            }
          };
        },
        getUserStatus: async () => ({
          userStatus: {
            name: 'Pilot',
            email: 'pilot@example.com',
            profilePictureUrl: 'https://example.com/pic.png',
            userTier: { id: 'g1-ultra-lite-tier' },
            cascadeModelConfigData: {
              clientModelConfigs: [{ label: 'Gemini 4 Hydrogen (High)', maxContextTokens: 1000000 }]
            }
          }
        }),
        getCascadeTrajectoryGeneratorMetadata: async (id, opts) => {
          if (rpcShouldFail) throw new Error('RPC down');
          if (opts.includeMessages) {
            return {
              generatorMetadata: [
                {
                  chatModel: {
                    modelDisplayName: 'Gemini 4 Hydrogen (High)',
                    usage: { inputTokens: 5000, cacheReadTokens: 15000 },
                    promptSections: [{ title: 'identity', content: 'A'.repeat(400), tokenType: 'TOKEN_TYPE_SYSTEM_PROMPT' }],
                    tools: [{ name: 'read_file', description: 'read', jsonSchemaString: '{}', serverName: '' }],
                    messagePrompts: [{ numTokens: 12000 }]
                  }
                }
              ]
            };
          }
          return {
            generatorMetadata: [
              {
                chatModel: {
                  modelDisplayName: 'Gemini 4 Hydrogen (High)',
                  usage: { inputTokens: id === 'main-1' ? 5000 : 2000, outputTokens: 300, cacheReadTokens: 10000 },
                  chatStartMetadata:
                    id === 'main-1'
                      ? { startStepIndex: 2, contextWindowMetadata: { truncationReason: 'TRUNCATION_REASON_MAX_TOKEN_LIMIT' } }
                      : undefined,
                  timeToFirstToken: '1.5s',
                  streamingDuration: '3.0s'
                }
              }
            ]
          };
        }
      })
    });

    // 1. Quota TTL cache + avatar caching
    const q1 = await collector.getQuotaSnapshot({ origin: 'https://127.0.0.1:45000' });
    assert.equal(q1.ok, true);
    assert.equal(q1.cached, false);
    assert.equal(q1.data.profile.planBadge, 'Ultra');
    assert.ok(q1.data.profile.avatarDataUrl.startsWith('data:image/png;base64,'));
    assert.equal(quotaRpcCount, 1);

    const q2 = await collector.getQuotaSnapshot({ origin: 'https://127.0.0.1:45000' });
    assert.equal(q2.cached, true);
    assert.equal(quotaRpcCount, 1);

    nowMs += 5 * 60 * 1000;
    const q3 = await collector.getQuotaSnapshot({ origin: 'https://127.0.0.1:45000' });
    assert.equal(q3.cached, false);
    assert.equal(quotaRpcCount, 2);

    // 2. Session snapshot via RPC + subagent
    const s1 = await collector.getSessionSnapshot({ origin: 'https://127.0.0.1:45000', conversationId: 'main-1' });
    assert.equal(s1.ok, true);
    assert.equal(s1.source, 'rpc');
    assert.equal(s1.data.main.turns, 1);
    assert.equal(s1.data.main.waterline.contextLimit, 1000000);
    assert.equal(s1.data.main.compaction.compacted, true);
    assert.equal(s1.data.main.compaction.count, 1);
    assert.equal(s1.data.subagentSummary.badgeText, '1/1');

    // 3. Context breakdown on-demand (RPC) and fallback (SQLite)
    const c1 = await collector.getContextBreakdown({ origin: 'https://127.0.0.1:45000', conversationId: 'main-1' });
    assert.equal(c1.ok, true);
    assert.equal(c1.source, 'rpc');
    assert.equal(c1.data.exactPromptTokens, 20000);

    rpcShouldFail = true;
    const sFallback = await collector.getSessionSnapshot({ origin: 'https://127.0.0.1:45000', conversationId: 'main-1' });
    assert.equal(sFallback.ok, true);
    assert.equal(sFallback.source, 'sqlite');
    assert.equal(sFallback.data.main.compaction.compacted, true);
    assert.equal(sFallback.data.main.compaction.count, 1);

    const cFallback = await collector.getContextBreakdown({ origin: 'https://127.0.0.1:45000', conversationId: 'main-1' });
    assert.equal(cFallback.ok, true);
    assert.equal(cFallback.source, 'sqlite');
    assert.equal(cFallback.data.exactPromptTokens, 4000);

    // 4. Usage report writes cache ONLY in stateDir (never dataDir)
    const u1 = await collector.getUsageReport({ period: '7D' });
    assert.equal(u1.ok, true);
    assert.equal(u1.profile.planBadge, 'Ultra');
    assert.ok(fs.existsSync(path.join(stateDir, 'conversations-cache-v1.json')));
    assert.equal(fs.existsSync(path.join(dataDir, 'conversations-cache-v1.json')), false);

    // 5. Inline data-URL avatar is returned directly without remote fetch
    let avatarFetched = false;
    const inlineCollector = createCollector({
      dataDir,
      stateDir,
      pricingSyncEnabled: false,
      fetchUrlFn: async () => {
        avatarFetched = true;
        return { contentType: 'image/png', buffer: Buffer.from('x') };
      }
    });
    const inlineUrl = await inlineCollector.resolveAvatarDataUrl({
      profilePictureUrl: 'data:image/jpeg;base64,AAAA',
      email: 'pilot@example.com'
    });
    assert.equal(inlineUrl, 'data:image/jpeg;base64,AAAA');
    assert.equal(avatarFetched, false);

    // 6. Custom local avatar overrides cached remote avatar
    fs.writeFileSync(path.join(stateDir, 'avatar-custom.png'), Buffer.from('custompng'));
    const customUrl = await collector.resolveAvatarDataUrl({ email: 'pilot@example.com' });
    assert.equal(customUrl, `data:image/png;base64,${Buffer.from('custompng').toString('base64')}`);
  } finally {
    pricing.clearDynamicPricing();
    fs.rmSync(rootTmp, { recursive: true, force: true });
  }
});

test('collector: daily official pricing sync caches to stateDir, applies dynamic rates, and survives fetch errors', async () => {
  const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-vario-psync-'));
  const dataDir = path.join(rootTmp, 'data');
  const stateDir = path.join(rootTmp, 'state');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const gemMd = `
## Gemini 4 Neon  {% id="gemini-4-neon" %}
{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD
  ---
  * Input price
  * Not available
  * $3.20
  ---
  * Output price (including thinking tokens)
  * Not available
  * $16.00
  ---
  * Context caching price
  * Not available
  * $0.16
  {% /table %}
  {% /tab %}
{% /tabs %}
`;
  const claudeMd = `
## Model pricing
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---- | :---- | :---- | :---- | :---- |
| Claude Fable 5.2 | $8 / MTok | $10 / MTok | $16 / MTok | $0.20 / MTok | $40 / MTok |
`;

  try {
    let nowMs = Date.parse('2026-11-24T10:00:00Z');
    let fetches = 0;
    let shouldFail = false;

    const c1 = createCollector({
      dataDir,
      stateDir,
      nowFn: () => nowMs,
      fetchTextFn: async (url) => {
        fetches++;
        if (shouldFail) throw new Error('offline');
        if (url.includes('ai.google.dev')) return gemMd;
        return claudeMd;
      }
    });

    const r1 = await c1.refreshPricing();
    assert.equal(r1.ok, true);
    assert.equal(r1.updated, true);
    assert.equal(r1.count, 2);
    assert.equal(fetches, 2);
    assert.ok(fs.existsSync(path.join(stateDir, 'pricing-cache-v1.json')));
    assert.equal(fs.existsSync(path.join(dataDir, 'pricing-cache-v1.json')), false);

    // Dynamic rate ($3.20/1M) overrides built-in ($3.00/1M) and adds Claude Fable 5.2
    const neonCost = pricing.calculateCallCost({ inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0 }, 'Gemini 4 Neon (High)');
    assert.ok(Math.abs(neonCost.costUsd - 3.2) < 1e-9);
    const fableCost = pricing.calculateCallCost({ inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0 }, 'Claude Fable 5.2');
    assert.equal(fableCost.priced, true);
    assert.ok(Math.abs(fableCost.costUsd - 8) < 1e-9);

    // Within 24h TTL -> cached, no refetch
    nowMs += 2 * 3600 * 1000;
    const r2 = await c1.refreshPricing();
    assert.equal(r2.ok, true);
    assert.equal(r2.updated, false);
    assert.equal(r2.cached, true);
    assert.equal(fetches, 2);

    // After 24h TTL, if fetch fails, cached dynamic rates stay intact
    pricing.clearDynamicPricing();
    nowMs += 25 * 3600 * 1000;
    shouldFail = true;
    const c2 = createCollector({
      dataDir,
      stateDir,
      nowFn: () => nowMs,
      fetchTextFn: async () => {
        fetches++;
        throw new Error('offline');
      }
    });
    // Loaded cache synchronously on construction
    const cachedNeon = pricing.calculateCallCost({ inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0 }, 'Gemini 4 Neon (High)');
    assert.ok(Math.abs(cachedNeon.costUsd - 3.2) < 1e-9);

    const r3 = await c2.refreshPricing({ force: true });
    assert.equal(r3.ok, false);
    assert.equal(r3.updated, false);
    const stillCached = pricing.calculateCallCost({ inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0 }, 'Gemini 4 Neon (High)');
    assert.ok(Math.abs(stillCached.costUsd - 3.2) < 1e-9);
  } finally {
    pricing.clearDynamicPricing();
    fs.rmSync(rootTmp, { recursive: true, force: true });
  }
});

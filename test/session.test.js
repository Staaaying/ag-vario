'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('../src/core/session');

test('session: computeSessionStats skips 0-token calls and aggregates metrics accurately', () => {
  const stats = session.computeSessionStats({
    conversationId: 'main-1',
    title: 'Test Session',
    turns: 3,
    contextLimit: 1000000,
    calls: [
      // aborted 0-token call should be skipped
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, modelDisplayName: 'Gemini 4 Carbon (Medium)' },
      {
        timestampMs: Date.parse('2026-11-24T10:00:00+08:00'),
        modelDisplayName: 'Gemini 4 Carbon (Medium)',
        usage: { input_tokens: '10000', output_tokens: '500', cache_read_tokens: '30000' },
        timeToFirstToken: '2.0s',
        streamingDuration: '5.0s'
      },
      {
        timestampMs: Date.parse('2026-11-24T10:01:00+08:00'),
        modelDisplayName: 'Gemini 4 Hydrogen (High)', // switched mid-session; still billed as Carbon!
        usage: { inputTokens: 20000, outputTokens: 1500, cacheReadTokens: 70000 },
        ttftMs: 4000,
        streamingMs: 15000
      }
    ]
  });

  assert.equal(stats.turns, 3);
  assert.equal(stats.steps, 2);
  assert.equal(stats.inputTokens, 30000);
  assert.equal(stats.outputTokens, 2000);
  assert.equal(stats.cacheReadTokens, 100000);
  assert.equal(stats.totalTokens, 132000);
  assert.ok(Math.abs(stats.cacheHitRate - 100000 / 130000) < 1e-9);
  assert.equal(stats.avgTtftMs, 3000);
  // weighted speed = 2000 / (20s) = 100 tok/s
  assert.equal(stats.outputSpeedTps, 100);
  assert.equal(stats.modelTimeMs, 26000);
  assert.equal(stats.currentContextTokens, 90000);
  assert.equal(stats.waterline.percent, 9);
  assert.equal(stats.waterline.level, 'green');
  assert.equal(stats.primaryModel.modelKey, 'gemini-4-carbon');
  assert.equal(stats.cost.priced, true);
  // Carbon Nov rate: (30000*2 + 100000*0.10 + 2000*10) / 1e6 = (60000 + 10000 + 20000)/1e6 = 0.09
  assert.ok(Math.abs(stats.cost.costUsd - 0.09) < 1e-9);
});

test('session: combineSessionWithSubagents aggregates running/done/error and mixed pricing', () => {
  const mainStats = session.computeSessionStats({
    conversationId: 'main-1',
    turns: 2,
    calls: [
      {
        timestampMs: Date.parse('2026-11-24T10:00:00+08:00'),
        modelDisplayName: 'Gemini 4 Carbon (Medium)',
        inputTokens: 100000,
        outputTokens: 10000,
        cacheReadTokens: 0
      }
    ]
  });

  const sub1 = {
    ...session.computeSessionStats({
      conversationId: 'sub-1',
      title: 'PDF Verifier',
      calls: [
        {
          timestampMs: Date.parse('2026-11-24T10:01:00+08:00'),
          modelDisplayName: 'Gemini 4 Hydrogen (High)',
          inputTokens: 100000,
          outputTokens: 10000,
          cacheReadTokens: 0
        }
      ]
    }),
    kind: 'subagent',
    status: 'CASCADE_RUN_STATUS_RUNNING'
  };

  const sub2 = {
    ...session.computeSessionStats({
      conversationId: 'sub-2',
      title: 'Experimental Worker',
      calls: [
        {
          timestampMs: Date.parse('2026-11-24T10:02:00+08:00'),
          modelDisplayName: 'Custom Experimental Model (High)',
          inputTokens: 50000,
          outputTokens: 5000,
          cacheReadTokens: 0
        }
      ]
    }),
    kind: 'workflow',
    status: 'CASCADE_RUN_STATUS_IDLE',
    lastStepHasError: true
  };

  const combinedEmpty = session.combineSessionWithSubagents(mainStats, []);
  assert.equal(combinedEmpty.subagentSummary.badgeText, '0');

  const combined = session.combineSessionWithSubagents(mainStats, [sub1, sub2]);
  assert.equal(combined.totalTokens, 110000 + 110000 + 55000);
  assert.equal(combined.subagentSummary.runningCount, 1);
  assert.equal(combined.subagentSummary.totalCount, 2);
  assert.equal(combined.subagentSummary.badgeText, '1/2');
  assert.equal(combined.subagentSummary.items[0].status, 'Running');
  assert.equal(combined.subagentSummary.items[1].status, 'Error');
  assert.equal(combined.totalCost.priced, true);
  assert.equal(combined.totalCost.hasUnpriced, true);
  assert.equal(combined.totalCost.unpricedTokens, 55000);
  // main Carbon (0.2 + 0.1 = 0.3) + sub1 Hydrogen (0.15 + 0.075 = 0.225) = 0.525
  assert.ok(Math.abs(combined.totalCost.costUsd - 0.525) < 1e-9);

  // Automatic contextLimit resolution from chatStartMetadata.contextWindowMetadata.maxContextTokens
  const autoCtx = session.computeSessionStats({
    conversationId: 'auto-ctx',
    calls: [
      {
        chatModel: {
          modelDisplayName: 'Gemini 4 Neon (XHigh)',
          usage: { inputTokens: 16000, cacheReadTokens: 240000 },
          chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } }
        }
      }
    ]
  });
  assert.equal(autoCtx.waterline.contextLimit, 512000);
  assert.equal(autoCtx.waterline.percent, 50);
  assert.equal(autoCtx.waterline.level, 'orange');
  assert.equal(autoCtx.compaction.compacted, false);
  assert.equal(autoCtx.compaction.count, 0);
});

test('session: computeSessionStats tracks 0x, 1x, 3x compaction and checkpoint-only state', () => {
  const oneCompact = session.computeSessionStats({
    conversationId: 'c-1x',
    checkpointCount: 1,
    calls: [
      {
        chatModel: {
          modelDisplayName: 'Gemini 4 Neon (XHigh)',
          usage: { inputTokens: 14867, cacheReadTokens: 500000 },
          chatStartMetadata: { checkpointIndex: -1, contextWindowMetadata: { maxContextTokens: 512000 } }
        }
      },
      {
        chatModel: {
          modelDisplayName: 'Gemini 4 Neon (XHigh)',
          usage: { inputTokens: 23014, cacheReadTokens: 0 },
          chatStartMetadata: {
            startStepIndex: 44,
            contextWindowMetadata: {
              truncationReason: 'TRUNCATION_REASON_MAX_TOKEN_LIMIT',
              maxContextTokens: 512000
            }
          }
        }
      }
    ]
  });
  assert.equal(oneCompact.compaction.compacted, true);
  assert.equal(oneCompact.compaction.count, 1);
  assert.equal(oneCompact.compaction.lastBeforeTokens, 514867);
  assert.equal(oneCompact.compaction.lastAfterTokens, 23014);
  assert.equal(oneCompact.compaction.lastTruncationReason, 'TRUNCATION_REASON_MAX_TOKEN_LIMIT');
  assert.equal(oneCompact.compaction.lastStartStepIndex, 44);

  const threeCompacts = session.computeSessionStats({
    conversationId: 'c-3x',
    checkpointCount: 3,
    calls: [
      { chatModel: { usage: { inputTokens: 164300, cacheReadTokens: 0 }, chatStartMetadata: { checkpointIndex: -1 } } },
      { chatModel: { usage: { inputTokens: 21220, cacheReadTokens: 0 }, chatStartMetadata: { startStepIndex: 44, contextWindowMetadata: { truncationReason: 'TRUNCATION_REASON_MAX_TOKEN_LIMIT' } } } },
      { chatModel: { usage: { inputTokens: 17348, cacheReadTokens: 500000 }, chatStartMetadata: { startStepIndex: 44 } } },
      { chatModel: { usage: { inputTokens: 26617, cacheReadTokens: 0 }, chatStartMetadata: { startStepIndex: 159, checkpointIndex: 1, contextWindowMetadata: { truncationReason: 'TRUNCATION_REASON_MAX_TOKEN_LIMIT' } } } },
      { chatModel: { usage: { inputTokens: 14867, cacheReadTokens: 500000 }, chatStartMetadata: { startStepIndex: 159, checkpointIndex: 1 } } },
      { chatModel: { usage: { inputTokens: 23014, cacheReadTokens: 0 }, chatStartMetadata: { startStepIndex: 208, checkpointIndex: 2, contextWindowMetadata: { truncationReason: 'TRUNCATION_REASON_MAX_TOKEN_LIMIT' } } } }
    ]
  });
  assert.equal(threeCompacts.compaction.compacted, true);
  assert.equal(threeCompacts.compaction.count, 3);
  assert.equal(threeCompacts.compaction.lastBeforeTokens, 514867);
  assert.equal(threeCompacts.compaction.lastAfterTokens, 23014);
  assert.equal(threeCompacts.compaction.lastStartStepIndex, 208);

  const cpOnly = session.computeSessionStats({
    conversationId: 'c-cp-only',
    checkpointCount: 1,
    calls: [{ chatModel: { usage: { inputTokens: 400000, cacheReadTokens: 0 } } }]
  });
  assert.equal(cpOnly.compaction.compacted, true);
  assert.equal(cpOnly.compaction.count, 1);
  assert.equal(cpOnly.compaction.lastBeforeTokens, null);
  assert.equal(cpOnly.compaction.lastAfterTokens, null);
});


test('session: pickFirstValidModel short-circuits to first valid call and falls back cleanly', () => {
  const model1 = session.pickFirstValidModel([
    { inputTokens: 0, outputTokens: 0, modelDisplayName: 'Gemini 4 Carbon (Medium)' },
    { inputTokens: 100, outputTokens: 20, modelDisplayName: 'Gemini 4 Hydrogen (High)' },
    { inputTokens: 500, outputTokens: 50, modelDisplayName: 'Gemini 4 Neon (XHigh)' }
  ]);
  assert.equal(model1.modelKey, 'gemini-4-hydrogen');

  const fallback = session.pickFirstValidModel([
    { inputTokens: 0, outputTokens: 0, modelDisplayName: 'Gemini 4 Carbon (Medium)' },
    { inputTokens: 0, outputTokens: 0, modelDisplayName: 'Gemini 4 Neon (XHigh)' }
  ]);
  assert.equal(fallback.modelKey, 'gemini-4-carbon');

  assert.equal(session.pickFirstValidModel([]).modelKey, 'unknown');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const quota = require('../src/core/quota');

test('quota: parseUserProfile prioritizes userTier over planInfo', () => {
  const prof = quota.parseUserProfile({
    userStatus: {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      profilePictureUrl: 'https://example.com/ada.png',
      userTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' },
      planInfo: { planName: 'Pro', teamsTier: 'TEAMS_TIER_PRO' }
    }
  });
  assert.equal(prof.tier, 'ultra');
  assert.equal(prof.planBadge, 'Ultra');
  assert.equal(prof.planFullName, 'Google AI Ultra (5x)');
  assert.equal(prof.initials, 'AL');
  assert.equal(prof.profilePictureUrl, 'https://example.com/ada.png');

  const ultra20x = quota.parseUserProfile({
    userStatus: {
      userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' }
    }
  });
  assert.equal(ultra20x.tier, 'ultra');
  assert.equal(ultra20x.planBadge, 'Ultra');
  assert.equal(ultra20x.planFullName, 'Google AI Ultra (20x)');

  const fallback = quota.parseUserProfile({
    userStatus: {
      email: 'pro@example.com',
      planInfo: { planName: 'Pro', teamsTier: 'TEAMS_TIER_PRO' }
    }
  });
  assert.equal(fallback.tier, 'pro');
  assert.equal(fallback.planBadge, 'Pro');
  assert.equal(fallback.planFullName, 'Google AI Pro');
  assert.equal(fallback.initials, 'PR');
});

test('quota: parseQuotaFraction distinguishes QuotaSummaryBucket vs QuotaInfo proto3 zero omission', () => {
  // QuotaSummaryBucket uses oneof remaining -> missing field means unknown (null), not 0%
  assert.equal(
    quota.parseQuotaFraction({ resetTime: '2026-11-24T12:00:00Z' }, { schemaKind: 'quota_summary_bucket' }),
    null
  );
  // QuotaInfo uses proto3 scalar float -> missing field with resetTime & enabled means 0% exhausted
  assert.equal(
    quota.parseQuotaFraction({ resetTime: '2026-11-24T12:00:00Z' }, { schemaKind: 'codeium_quota_info' }),
    0
  );
  assert.equal(quota.parseQuotaFraction({ remainingFraction: 0.84 }), 0.84);
});

test('quota: buildQuotaSnapshot builds dual rings, pools, Orchestrator matching, and context limits', () => {
  const nowMs = Date.parse('2026-11-24T10:00:00Z');
  const snap = quota.buildQuotaSnapshot({
    nowMs,
    currentModel: 'Orchestrator Gemini 4 Carbon Medium',
    userStatusRes: {
      userStatus: {
        name: 'Test Pilot',
        email: 'pilot@example.com',
        userTier: { id: 'g1-ultra-lite-tier' },
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: 'Gemini 4 Neon (High)',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' },
              contextWindowOptions: [1000000]
            },
            {
              label: 'Orchestrator (Carbon)',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M667' },
              maxContextTokens: 1000000
            },
            {
              label: 'Claude Opus 5.5 (High)',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' },
              maxContextTokens: 200000
            }
          ]
        }
      }
    },
    quotaSummaryRes: {
      response: {
        groups: [
          {
            groupId: 'gemini-main',
            displayName: 'Gemini',
            buckets: [
              { bucketId: 'b1', window: '5h', remainingFraction: 0.84, resetTime: '2026-11-24T12:30:00Z' },
              { bucketId: 'b2', window: 'weekly', remainingFraction: 0.71, resetTime: '2026-11-28T00:00:00Z' }
            ]
          },
          {
            groupId: 'gemini-carbon',
            displayName: 'Gemini Carbon',
            buckets: [
              { bucketId: 'b3', window: '5h', remainingFraction: 0.92, resetTime: '2026-11-24T13:00:00Z' },
              { bucketId: 'b4', window: 'weekly', remainingFraction: 0.88, resetTime: '2026-11-28T00:00:00Z' }
            ]
          },
          {
            groupId: '3p',
            displayName: 'Claude',
            buckets: [
              { bucketId: 'b5', window: '5h', remainingFraction: 0.65, resetTime: '2026-11-24T14:00:00Z' }
            ]
          }
        ]
      }
    }
  });

  assert.equal(snap.profile.planBadge, 'Ultra');
  assert.equal(snap.pools.length, 3);
  assert.equal(snap.nextReset.countdown, '2h 30m');
  // Current model is Orchestrator Carbon -> rings prefer gemini_carbon pool (92% / 88%)
  assert.equal(snap.summaryRings.window5h.percent, 92);
  assert.equal(snap.summaryRings.window7d.percent, 88);

  assert.equal(
    quota.lookupContextLimit('Orchestrator Gemini 4 Carbon Medium', snap.clientModelConfigs),
    1000000
  );
  assert.equal(
    quota.lookupContextLimit({ modelDisplayName: 'Claude Opus 5.5 (High)' }, snap.clientModelConfigs),
    200000
  );
});

test('quota: deduplicates clientModelConfigs under authoritative groups and never leaks Claude 7d into Gemini rings', () => {
  const nowMs = Date.parse('2026-11-24T10:00:00Z');
  const snap = quota.buildQuotaSnapshot({
    nowMs,
    currentModel: 'Orchestrator Gemini 4 Neon Extra High',
    userStatusRes: {
      userStatus: {
        userTier: { id: 'g1-ultra-lite-tier' },
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Gemini 4 Neon (High)', quotaInfo: { remainingFraction: 0.91 } },
            { label: 'Orchestrator (Carbon)', quotaInfo: { remainingFraction: 0.92 } },
            { label: 'Gemini 4 Argon (Medium)', quotaInfo: { remainingFraction: 0.91 } },
            { label: 'Claude Opus 5.5 (High)', quotaInfo: { remainingFraction: 0.30 } }
          ]
        }
      }
    },
    quotaSummaryRes: {
      response: {
        groups: [
          {
            groupId: 'gemini',
            displayName: 'Gemini',
            description: 'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 4 Carbon, Gemini 4 Argon',
            buckets: [{ bucketId: 'g-5h', window: '5h', remainingFraction: 0.91, resetTime: '2026-11-24T12:44:00Z' }]
          },
          {
            groupId: '3p',
            displayName: 'Claude',
            description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5',
            buckets: [
              { bucketId: 'c-5h', window: '5h', remainingFraction: 1.0, resetTime: '2026-11-24T14:58:00Z' },
              { bucketId: 'c-7d', window: 'weekly', remainingFraction: 0.30, resetTime: '2026-11-25T07:46:00Z' }
            ]
          }
        ]
      }
    }
  });

  // Only 2 pools (Gemini Models + Claude and GPT models) — no redundant Gemini Carbon / Gemini Argon duplication
  assert.equal(snap.pools.length, 2);
  assert.deepEqual(snap.pools.map((p) => p.title), ['Gemini Models', 'Claude and GPT models']);
  assert.equal(snap.pools[0].bucket5h.label, '5h limit');
  assert.equal(snap.pools[1].bucket7d.label, 'Weekly limit');
  // Active model is Gemini -> 5h is 91%, 7d must be null (NOT Claude's 30%!)
  assert.equal(snap.summaryRings.window5h.percent, 91);
  assert.equal(snap.summaryRings.window7d, null);
});

test('quota: computeWeeklyCycleInfo computes lastResetAtMs and Strategy B burn rate with <3h/<10% early rule', () => {
  const HOUR = 3600 * 1000;
  const WEEK = 7 * 24 * HOUR;
  const nowMs = Date.parse('2026-11-24T12:00:00Z');

  // 1. Early cycle (<3h elapsed and <10% used) -> Early cycle
  const earlyOk = quota.computeWeeklyCycleInfo(
    { remainingFraction: 0.94, resetAtMs: nowMs + WEEK - 2 * HOUR },
    nowMs
  );
  assert.equal(earlyOk.lastResetAtMs, nowMs - 2 * HOUR);
  assert.equal(earlyOk.pace.state, 'early');
  assert.equal(earlyOk.pace.label, 'Early cycle');

  // 2. Early cycle (<3h elapsed and >=10% used) -> enters normal calculation and flags High burn
  const earlyWarn = quota.computeWeeklyCycleInfo(
    { remainingFraction: 0.86, resetAtMs: nowMs + WEEK - 2 * HOUR },
    nowMs
  );
  assert.equal(earlyWarn.pace.state, 'high_burn');
  assert.equal(earlyWarn.pace.label, 'High burn · >9.9×');

  // 3. Mid-cycle On track (<=90% projected)
  const onTrack = quota.computeWeeklyCycleInfo(
    { remainingFraction: 0.72, resetAtMs: nowMs + WEEK - 84 * HOUR },
    nowMs
  );
  assert.equal(onTrack.pace.state, 'on_track');
  assert.equal(onTrack.pace.label, 'On track · 0.6×');

  // 4. On pace (90% - 105% projected)
  const onPace = quota.computeWeeklyCycleInfo(
    { remainingFraction: 0.94, resetAtMs: nowMs + WEEK - 10 * HOUR },
    nowMs
  );
  assert.equal(onPace.pace.state, 'on_pace');
  assert.equal(onPace.pace.label, 'On pace · 1.0×');

  // 5. High burn (>105% projected)
  const highBurn = quota.computeWeeklyCycleInfo(
    { remainingFraction: 0.55, resetAtMs: nowMs + WEEK - 54 * HOUR },
    nowMs
  );
  assert.equal(highBurn.pace.state, 'high_burn');
  assert.equal(highBurn.pace.label, 'High burn · 1.4×');

  // 6. Full (100%) and Depleted (0%)
  const full = quota.computeWeeklyCycleInfo(
    { remainingFraction: 1, resetAtMs: nowMs + WEEK },
    nowMs
  );
  assert.equal(full.pace.label, 'On track · 0.0×');

  const depleted = quota.computeWeeklyCycleInfo(
    { remainingFraction: 0, resetAtMs: nowMs + 24 * HOUR },
    nowMs
  );
  assert.equal(depleted.pace.label, 'Depleted');
});

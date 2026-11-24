'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../src/core/pricing');

test('pricing: resolves priced models including Neon, Orchestrator Carbon/Argon, and unknown unpriced', () => {
  const hydro = pricing.resolveModelIdentity({
    modelDisplayName: 'Gemini 4 Hydrogen (High)',
    responseModel: 'gemini-4-hydrogen'
  });
  assert.equal(hydro.modelKey, 'gemini-4-hydrogen');
  assert.equal(hydro.displayName, 'Gemini 4 Hydrogen');
  assert.equal(hydro.effort, 'High');
  assert.equal(hydro.displayNameWithEffort, 'Gemini 4 Hydrogen (High)');
  assert.equal(hydro.isPriced, true);

  // Orchestrator (Carbon) has responseModel='gemini-pro-orchestrator' in real DBs
  const orchCarbon = pricing.resolveModelIdentity({
    modelDisplayName: 'Orchestrator (Carbon)',
    responseModel: 'gemini-pro-orchestrator',
    modelNum: 1667
  });
  assert.equal(orchCarbon.modelKey, 'gemini-4-carbon');
  assert.equal(orchCarbon.pricingKey, 'gemini-4-carbon');
  assert.equal(orchCarbon.isPriced, true);

  const orchArgon = pricing.resolveModelIdentity({
    modelDisplayName: 'Orchestrator (Argon)',
    responseModel: 'gemini-pro-orchestrator'
  });
  assert.equal(orchArgon.modelKey, 'gemini-4-argon');
  assert.equal(orchArgon.isPriced, true);

  // Unknown bare orchestrator without hint stays unpriced
  const orchBare = pricing.resolveModelIdentity({
    responseModel: 'gemini-pro-orchestrator'
  });
  assert.equal(orchBare.isPriced, false);
  assert.equal(orchBare.pricingKey, null);

  // Gemini 4 Neon is priced at official Gemini API Standard rates ($3 / $15 / $0.15)
  const neon = pricing.resolveModelIdentity({
    modelDisplayName: 'Gemini 4 Neon (XHigh)',
    responseModel: 'gemini-4-neon',
    modelNum: 1535
  });
  assert.equal(neon.modelKey, 'gemini-4-neon');
  assert.equal(neon.displayName, 'Gemini 4 Neon');
  assert.equal(neon.effort, 'XHigh');
  assert.equal(neon.displayNameWithEffort, 'Gemini 4 Neon (XHigh)');
  assert.equal(neon.isPriced, true);
  assert.equal(neon.pricingKey, 'gemini-4-neon');

  const noEffort = pricing.resolveModelIdentity({ responseModel: 'gemini-4-neon' });
  assert.equal(noEffort.effort, null);
  assert.equal(noEffort.displayNameWithEffort, 'Gemini 4 Neon');

  const customUnknown = pricing.resolveModelIdentity({
    modelDisplayName: 'Custom Unknown Model (High)'
  });
  assert.equal(customUnknown.isPriced, false);
  assert.equal(customUnknown.pricingKey, null);
});

test('pricing: calculates USD accurately across date transitions, Neon, and prompt tiers', () => {
  const usage = { inputTokens: 100000, cacheReadTokens: 1000000, outputTokens: 50000 };

  const carbonNov = pricing.calculateCallCost(usage, 'Gemini 4 Carbon (Medium)', { dateKey: '2026-11-24' });
  assert.equal(carbonNov.priced, true);
  // 0.1*2.0 + 1.0*0.10 + 0.05*10.0 = 0.2 + 0.1 + 0.5 = 0.8
  assert.ok(Math.abs(carbonNov.costUsd - 0.8) < 1e-9);

  const carbonDec = pricing.calculateCallCost(usage, 'Gemini 4 Carbon (Medium)', { dateKey: '2026-12-01' });
  // 0.1*4.0 + 1.0*0.20 + 0.05*20.0 = 0.4 + 0.2 + 1.0 = 1.6
  assert.ok(Math.abs(carbonDec.costUsd - 1.6) < 1e-9);

  const proUnder = pricing.calculateCallCost(
    { inputTokens: 150000, cacheReadTokens: 0, outputTokens: 10000 },
    'gemini-3.1-pro-preview'
  );
  // 0.15*2.0 + 0.01*12.0 = 0.42
  assert.ok(Math.abs(proUnder.costUsd - 0.42) < 1e-9);

  const proOver = pricing.calculateCallCost(
    { inputTokens: 250000, cacheReadTokens: 0, outputTokens: 10000 },
    'gemini-3.1-pro-preview'
  );
  // 0.25*4.0 + 0.01*18.0 = 1.18
  assert.ok(Math.abs(proOver.costUsd - 1.18) < 1e-9);

  const neonCost = pricing.calculateCallCost(usage, 'Gemini 4 Neon (High)');
  assert.equal(neonCost.priced, true);
  // 0.1*3.0 + 1.0*0.15 + 0.05*15.0 = 0.3 + 0.15 + 0.75 = 1.20
  assert.ok(Math.abs(neonCost.costUsd - 1.2) < 1e-9);

  const unknownCost = pricing.calculateCallCost(usage, 'Custom Unknown Model (High)');
  assert.equal(unknownCost.priced, false);
  assert.equal(unknownCost.costUsd, null);
  assert.equal(unknownCost.label, 'Unpriced');
});

test('pricing: calculateSessionCost enforces single primary model per session', () => {
  const calls = [
    { inputTokens: 100000, cacheReadTokens: 0, outputTokens: 10000, dateKey: '2026-11-24' },
    { inputTokens: 100000, cacheReadTokens: 0, outputTokens: 10000, dateKey: '2026-11-24' }
  ];

  // Primary model is unknown -> entire session is Unpriced even if later calls switched
  const unknownSess = pricing.calculateSessionCost(calls, 'Custom Unknown Model (High)');
  assert.equal(unknownSess.priced, false);
  assert.equal(unknownSess.costUsd, null);

  // Primary model is Neon -> 2 * (0.1*3.0 + 0.01*15.0) = 0.90
  const neonSess = pricing.calculateSessionCost(calls, 'Gemini 4 Neon (High)');
  assert.equal(neonSess.priced, true);
  assert.ok(Math.abs(neonSess.costUsd - 0.9) < 1e-9);

  // Primary model is Carbon (Nov rate) -> 2 * (0.1*2.0 + 0.01*10.0) = 0.6
  const carbonSess = pricing.calculateSessionCost(calls, 'Gemini 4 Carbon (Medium)');
  assert.equal(carbonSess.priced, true);
  assert.ok(Math.abs(carbonSess.costUsd - 0.6) < 1e-9);
});

test('pricing: setDynamicPricing overrides existing rates, adds new models, and rejects malformed rules', () => {
  try {
    const count = pricing.setDynamicPricing({
      'gemini-4-neon': {
        displayName: 'Gemini 4 Neon',
        rules: [{ inputPerMillion: 3.5, outputPerMillion: 17.5, cacheReadPerMillion: 0.2 }]
      },
      'claude-fable-5-2': {
        displayName: 'Claude Fable 5.2',
        rules: [{ inputPerMillion: 8, outputPerMillion: 40, cacheReadPerMillion: 0.2 }]
      },
      'bad-model': {
        displayName: 'Bad',
        rules: [{ inputPerMillion: -1, outputPerMillion: 10, cacheReadPerMillion: 0 }]
      },
      'bad-cache': {
        displayName: 'Bad Cache',
        rules: [{ inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 5 }]
      }
    });
    assert.equal(count, 2);

    const neonOver = pricing.calculateCallCost(
      { inputTokens: 1000000, cacheReadTokens: 0, outputTokens: 0 },
      'Gemini 4 Neon (High)'
    );
    assert.ok(Math.abs(neonOver.costUsd - 3.5) < 1e-9);

    const fable = pricing.resolveModelIdentity('Claude Fable 5.2 (High)');
    assert.equal(fable.modelKey, 'claude-fable-5-2');
    assert.equal(fable.isPriced, true);
    const fableCost = pricing.calculateCallCost(
      { inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 1000000 },
      'Claude Fable 5.2 (High)'
    );
    assert.ok(Math.abs(fableCost.costUsd - 48.2) < 1e-9);

    const bad = pricing.resolveModelIdentity('bad-model');
    assert.equal(bad.isPriced, false);
  } finally {
    pricing.clearDynamicPricing();
  }
});

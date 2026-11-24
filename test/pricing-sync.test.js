'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pricingSync = require('../src/core/pricing-sync');

const SAMPLE_GEMINI_MD = `
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
  * $3.00

  ---

  * Output price (including thinking tokens)
  * Not available
  * $15.00

  ---

  * Context caching price
  * Not available
  * $0.15
  Implicit caching only (explicit caching is not supported).
  {% /table %}
  {% /tab %}
{% /tabs %}

## Gemini 4 Carbon  {% id="gemini-4-carbon" %}
{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Not available
  * $2.00 through November 30, 2026.
  $4.00 starting December 1, 2026.

  ---

  * Output price (including thinking tokens)
  * Not available
  * $10.00 through November 30, 2026.
  $20.00 starting December 1, 2026.

  ---

  * Context caching price
  * Not available
  * $0.10 through November 30, 2026.
  $0.20 starting December 1, 2026.
  $4.50 / 1,000,000 tokens per hour (storage price)
  {% /table %}
  {% /tab %}
{% /tabs %}

## Gemini 3.1 Pro Preview  {% id="gemini-3.1-pro-preview" %}
{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Not available
  * $2.00, prompts <= 200k tokens
  $4.00, prompts > 200k tokens

  ---

  * Output price (including thinking tokens)
  * Not available
  * $12.00, prompts <= 200k tokens
  $18.00, prompts > 200k

  ---

  * Context caching price
  * Not available
  * $0.20, prompts <= 200k tokens
  $0.40, prompts > 200k
  $4.50 / 1,000,000 tokens per hour (storage price)
  {% /table %}
  {% /tab %}
{% /tabs %}

## Gemini 2.5 Pro Preview TTS  {% id="gemini-2.5-pro-preview-tts" %}
{% tabs %}
  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD
  ---
  * Input price
  * Not available
  * $1.00
  ---
  * Output price
  * Not available
  * $20.00
  {% /table %}
  {% /tab %}
{% /tabs %}
`;

const SAMPLE_CLAUDE_MD = `
## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---- | :---- | :---- | :---- | :---- |
| Claude Mythos 5.2 ([limited availability](https://support.claude.com/en/articles/14604842)) | $8 / MTok | $10 / MTok | $16 / MTok | $0.20 / MTok<sup>1</sup> | $40 / MTok |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok<sup>2</sup> | $10 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |

## Next section
`;

test('pricing-sync: parses Gemini Markdown Standard tables with flat, date-transition, and prompt-tier rules', () => {
  const parsed = pricingSync.parseGeminiPricingMarkdown(SAMPLE_GEMINI_MD);
  assert.equal(parsed['gemini-2.5-pro-preview-tts'], undefined);
  assert.deepEqual(parsed['gemini-4-neon'], {
    displayName: 'Gemini 4 Neon',
    rules: [{ inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.15 }]
  });
  assert.deepEqual(parsed['gemini-4-carbon'], {
    displayName: 'Gemini 4 Carbon',
    rules: [
      { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.1, effectiveTo: '2026-11-30' },
      { inputPerMillion: 4, outputPerMillion: 20, cacheReadPerMillion: 0.2, effectiveFrom: '2026-12-01' }
    ]
  });
  assert.deepEqual(parsed['gemini-3.1-pro-preview'], {
    displayName: 'Gemini 3.1 Pro',
    rules: [
      { inputPerMillion: 2, outputPerMillion: 12, cacheReadPerMillion: 0.2, maxPromptTokens: 200000 },
      { inputPerMillion: 4, outputPerMillion: 18, cacheReadPerMillion: 0.4, minPromptTokens: 200001 }
    ]
  });
});

test('pricing-sync: parses Claude Markdown table with footnotes, links, and prompt thresholds', () => {
  const parsed = pricingSync.parseClaudePricingMarkdown(SAMPLE_CLAUDE_MD);
  assert.deepEqual(parsed['claude-mythos-5-2'], {
    displayName: 'Claude Mythos 5.2',
    rules: [{ inputPerMillion: 8, outputPerMillion: 40, cacheReadPerMillion: 0.2 }]
  });
  assert.deepEqual(parsed['claude-opus-5-5'], {
    displayName: 'Claude Opus 5.5',
    rules: [{ inputPerMillion: 4, outputPerMillion: 20, cacheReadPerMillion: 0.2 }]
  });
  assert.deepEqual(parsed['claude-sonnet-5-5'], {
    displayName: 'Claude Sonnet 5.5',
    rules: [{ inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.1 }]
  });
  assert.deepEqual(parsed['claude-haiku-5-5'], {
    displayName: 'Claude Haiku 5.5',
    rules: [
      { inputPerMillion: 0.1, outputPerMillion: 0.5, cacheReadPerMillion: 0.01, maxPromptTokens: 100000 },
      { inputPerMillion: 0.5, outputPerMillion: 2.5, cacheReadPerMillion: 0.05, minPromptTokens: 100001 }
    ]
  });
});

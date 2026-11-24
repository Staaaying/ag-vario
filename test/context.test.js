'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const context = require('../src/core/context');

test('context: computeContextWaterline enforces green/orange/red thresholds', () => {
  assert.equal(context.computeContextWaterline(490000, 1000000).level, 'green');
  assert.equal(context.computeContextWaterline(500000, 1000000).level, 'orange');
  assert.equal(context.computeContextWaterline(794000, 1000000).level, 'orange');
  assert.equal(context.computeContextWaterline(800000, 1000000).level, 'red');
  assert.equal(context.computeContextWaterline(10000, null).level, 'unknown');
});

test('context: classifyPromptSection merges subagents/plugins into system_prompt and uses title fallback', () => {
  assert.equal(context.classifyPromptSection({ tokenType: 1, title: 'identity' }), 'system_prompt');
  assert.equal(context.classifyPromptSection({ tokenType: 6, title: 'subagents' }), 'system_prompt');
  assert.equal(context.classifyPromptSection({ tokenType: 9, title: 'featured_plugins' }), 'system_prompt');
  assert.equal(context.classifyPromptSection({ tokenType: 3, title: 'user_rules' }), 'skills_rules');
  assert.equal(context.classifyPromptSection({ tokenType: 5, title: 'skills' }), 'skills_rules');
  // Legacy sessions mark skills/user_rules as tokenType=1
  assert.equal(context.classifyPromptSection({ tokenType: 1, title: 'skills' }), 'skills_rules');
  assert.equal(context.classifyPromptSection({ tokenType: 1, title: 'user_rules' }), 'skills_rules');
  // RPC JSON string enums
  assert.equal(context.classifyPromptSection({ token_type: 'TOKEN_TYPE_MCP_TOOLS', title: 'mcp' }), 'mcp_tools');
  assert.equal(context.classifyPromptSection({ token_type: 'TOKEN_TYPE_SUBAGENTS', title: 'subagents' }), 'system_prompt');
});

test('context: computeContextBreakdown handles msgNumTokens > exactPromptTokens without negatives', () => {
  const res = context.computeContextBreakdown(
    {
      usage: { inputTokens: 10000, cacheReadTokens: 200000 }, // exact = 210,000
      promptSections: [
        { title: 'identity', content: 'A'.repeat(4000), tokenType: 1 },
        { title: 'skills', content: 'B'.repeat(4000), tokenType: 5 },
        { title: 'subagents', content: 'C'.repeat(4000), tokenType: 6 }
      ],
      tools: [
        { name: 'read_file', description: 'D'.repeat(2000), jsonSchemaString: '{}', serverName: '' },
        { name: 'mcp_query', description: 'E'.repeat(2000), jsonSchemaString: '{}', serverName: 'zotero' }
      ],
      messagePrompts: [
        { numTokens: 240000 } // deliberately exceeds exactPromptTokens!
      ]
    },
    { contextLimit: 1000000 }
  );

  assert.equal(res.isEstimated, true);
  assert.equal(res.breakdownAvailable, true);
  assert.equal(res.exactPromptTokens, 210000);
  assert.equal(res.waterline.percent, 21);
  assert.equal(res.waterline.level, 'green');

  const sumTokens = res.categories.reduce((s, c) => s + c.tokens, 0);
  assert.equal(sumTokens, 210000);
  for (const cat of res.categories) {
    assert.ok(cat.tokens >= 0, `${cat.key} should be non-negative`);
  }
  const mcp = res.categories.find((c) => c.key === 'mcp_tools');
  assert.ok(mcp.tokens > 0);
});

test('context: computeContextBreakdown marks unavailable when payload missing', () => {
  const res = context.computeContextBreakdown({ usage: { inputTokens: 5000, cacheReadTokens: 10000 } });
  assert.equal(res.breakdownAvailable, false);
  assert.equal(res.categories[0].tokens, null);
});

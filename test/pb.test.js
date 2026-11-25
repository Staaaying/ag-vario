'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pb = require('../src/core/pb');

function encodeVarint(value) {
  let v = BigInt(value);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeFieldVarint(fieldNum, value) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 0), encodeVarint(value)]);
}

function encodeFieldBytes(fieldNum, bufOrStr) {
  const payload = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr), 'utf8');
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(payload.length), payload]);
}

function encodePackedVarints(fieldNum, values) {
  const inner = Buffer.concat(values.map((v) => encodeVarint(v)));
  return encodeFieldBytes(fieldNum, inner);
}

test('pb: decodeFields, packed varints, Timestamp, and Duration', () => {
  const tsBuf = Buffer.concat([encodeFieldVarint(1, 1795508720), encodeFieldVarint(2, 500000000)]);
  assert.equal(pb.decodeTimestampMs(tsBuf), 1795508720500);

  const durBuf = Buffer.concat([encodeFieldVarint(1, 5), encodeFieldVarint(2, 72000000)]);
  assert.equal(pb.decodeDurationMs(durBuf), 5072);

  const packed = encodePackedVarints(2, [1, 3, 15, 132]);
  const fields = pb.decodeFields(packed);
  assert.equal(fields.length, 1);
  assert.deepEqual(pb.decodePackedVarints(fields[0].value), [1, 3, 15, 132]);

  assert.throws(() => pb.decodeFields(Buffer.from([0x08])), /Truncated varint/);
  assert.throws(() => pb.decodeFields(Buffer.from([0x0b])), /Unsupported wire type/);
});

test('pb: parseRawSummary handles main, subagent, and workflow records', () => {
  const subagentSpec = Buffer.concat([
    encodeFieldBytes(1, 'self'),
    encodeFieldBytes(2, 'Zotero Library and PDF Verifier'),
    encodeFieldVarint(7, 1437)
  ]);
  const inner17 = Buffer.concat([
    encodeFieldBytes(5, 'parent-uuid'),
    encodeFieldBytes(6, 'root-uuid'),
    encodeFieldBytes(7, 'file:///workspace'),
    encodeFieldBytes(8, subagentSpec),
    encodeFieldBytes(18, 'project-uuid')
  ]);
  const rawSummary = Buffer.concat([
    encodeFieldBytes(1, 'Summary Title'),
    encodeFieldVarint(2, 42),
    encodeFieldBytes(17, inner17)
  ]);

  const parsed = pb.parseRawSummary(rawSummary);
  assert.equal(parsed.rawTitle, 'Summary Title');
  assert.equal(parsed.stepCount, 42);
  assert.equal(parsed.parentConversationId, 'parent-uuid');
  assert.equal(parsed.rootConversationId, 'root-uuid');
  assert.equal(parsed.workspaceUri, 'file:///workspace');
  assert.equal(parsed.projectId, 'project-uuid');
  assert.deepEqual(parsed.subagentSpec, {
    typeName: 'self',
    role: 'Zotero Library and PDF Verifier',
    modelEnum: 1437
  });
});

test('pb: parseStepMetadata and parseGenMetadata fast vs context mode', () => {
  const stepMeta = Buffer.concat([
    encodeFieldBytes(1, Buffer.concat([encodeFieldVarint(1, 1795508720), encodeFieldVarint(2, 0)])),
    encodeFieldVarint(11, 1532),
    encodeFieldBytes(12, 'exec-1')
  ]);
  const parsedStep = pb.parseStepMetadata(stepMeta);
  assert.equal(parsedStep.createdAtMs, 1795508720000);
  assert.equal(parsedStep.modelEnum, 1532);
  assert.equal(parsedStep.executionId, 'exec-1');

  const usageBuf = Buffer.concat([
    encodeFieldVarint(2, 1200),
    encodeFieldVarint(3, 350),
    encodeFieldVarint(5, 8000),
    encodeFieldVarint(9, 200),
    encodeFieldVarint(10, 150)
  ]);
  const sectionBuf = Buffer.concat([
    encodeFieldBytes(1, 'identity'),
    encodeFieldBytes(2, 'You are an assistant.'),
    encodeFieldVarint(6, 1)
  ]);
  const toolBuf = Buffer.concat([
    encodeFieldBytes(1, 'read_file'),
    encodeFieldBytes(2, 'Reads a file'),
    encodeFieldBytes(3, '{}'),
    encodeFieldBytes(6, '')
  ]);
  const msgBuf = Buffer.concat([
    encodeFieldVarint(2, 1),
    encodeFieldBytes(3, 'hello'),
    encodeFieldVarint(4, 24)
  ]);
  const mapEntry = Buffer.concat([
    encodeFieldBytes(1, 'model_enum'),
    encodeFieldBytes(2, 'MODEL_PLACEHOLDER_M525')
  ]);
  const ctxWinMeta = Buffer.concat([
    encodeFieldVarint(1, 386379),
    encodeFieldVarint(2, 2),
    encodeFieldVarint(4, 512000)
  ]);
  const chatStartMeta = Buffer.concat([
    encodeFieldVarint(1, 44),
    encodeFieldVarint(2, 1),
    encodeFieldBytes(10, ctxWinMeta)
  ]);
  const cmBuf = Buffer.concat([
    encodeFieldVarint(3, 1525),
    encodeFieldBytes(4, usageBuf),
    encodeFieldBytes(9, chatStartMeta),
    encodeFieldBytes(11, Buffer.concat([encodeFieldVarint(1, 2), encodeFieldVarint(2, 500000000)])),
    encodeFieldBytes(12, Buffer.concat([encodeFieldVarint(1, 4), encodeFieldVarint(2, 0)])),
    encodeFieldBytes(19, 'gemini-4-hydrogen'),
    encodeFieldBytes(20, mapEntry),
    encodeFieldBytes(21, 'Gemini 4 Hydrogen (High)'),
    encodeFieldBytes(16, sectionBuf),
    encodeFieldBytes(8, toolBuf),
    encodeFieldBytes(2, msgBuf)
  ]);
  const gmBuf = Buffer.concat([
    encodeFieldBytes(1, cmBuf),
    encodePackedVarints(2, [1, 2]),
    encodeFieldBytes(4, 'exec-1')
  ]);

  const fast = pb.parseGenMetadata(gmBuf, { includeContext: false });
  assert.deepEqual(fast.stepIndices, [1, 2]);
  assert.equal(fast.chatModel.modelNum, 1525);
  assert.equal(fast.chatModel.modelEnum, 'MODEL_PLACEHOLDER_M525');
  assert.equal(fast.chatModel.usage.inputTokens, 1200);
  assert.equal(fast.chatModel.usage.cacheReadTokens, 8000);
  assert.equal(fast.chatModel.ttftMs, 2500);
  assert.equal(fast.chatModel.streamingMs, 4000);
  assert.equal(fast.chatModel.maxContextTokens, 512000);
  assert.equal(fast.chatModel.estimatedTokensUsed, 386379);
  assert.equal(fast.chatModel.startStepIndex, 44);
  assert.equal(fast.chatModel.checkpointIndex, 1);
  assert.equal(fast.chatModel.truncationReason, 'TRUNCATION_REASON_MAX_TOKEN_LIMIT');
  assert.equal(fast.chatModel.hasContextPayload, true);
  assert.equal(fast.chatModel.promptSections, undefined);

  const full = pb.parseGenMetadata(gmBuf, { includeContext: true });
  assert.equal(full.chatModel.promptSections.length, 1);
  assert.equal(full.chatModel.promptSections[0].title, 'identity');
  assert.equal(full.chatModel.tools.length, 1);
  assert.equal(full.chatModel.tools[0].name, 'read_file');
  assert.equal(full.chatModel.messagePrompts.length, 1);
  assert.equal(full.chatModel.messagePrompts[0].numTokens, 24);
});

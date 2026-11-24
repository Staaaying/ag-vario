'use strict';

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

function toUint8Array(input) {
  if (!input) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('Expected Uint8Array, Buffer, or ArrayBuffer');
}

function readVarint(buf, state) {
  let result = 0n;
  let shift = 0n;
  while (state.pos < buf.length) {
    const b = buf[state.pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return result;
    shift += 7n;
    if (shift > 70n) throw new RangeError('Varint exceeds 10 bytes');
  }
  throw new RangeError('Truncated varint');
}

/**
 * Decode top-level wire fields from a Protobuf buffer.
 * Wire type 0 -> BigInt varint, 1/2/5 -> Uint8Array subarray.
 */
function decodeFields(input) {
  const buf = toUint8Array(input);
  const fields = [];
  const state = { pos: 0 };
  while (state.pos < buf.length) {
    const tag = Number(readVarint(buf, state));
    const field = tag >>> 3;
    const wire = tag & 0x07;
    if (field === 0) throw new RangeError('Invalid field number 0');
    if (wire === 0) {
      fields.push({ field, wire, value: readVarint(buf, state) });
    } else if (wire === 1) {
      if (state.pos + 8 > buf.length) throw new RangeError('Truncated 64-bit field');
      fields.push({ field, wire, value: buf.subarray(state.pos, state.pos + 8) });
      state.pos += 8;
    } else if (wire === 2) {
      const len = Number(readVarint(buf, state));
      if (len < 0 || state.pos + len > buf.length) throw new RangeError('Truncated length-delimited field');
      fields.push({ field, wire, value: buf.subarray(state.pos, state.pos + len) });
      state.pos += len;
    } else if (wire === 5) {
      if (state.pos + 4 > buf.length) throw new RangeError('Truncated 32-bit field');
      fields.push({ field, wire, value: buf.subarray(state.pos, state.pos + 4) });
      state.pos += 4;
    } else {
      throw new RangeError(`Unsupported wire type ${wire}`);
    }
  }
  return fields;
}

function decodePackedVarints(input) {
  const buf = toUint8Array(input);
  const out = [];
  const state = { pos: 0 };
  while (state.pos < buf.length) {
    out.push(Number(readVarint(buf, state)));
  }
  return out;
}

function decodeString(buf) {
  return buf && buf.length ? TEXT_DECODER.decode(buf) : '';
}

function decodeSecondsNanos(input) {
  const buf = toUint8Array(input);
  if (!buf.length) return null;
  let seconds = 0;
  let nanos = 0;
  let hasField = false;
  for (const f of decodeFields(buf)) {
    if (f.field === 1 && f.wire === 0) {
      seconds = Number(BigInt.asIntN(64, f.value));
      hasField = true;
    } else if (f.field === 2 && f.wire === 0) {
      nanos = Number(BigInt.asIntN(32, f.value));
      hasField = true;
    }
  }
  if (!hasField) return null;
  return seconds * 1000 + nanos / 1e6;
}

function decodeTimestampMs(input) {
  const ms = decodeSecondsNanos(input);
  return ms !== null && ms > 0 ? ms : null;
}

function decodeDurationMs(input) {
  const ms = decodeSecondsNanos(input);
  return ms !== null && ms >= 0 ? ms : null;
}

function parseRawSummary(input) {
  const buf = toUint8Array(input);
  const result = {
    rawTitle: '',
    stepCount: 0,
    parentConversationId: '',
    rootConversationId: '',
    workspaceUri: '',
    projectId: '',
    subagentSpec: null
  };
  if (!buf.length) return result;

  for (const f of decodeFields(buf)) {
    if (f.field === 1 && f.wire === 2) {
      result.rawTitle = decodeString(f.value);
    } else if (f.field === 2 && f.wire === 0) {
      result.stepCount = Number(f.value);
    } else if (f.field === 17 && f.wire === 2) {
      for (const sf of decodeFields(f.value)) {
        if (sf.field === 5 && sf.wire === 2) {
          result.parentConversationId = decodeString(sf.value);
        } else if (sf.field === 6 && sf.wire === 2) {
          result.rootConversationId = decodeString(sf.value);
        } else if (sf.field === 7 && sf.wire === 2 && !result.workspaceUri) {
          result.workspaceUri = decodeString(sf.value);
        } else if (sf.field === 18 && sf.wire === 2) {
          result.projectId = decodeString(sf.value);
        } else if (sf.field === 8 && sf.wire === 2) {
          const spec = { typeName: '', role: '', modelEnum: 0 };
          for (const ssf of decodeFields(sf.value)) {
            if (ssf.field === 1 && ssf.wire === 2) spec.typeName = decodeString(ssf.value);
            else if (ssf.field === 2 && ssf.wire === 2) spec.role = decodeString(ssf.value);
            else if (ssf.field === 7 && ssf.wire === 0) spec.modelEnum = Number(ssf.value);
          }
          result.subagentSpec = spec;
        }
      }
    }
  }
  return result;
}

function parseStepMetadata(input) {
  const buf = toUint8Array(input);
  const result = {
    createdAtMs: null,
    viewableAtMs: null,
    finishedAtMs: null,
    modelEnum: null,
    executionId: ''
  };
  if (!buf.length) return result;

  for (const f of decodeFields(buf)) {
    if (f.field === 1 && f.wire === 2) result.createdAtMs = decodeTimestampMs(f.value);
    else if (f.field === 6 && f.wire === 2) result.viewableAtMs = decodeTimestampMs(f.value);
    else if (f.field === 7 && f.wire === 2) result.finishedAtMs = decodeTimestampMs(f.value);
    else if (f.field === 11 && f.wire === 0) result.modelEnum = Number(f.value);
    else if (f.field === 12 && f.wire === 2) result.executionId = decodeString(f.value);
  }
  return result;
}

function parseUsageStats(buf) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    thinkingOutputTokens: 0,
    responseOutputTokens: 0,
    responseId: ''
  };
  for (const uf of decodeFields(buf)) {
    if (uf.field === 2 && uf.wire === 0) usage.inputTokens = Number(uf.value);
    else if (uf.field === 3 && uf.wire === 0) usage.outputTokens = Number(uf.value);
    else if (uf.field === 4 && uf.wire === 0) usage.cacheWriteTokens = Number(uf.value);
    else if (uf.field === 5 && uf.wire === 0) usage.cacheReadTokens = Number(uf.value);
    else if (uf.field === 9 && uf.wire === 0) usage.thinkingOutputTokens = Number(uf.value);
    else if (uf.field === 10 && uf.wire === 0) usage.responseOutputTokens = Number(uf.value);
    else if (uf.field === 11 && uf.wire === 2) usage.responseId = decodeString(uf.value);
  }
  return usage;
}

function parsePromptSection(buf) {
  const section = { title: '', content: '', tokenType: 0, tokenSource: '' };
  for (const sf of decodeFields(buf)) {
    if (sf.field === 1 && sf.wire === 2) section.title = decodeString(sf.value);
    else if (sf.field === 2 && sf.wire === 2) section.content = decodeString(sf.value);
    else if (sf.field === 6 && sf.wire === 0) section.tokenType = Number(sf.value);
    else if (sf.field === 7 && sf.wire === 2) section.tokenSource = decodeString(sf.value);
  }
  return section;
}

function parseChatToolDefinition(buf) {
  const tool = {
    name: '',
    description: '',
    jsonSchemaString: '',
    serverName: '',
    originalName: ''
  };
  for (const tf of decodeFields(buf)) {
    if (tf.field === 1 && tf.wire === 2) tool.name = decodeString(tf.value);
    else if (tf.field === 2 && tf.wire === 2) tool.description = decodeString(tf.value);
    else if (tf.field === 3 && tf.wire === 2) tool.jsonSchemaString = decodeString(tf.value);
    else if (tf.field === 6 && tf.wire === 2) tool.serverName = decodeString(tf.value);
    else if (tf.field === 7 && tf.wire === 2) tool.originalName = decodeString(tf.value);
  }
  return tool;
}

function parseChatMessagePrompt(buf) {
  const msg = { source: 0, prompt: '', numTokens: 0 };
  for (const mf of decodeFields(buf)) {
    if (mf.field === 2 && mf.wire === 0) msg.source = Number(BigInt.asIntN(32, mf.value));
    else if (mf.field === 3 && mf.wire === 2) msg.prompt = decodeString(mf.value);
    else if (mf.field === 4 && mf.wire === 0) msg.numTokens = Number(mf.value);
  }
  return msg;
}

function parseChatModelMetadata(buf, includeContext) {
  const cm = {
    modelNum: null,
    modelEnum: '',
    responseModel: '',
    modelDisplayName: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      thinkingOutputTokens: 0,
      responseOutputTokens: 0,
      responseId: ''
    },
    ttftMs: null,
    streamingMs: null,
    maxContextTokens: null,
    estimatedTokensUsed: null,
    hasContextPayload: false
  };
  if (includeContext) {
    cm.promptSections = [];
    cm.tools = [];
    cm.messagePrompts = [];
  }

  for (const cf of decodeFields(buf)) {
    if (cf.field === 3 && cf.wire === 0) {
      cm.modelNum = Number(cf.value);
    } else if (cf.field === 4 && cf.wire === 2) {
      cm.usage = parseUsageStats(cf.value);
    } else if (cf.field === 9 && cf.wire === 2) {
      for (const sf of decodeFields(cf.value)) {
        if (sf.field === 10 && sf.wire === 2) {
          for (const cwf of decodeFields(sf.value)) {
            if (cwf.field === 1 && cwf.wire === 0) {
              const est = Number(cwf.value);
              if (Number.isFinite(est) && est >= 0) cm.estimatedTokensUsed = est;
            } else if (cwf.field === 4 && cwf.wire === 0) {
              const maxCtx = Number(cwf.value);
              if (Number.isFinite(maxCtx) && maxCtx > 0) cm.maxContextTokens = maxCtx;
            }
          }
        }
      }
    } else if (cf.field === 11 && cf.wire === 2) {
      cm.ttftMs = decodeDurationMs(cf.value);
    } else if (cf.field === 12 && cf.wire === 2) {
      cm.streamingMs = decodeDurationMs(cf.value);
    } else if (cf.field === 19 && cf.wire === 2) {
      cm.responseModel = decodeString(cf.value);
    } else if (cf.field === 21 && cf.wire === 2) {
      cm.modelDisplayName = decodeString(cf.value);
    } else if (cf.field === 20 && cf.wire === 2) {
      let key = '';
      let value = '';
      for (const mf of decodeFields(cf.value)) {
        if (mf.field === 1 && mf.wire === 2) key = decodeString(mf.value);
        else if (mf.field === 2 && mf.wire === 2) value = decodeString(mf.value);
      }
      if (key === 'model_enum' && value) cm.modelEnum = value;
    } else if (cf.field === 16 && cf.wire === 2) {
      cm.hasContextPayload = true;
      if (includeContext) cm.promptSections.push(parsePromptSection(cf.value));
    } else if (cf.field === 8 && cf.wire === 2) {
      cm.hasContextPayload = true;
      if (includeContext) cm.tools.push(parseChatToolDefinition(cf.value));
    } else if (cf.field === 2 && cf.wire === 2) {
      cm.hasContextPayload = true;
      if (includeContext) cm.messagePrompts.push(parseChatMessagePrompt(cf.value));
    }
  }
  return cm;
}

/**
 * Parse CortexStepGeneratorMetadata blob from gen_metadata.data.
 * Defaults to skipping heavy context payloads unless includeContext is true.
 */
function parseGenMetadata(input, options = {}) {
  const buf = toUint8Array(input);
  const includeContext = Boolean(options && options.includeContext);
  const result = {
    stepIndices: [],
    executionId: '',
    chatModel: null
  };
  if (!buf.length) return result;

  for (const tf of decodeFields(buf)) {
    if (tf.field === 2 && tf.wire === 2) {
      result.stepIndices.push(...decodePackedVarints(tf.value));
    } else if (tf.field === 2 && tf.wire === 0) {
      result.stepIndices.push(Number(tf.value));
    } else if (tf.field === 4 && tf.wire === 2) {
      result.executionId = decodeString(tf.value);
    } else if (tf.field === 1 && tf.wire === 2) {
      result.chatModel = parseChatModelMetadata(tf.value, includeContext);
    }
  }
  return result;
}

module.exports = {
  decodeFields,
  decodePackedVarints,
  decodeTimestampMs,
  decodeDurationMs,
  parseRawSummary,
  parseStepMetadata,
  parseGenMetadata
};

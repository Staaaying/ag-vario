'use strict';

const { validatePricingRules } = require('./pricing');

const OFFICIAL_PRICING_URLS = {
  gemini: 'https://ai.google.dev/gemini-api/docs/pricing.md.txt',
  claude: 'https://platform.claude.com/docs/en/about-claude/pricing.md'
};

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};

function parseMonthDayYear(str) {
  const m = String(str || '').trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!month || !Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(year)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseGeminiPriceCell(cellText, { isCacheRow = false } = {}) {
  const lines = String(cellText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const items = [];
  for (const line of lines) {
    if (isCacheRow && /(?:storage\s*price|implicit\s+caching)/i.test(line)) continue;
    if (/^(?:not available|free\b)/i.test(line)) continue;

    const throughMatch = line.match(/\$(\d+(?:\.\d+)?)\s+through\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
    if (throughMatch) {
      const effectiveTo = parseMonthDayYear(throughMatch[2]);
      if (effectiveTo) {
        items.push({ price: Number(throughMatch[1]), tierKey: `to:${effectiveTo}`, effectiveTo });
        continue;
      }
    }

    const startMatch = line.match(/\$(\d+(?:\.\d+)?)\s+starting\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
    if (startMatch) {
      const effectiveFrom = parseMonthDayYear(startMatch[2]);
      if (effectiveFrom) {
        items.push({ price: Number(startMatch[1]), tierKey: `from:${effectiveFrom}`, effectiveFrom });
        continue;
      }
    }

    const leMatch = line.match(/\$(\d+(?:\.\d+)?).*?prompts?\s*<=\s*(\d+(?:\.\d+)?)\s*k/i);
    if (leMatch) {
      const maxPromptTokens = Math.round(Number(leMatch[2]) * 1000);
      items.push({ price: Number(leMatch[1]), tierKey: `max:${maxPromptTokens}`, maxPromptTokens });
      continue;
    }

    const gtMatch = line.match(/\$(\d+(?:\.\d+)?).*?prompts?\s*>\s*(\d+(?:\.\d+)?)\s*k/i);
    if (gtMatch) {
      const minPromptTokens = Math.round(Number(gtMatch[2]) * 1000) + 1;
      items.push({ price: Number(gtMatch[1]), tierKey: `min:${minPromptTokens}`, minPromptTokens });
      continue;
    }

    const flatMatch = line.match(/\$(\d+(?:\.\d+)?)/);
    if (flatMatch && !items.some((x) => x.tierKey === 'flat')) {
      items.push({ price: Number(flatMatch[1]), tierKey: 'flat' });
    }
  }
  return items;
}

function parseGeminiTableRows(tableBlock) {
  const rowBlocks = String(tableBlock || '').split(/\n\s*---\s*\n/);
  const rows = [];
  for (const rb of rowBlocks) {
    const cells = [];
    let current = null;
    for (const rawLine of rb.split(/\r?\n/)) {
      const cellStart = rawLine.match(/^\s*\*\s+(.*)$/);
      if (cellStart) {
        if (current !== null) cells.push(current.join('\n').trim());
        current = [cellStart[1]];
      } else if (current !== null) {
        current.push(rawLine.trim());
      }
    }
    if (current !== null) cells.push(current.join('\n').trim());
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}

function parseGeminiPricingMarkdown(mdText) {
  if (!mdText || typeof mdText !== 'string') return {};
  const headingRe = /^##\s+(.+?)\s*\{%\s*id="([^"]+)"\s*%\}/gm;
  const headings = [];
  let m;
  while ((m = headingRe.exec(mdText)) !== null) {
    headings.push({
      title: m[1].trim(),
      id: m[2].trim().toLowerCase(),
      start: m.index
    });
  }

  const out = {};
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!h.id.startsWith('gemini-')) continue;
    if (/(?:-tts\b|-image\b|-live\b|-transcribe\b|-embedding\b|-robotics\b|audio-only)/i.test(h.id)) {
      continue;
    }

    const end = i + 1 < headings.length ? headings[i + 1].start : mdText.length;
    const section = mdText.slice(h.start, end);
    const stdTabMatch = section.match(/\{%\s*tab\s+title="Standard"\s*%\}([\s\S]*?)\{%\s*\/tab\s*%\}/i);
    if (!stdTabMatch) continue;
    const tableMatch = stdTabMatch[1].match(/\{%\s*table\s*%\}([\s\S]*?)\{%\s*\/table\s*%\}/i);
    if (!tableMatch) continue;

    const rows = parseGeminiTableRows(tableMatch[1]);
    let inputCell = '';
    let outputCell = '';
    let cacheCell = '';
    for (const cells of rows) {
      const label = cells[0].toLowerCase();
      const paidVal = cells[cells.length - 1];
      if (label.startsWith('input price')) inputCell = paidVal;
      else if (label.startsWith('output price')) outputCell = paidVal;
      else if (label.startsWith('context caching price')) cacheCell = paidVal;
    }
    if (!inputCell || !outputCell) continue;

    const inputItems = parseGeminiPriceCell(inputCell);
    const outputItems = parseGeminiPriceCell(outputCell);
    const cacheItems = parseGeminiPriceCell(cacheCell, { isCacheRow: true });
    if (!inputItems.length || !outputItems.length) continue;

    const rules = [];
    for (const inp of inputItems) {
      const outItem =
        outputItems.find((o) => o.tierKey === inp.tierKey) ||
        (outputItems.length === 1 ? outputItems[0] : null);
      if (!outItem) continue;
      const cacheItem =
        cacheItems.find((c) => c.tierKey === inp.tierKey) ||
        (cacheItems.length === 1 ? cacheItems[0] : null);

      const rule = {
        inputPerMillion: inp.price,
        outputPerMillion: outItem.price,
        cacheReadPerMillion: cacheItem ? cacheItem.price : 0
      };
      if (inp.effectiveTo) rule.effectiveTo = inp.effectiveTo;
      if (inp.effectiveFrom) rule.effectiveFrom = inp.effectiveFrom;
      if (inp.maxPromptTokens !== undefined) rule.maxPromptTokens = inp.maxPromptTokens;
      if (inp.minPromptTokens !== undefined) rule.minPromptTokens = inp.minPromptTokens;
      rules.push(rule);
    }

    const validated = validatePricingRules(rules);
    if (!validated) continue;

    const displayName = h.title.replace(/\s+Preview$/i, '').trim() || h.id;
    out[h.id] = { displayName, rules: validated };
  }
  return out;
}

function parseFirstUsd(cellText) {
  const m = String(cellText || '').match(/\$(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function parseClaudePricingMarkdown(mdText) {
  if (!mdText || typeof mdText !== 'string') return {};
  const startIdx = mdText.search(/^##\s+Model pricing\b/m);
  if (startIdx === -1) return {};
  const nextHeading = mdText.slice(startIdx + 3).search(/\n##\s+/);
  const section = nextHeading === -1 ? mdText.slice(startIdx) : mdText.slice(startIdx, startIdx + 3 + nextHeading);

  const grouped = new Map();
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cols = trimmed
      .slice(1, trimmed.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => c.trim());
    if (cols.length < 6) continue;
    if (/^:?-+/.test(cols[0]) || /^model$/i.test(cols[0])) continue;

    const rawModel = cols[0];
    let maxPromptTokens;
    let minPromptTokens;
    const upToMatch = rawModel.match(/prompts?\s+up\s+to\s+([\d,]+)\s+tokens/i);
    const overMatch = rawModel.match(/prompts?\s+over\s+([\d,]+)\s+tokens/i);
    if (upToMatch) maxPromptTokens = Number(upToMatch[1].replace(/,/g, ''));
    if (overMatch) minPromptTokens = Number(overMatch[1].replace(/,/g, '')) + 1;

    const cleanName = rawModel
      .replace(/<sup>[\s\S]*?<\/sup>/gi, '')
      .replace(/\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleanName || !/claude/i.test(cleanName)) continue;

    const modelKey = cleanName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!modelKey) continue;

    const inputPerMillion = parseFirstUsd(cols[1]);
    const cacheReadPerMillion = parseFirstUsd(cols[4]);
    const outputPerMillion = parseFirstUsd(cols[5]);
    if (inputPerMillion === null || outputPerMillion === null) continue;

    const rule = {
      inputPerMillion,
      outputPerMillion,
      cacheReadPerMillion: cacheReadPerMillion !== null ? cacheReadPerMillion : 0
    };
    if (Number.isFinite(maxPromptTokens)) rule.maxPromptTokens = maxPromptTokens;
    if (Number.isFinite(minPromptTokens)) rule.minPromptTokens = minPromptTokens;

    if (!grouped.has(modelKey)) {
      grouped.set(modelKey, { displayName: cleanName, rules: [] });
    }
    grouped.get(modelKey).rules.push(rule);
  }

  const out = {};
  for (const [key, entry] of grouped.entries()) {
    const validated = validatePricingRules(entry.rules);
    if (validated) out[key] = { displayName: entry.displayName, rules: validated };
  }
  return out;
}

function mergeSyncedPricing(prevByVendor = {}, vendorUpdates = {}) {
  const nextByVendor = {
    gemini: vendorUpdates.gemini && Object.keys(vendorUpdates.gemini).length > 0
      ? vendorUpdates.gemini
      : (prevByVendor.gemini || {}),
    claude: vendorUpdates.claude && Object.keys(vendorUpdates.claude).length > 0
      ? vendorUpdates.claude
      : (prevByVendor.claude || {})
  };
  const models = {
    ...nextByVendor.gemini,
    ...nextByVendor.claude
  };
  return { byVendor: nextByVendor, models };
}

module.exports = {
  OFFICIAL_PRICING_URLS,
  parseMonthDayYear,
  parseGeminiPricingMarkdown,
  parseClaudePricingMarkdown,
  mergeSyncedPricing
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const styles = require('../src/renderer/styles');
const composerBar = require('../src/renderer/composer-bar');
const topbarBar = require('../src/renderer/topbar-bar');
const mount = require('../src/renderer/mount');

// Lightweight synthetic DOM + ShadowRoot test harness (zero external deps)
class FakeClassList {
  constructor(el) {
    this.el = el;
  }
  contains(name) {
    return (this.el.className || '').split(/\s+/).includes(name);
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || 'DIV').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {
      _props: new Map(),
      setProperty: (k, v) => this.style._props.set(k, v),
      removeProperty: (k) => this.style._props.delete(k)
    };
    this.hidden = false;
    this.scrollTop = 0;
    this._popoverOpen = false;
    this.popoverShowCalls = 0;
    this.popoverHideCalls = 0;
    this._innerHTML = '';
    this._textContent = '';
    this._rect = { left: 100, top: 100, right: 200, bottom: 130, width: 420, height: 30 };
    this.classList = new FakeClassList(this);
  }
  get id() { return this.attributes.get('id') || ''; }
  set id(v) { this.attributes.set('id', String(v)); }
  get className() { return this.attributes.get('class') || ''; }
  set className(v) { this.attributes.set('class', String(v)); }
  get isConnected() {
    let cur = this;
    while (cur) {
      if (cur === this.ownerDocument?.body) return true;
      cur = cur.parentElement || cur.host || null;
    }
    return false;
  }
  get nextSibling() {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return idx >= 0 ? this.parentElement.children[idx + 1] || null : null;
  }
  get firstElementChild() { return this.children[0] || null; }
  get firstChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === 'hidden') this.hidden = true;
  }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    if (child.parentElement) child.parentElement.removeChild(child);
    const idx = this.children.indexOf(ref);
    if (idx === -1) return this.appendChild(child);
    child.parentElement = this;
    this.children.splice(idx, 0, child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentElement = null;
      resetDetachedPopovers(child);
    }
    return child;
  }
  showPopover() {
    if (!this.isConnected) throw new Error('InvalidStateError: disconnected popover');
    if (this._popoverOpen) throw new Error('InvalidStateError: already open');
    this._popoverOpen = true;
    this.popoverShowCalls++;
  }
  hidePopover() {
    if (!this._popoverOpen) throw new Error('InvalidStateError: not open');
    this._popoverOpen = false;
    this.popoverHideCalls++;
  }
  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((f) => f !== fn));
  }
  dispatchEvent(evt) {
    const event = {
      target: evt.target || this,
      currentTarget: this,
      key: evt.key,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...evt
    };
    let cur = this;
    while (cur && !event.propagationStopped) {
      for (const fn of cur.listeners.get(evt.type) || []) {
        fn(event);
      }
      cur = cur.parentElement;
    }
    return event;
  }
  getBoundingClientRect() { return this._rect; }
  set innerHTML(html) {
    this._innerHTML = String(html || '');
    this.children = [];
    parseHtmlInto(this, this._innerHTML, this.ownerDocument);
  }
  get innerHTML() { return this._innerHTML; }
  set textContent(v) { this._textContent = String(v ?? ''); }
  get textContent() { return this._textContent || this._innerHTML.replace(/<[^>]+>/g, ''); }
  matches(sel) {
    return sel.split(',').some((part) => matchSingleSelector(this, part.trim()));
  }
  closest(sel) {
    let cur = this;
    while (cur && cur.tagName) {
      if (cur.matches(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children || []) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  attachShadow() {
    const sr = new FakeElement('SHADOW', this.ownerDocument);
    sr.host = this;
    this.shadowRoot = sr;
    return sr;
  }
}

function matchSingleSelector(el, sel) {
  if (!sel || !el.tagName) return false;
  if (sel.includes(' ')) {
    const parts = sel.split(/\s+/);
    const tail = parts[parts.length - 1];
    if (!matchAtom(el, tail)) return false;
    let cur = el.parentElement;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (cur && !matchAtom(cur, parts[i])) cur = cur.parentElement;
      if (!cur) return false;
      cur = cur.parentElement;
    }
    return true;
  }
  return matchAtom(el, sel.replace(/^:scope\s*>\s*/, ''));
}

function resetDetachedPopovers(node) {
  if (!node) return;
  if (node._popoverOpen) node._popoverOpen = false;
  for (const ch of node.children || []) resetDetachedPopovers(ch);
  if (node.shadowRoot) resetDetachedPopovers(node.shadowRoot);
}

function matchAtom(el, atom) {
  if (!atom) return false;
  let rest = atom;
  const tagMatch = rest.match(/^([a-zA-Z0-9_-]+)/);
  if (tagMatch && !atom.startsWith('.') && !atom.startsWith('#') && !atom.startsWith('[') && !atom.startsWith(':')) {
    if (el.tagName !== tagMatch[1].toUpperCase()) return false;
    rest = rest.slice(tagMatch[1].length);
  }
  while (rest.length > 0) {
    if (rest.startsWith(':popover-open')) {
      if (!el._popoverOpen) return false;
      rest = rest.slice(':popover-open'.length);
    } else if (rest.startsWith('.')) {
      const m = rest.match(/^\.([a-zA-Z0-9_-]+)/);
      if (!m || !el.classList.contains(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith('#')) {
      const m = rest.match(/^#([a-zA-Z0-9_-]+)/);
      if (!m || el.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith(':not(')) {
      const end = rest.indexOf(')');
      const inner = rest.slice(5, end);
      if (matchAtom(el, inner)) return false;
      rest = rest.slice(end + 1);
    } else if (rest.startsWith('[')) {
      const end = rest.indexOf(']');
      const expr = rest.slice(1, end);
      const eq = expr.indexOf('=');
      if (eq === -1) {
        if (!el.hasAttribute(expr)) return false;
      } else {
        const k = expr.slice(0, eq).replace(/\*$/, '');
        const v = expr.slice(eq + 1).replace(/^["']|["']$/g, '');
        const actual = el.getAttribute(k) || '';
        if (expr.includes('*=')) {
          if (!actual.includes(v)) return false;
        } else if (actual !== v) {
          return false;
        }
      }
      rest = rest.slice(end + 1);
    } else {
      return false;
    }
  }
  return true;
}

function parseHtmlInto(parent, html, doc) {
  const stack = [parent];
  const tokenRe = /<style>[\s\S]*?<\/style>|<\/([a-zA-Z0-9_-]+)>|<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>/g;
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    if (m[0].startsWith('<style>')) continue;
    if (m[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const tag = m[2];
    const attrsStr = m[3] || '';
    const selfClose = m[4] === '/' || tag === 'img';
    const node = doc.createElement(tag);
    const attrRe = /([a-zA-Z0-9_:-]+)(?:="([^"]*)")?/g;
    let am;
    while ((am = attrRe.exec(attrsStr)) !== null) {
      node.setAttribute(am[1], am[2] !== undefined ? am[2] : '');
    }
    stack[stack.length - 1].appendChild(node);
    if (!selfClose) stack.push(node);
  }
}

function createFakeDom(href = 'https://127.0.0.1:43000/c/11111111-1111-1111-1111-111111111111') {
  const doc = {
    hidden: false,
    listeners: new Map(),
    createElement: (tag) => new FakeElement(tag, doc),
    addEventListener(type, fn) {
      const l = this.listeners.get(type) || [];
      l.push(fn);
      this.listeners.set(type, l);
    },
    removeEventListener(type, fn) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter((f) => f !== fn));
    },
    dispatchEvent(evt) {
      for (const fn of this.listeners.get(evt.type) || []) fn(evt);
    },
    querySelector: (sel) => doc.body.querySelector(sel),
    querySelectorAll: (sel) => doc.body.querySelectorAll(sel)
  };
  doc.body = new FakeElement('BODY', doc);

  // Titlebar with right shrink-0 button cluster
  const titlebar = doc.createElement('div');
  titlebar.className = '@container/titlebar flex items-center';
  const tbTitle = doc.createElement('div');
  const tbRight = doc.createElement('div');
  tbRight.className = 'shrink-0 flex items-center';
  const openIdeBtn = doc.createElement('button');
  openIdeBtn.setAttribute('data-testid', 'open-editor-single');
  tbRight.appendChild(openIdeBtn);
  titlebar.appendChild(tbTitle);
  titlebar.appendChild(tbRight);

  // Composer box with .agy-composer-footer (left cluster + right permission/send cluster)
  const pane = doc.createElement('div');
  pane.setAttribute('data-pane-id', 'pane-1');
  const inputBox = doc.createElement('div');
  inputBox.setAttribute('data-testid', 'agent-input-box');
  inputBox._rect = { left: 20, top: 600, right: 620, bottom: 700, width: 600, height: 100 };
  const composerFooter = doc.createElement('div');
  composerFooter.className = 'agy-composer-footer flex w-full items-center justify-between';
  composerFooter._rect = { left: 20, top: 660, right: 620, bottom: 690, width: 600, height: 30 };
  const leftCluster = doc.createElement('div');
  leftCluster.className = 'flex items-center';
  const modelTrigger = doc.createElement('button');
  modelTrigger.setAttribute('data-testid', 'model-selector-trigger');
  modelTrigger.setAttribute('data-context-window', '1M');
  modelTrigger.setAttribute('aria-label', 'Select model, current: Gemini 4 Neon (High)');
  leftCluster.appendChild(modelTrigger);
  const rightCluster = doc.createElement('div');
  rightCluster.className = 'shrink-0 flex items-center';
  composerFooter.appendChild(leftCluster);
  composerFooter.appendChild(rightCluster);
  inputBox.appendChild(composerFooter);
  pane.appendChild(inputBox);

  doc.body.appendChild(titlebar);
  doc.body.appendChild(pane);

  const win = {
    innerWidth: 1200,
    innerHeight: 800,
    location: { href },
    history: {
      pushState(_s, _t, nextUrl) {
        if (nextUrl) win.location.href = String(nextUrl);
      },
      replaceState(_s, _t, nextUrl) {
        if (nextUrl) win.location.href = String(nextUrl);
      }
    },
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  return { win, doc, titlebar, tbTitle, tbRight, pane, inputBox, composerFooter, leftCluster, rightCluster, modelTrigger };
}

test('styles: formatting helpers and CSS silence/no-infinite-animation contract', () => {
  assert.equal(styles.formatTokensCompact(0), '0');
  assert.equal(styles.formatTokensCompact(626400), '626K');
  assert.equal(styles.formatTokensCompact(4800000), '4.8M');
  assert.equal(styles.formatTokensOneDecimal(0), '0.0K');
  assert.equal(styles.formatTokensOneDecimal(7800), '7.8K');
  assert.equal(styles.formatTokensOneDecimal(188000), '188.0K');
  assert.equal(styles.formatTokensOneDecimal(22000000), '22.0M');
  assert.equal(styles.formatContextPercentOneDecimal({ ratio: 0.8554, percent: 86 }), '85.5%');
  assert.equal(styles.formatContextPercentOneDecimal({ ratio: null, percent: 38 }), '38.0%');
  assert.equal(styles.formatMonthDayTime(Date.UTC(2026, 10, 24, 2, 33) - (new Date(Date.UTC(2026, 10, 24, 2, 33)).getTimezoneOffset() * 60000) + new Date().getTimezoneOffset() * 60000).length > 5, true);
  assert.equal(styles.formatUsd(null, { isPriced: false }), 'Unpriced');
  assert.equal(styles.formatUsd(0.004, { isPriced: true }), '<$0.01');
  assert.equal(styles.formatUsd(12.345, { isPriced: true, hasUnpriced: true }), '$12.35*');
  assert.equal(styles.formatDurationCompact(7740), '7.7s');
  assert.equal(styles.formatDurationCompact(877000), '14m 37s');
  assert.equal(styles.formatDurationHm(0), '0m');
  assert.equal(styles.formatDurationHm(45000), '<1m');
  assert.equal(styles.formatDurationHm((43 * 60 + 50) * 1000), '44m');
  assert.equal(styles.formatDurationHm((2 * 3600 + 15 * 60) * 1000), '2h 15m');
  assert.equal(styles.escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');

  const css = styles.SHARED_CSS + styles.COMPOSER_CSS + styles.TOPBAR_CSS;
  assert.ok(css.includes('display: none !important'));
  assert.ok(styles.SHARED_CSS.includes('inset: auto;'));
  assert.ok(styles.SHARED_CSS.includes('margin: 0;'));
  assert.ok(styles.SHARED_CSS.includes('padding: 0;'));
  assert.ok(styles.SHARED_CSS.includes('color-scheme: dark'));
  assert.ok(styles.SHARED_CSS.includes('::-webkit-scrollbar-thumb'));
  assert.equal(css.includes('@keyframes'), false);
  assert.equal(/\binfinite\b/i.test(css), false);

  const normalRing = styles.buildSvgRing({ size: 16, strokeWidth: 1.85, fraction: 0.4, color: '#68c28c' });
  assert.equal(normalRing.includes('data-ring-text'), false);
  assert.equal(normalRing.includes('data-ring-label'), false);

  const countRing = styles.buildSvgRing({ size: 16, strokeWidth: 1.85, fraction: 0.4, color: '#68c28c', centerText: '3' });
  assert.ok(countRing.includes('data-ring-text="3"'));
  assert.ok(countRing.includes('data-ring-label="true"'));
  assert.ok(countRing.includes('text-anchor="middle"'));
  assert.ok(countRing.includes('dy="0.355em"'));
  assert.ok(countRing.includes('rgba(242, 244, 248, 0.92)'));
  assert.ok(countRing.includes('>3</text>'));

  const overflowRing = styles.buildSvgRing({ size: 16, strokeWidth: 1.85, fraction: 0.2, color: '#e0a054', centerText: '9+' });
  assert.ok(overflowRing.includes('data-ring-text="9+"'));
  assert.ok(overflowRing.includes('letter-spacing:-0.04em'));
  assert.ok(overflowRing.includes('>9+</text>'));
});

test('mount: parseActiveConversationFromUrl handles single, split %2B with focused, and non-chat URLs', () => {
  const id1 = '11111111-1111-1111-1111-111111111111';
  const id2 = '22222222-2222-2222-2222-222222222222';
  assert.equal(mount.parseActiveConversationFromUrl(`https://127.0.0.1:1/c/${id1}`), id1);
  assert.equal(
    mount.parseActiveConversationFromUrl(`https://127.0.0.1:1/c/${id1}%2B${id2}?focused=${id2}`),
    id2
  );
  assert.equal(
    mount.parseActiveConversationFromUrl(`https://127.0.0.1:1/c/${id1}%2B${id2}?focused=99999999-9999-9999-9999-999999999999`),
    id1
  );
  assert.equal(mount.parseActiveConversationFromUrl('https://127.0.0.1:1/settings'), null);
});

test('renderer: Shadow isolation, Area A & B click popovers, on-demand Context, heatmap filter, narrow fallback', async () => {
  const { win, doc, tbTitle, inputBox, composerFooter, rightCluster } = createFakeDom();
  let contextCalls = 0;
  let sessionCalls = 0;
  const usageCalls = [];

  const fakeApi = {
    getQuota: async () => ({
      ok: true,
      data: {
        profile: { name: 'Pilot', email: 'pilot@example.com', planBadge: 'Ultra', initials: 'PI' },
        updatedAtMs: Date.now(),
        nextReset: { atMs: Date.now() + 3600000, countdown: '1h' },
        summaryRings: {
          window5h: { remainingFraction: 0.84, percent: 84 },
          window7d: { remainingFraction: 0.71, percent: 71 }
        },
        pools: [
          {
            poolKey: 'gemini_main',
            title: 'Gemini Models',
            bucket5h: { label: '5h limit', percent: 84, countdown: '1h' },
            bucket7d: { label: 'Weekly limit', percent: 71, countdown: '3d' },
            weeklyCycle: { lastResetAtMs: Date.now() - 4 * 86400000, pace: { state: 'on_track', label: 'On track · 0.5×', tone: 'ok' } },
            buckets: []
          }
        ]
      }
    }),
    getToday: async () => ({ ok: true, data: { totalTokens: 4800000 } }),
    getSession: async () => {
      sessionCalls++;
      return {
      ok: true,
      data: {
        main: {
          turns: 3,
          steps: 15,
          inputTokens: 400000,
          outputTokens: 20000,
          cacheReadTokens: 206000,
          totalTokens: 626000,
          cacheHitRate: 0.34,
          avgTtftMs: 2100,
          outputSpeedTps: 112,
          modelTimeMs: 42000,
          waterline: { usedTokens: 380000, contextLimit: 1000000, ratio: 0.38, percent: 38, level: 'green' },
          primaryModel: { displayName: 'Gemini 4 Neon' },
          cost: { priced: false, costUsd: null, label: 'Unpriced' }
        },
        totalTokens: 626000,
        totalCost: { priced: false, costUsd: null, hasUnpriced: true, label: 'Unpriced' },
        subagentSummary: {
          runningCount: 1,
          totalCount: 2,
          hasRunning: true,
          badgeText: '1/2',
          items: [
            {
              title: 'PDF Verifier',
              status: 'Running',
              modelDisplayName: 'Gemini 4 Carbon',
              currentContextTokens: 42000,
              waterline: { percent: 4 }
            }
          ]
        }
      }
    };
    },
    getContext: async () => {
      contextCalls++;
      return {
        ok: true,
        data: {
          breakdownAvailable: true,
          exactPromptTokens: 380000,
          waterline: { usedTokens: 380000, contextLimit: 1000000, ratio: 0.38, percent: 38, level: 'green' },
          categories: [
            { key: 'system_prompt', label: 'System Prompt', tokens: 20000, percent: 5.3 },
            { key: 'skills_rules', label: 'Skills & Rules', tokens: 10000, percent: 2.6 },
            { key: 'mcp_tools', label: 'MCP Tools', tokens: 0, percent: 0 },
            { key: 'builtin_tools', label: 'Built-in Tools', tokens: 15000, percent: 3.9 },
            { key: 'messages_outputs', label: 'Messages & Outputs', tokens: 335000, percent: 88.2 }
          ]
        }
      };
    },
    getUsage: async ({ period, selectedDateKey }) => {
      usageCalls.push({ period, selectedDateKey });
      return {
        ok: true,
        profile: { name: 'Pilot', email: 'pilot@example.com', planBadge: 'Ultra', initials: 'PI' },
        data: {
          today: { totalTokens: 4800000 },
          summary: {
            tokens: 12000000,
            estUsd: 8.5,
            hasUnpriced: false,
            avg7dTokens: 1700000,
            dailyAvgTokens: 2400000,
            avgPerChatTokens: 2000000,
            dailyTimeMs: 360000,
            activeDailyTimeMs: 720000
          },
          heatmap: [{ dateKey: '2026-11-24', totalTokens: 4800000, costUsd: 3.2, hasUnpriced: false, level: 4 }],
          byModel: [{ displayName: 'Gemini 4 Carbon', totalTokens: 12000000, isPriced: true, costUsd: 8.5 }],
          topSessions: [
            {
              title: selectedDateKey ? 'Day Filtered Chat' : 'Top Chat',
              primaryModel: { displayName: 'Gemini 4 Carbon' },
              totalTokens: 5000000,
              subagentCount: 2,
              isPriced: true,
              costUsd: 3.1,
              hasUnpriced: false
            }
          ]
        }
      };
    }
  };

  const ctrl = mount.start({ win, doc, api: fakeApi });
  try {
  await new Promise((r) => setTimeout(r, 15));

  // Verify anchors & initial closed state (Area B sits right of title; Area A sits inside .agy-composer-footer before rightCluster)
  assert.equal(ctrl.topbar.host.parentElement, tbTitle);
  assert.equal(tbTitle.lastElementChild, ctrl.topbar.host);
  assert.equal(ctrl.topbar.shadow.querySelector('.agv-pills').getAttribute('data-placement'), 'after-title');
  assert.equal(ctrl.composer.host.parentElement, composerFooter);
  assert.equal(ctrl.composer.host.nextSibling, rightCluster);
  assert.equal(contextCalls, 0);
  assert.equal(usageCalls.length, 0);
  assert.equal(ctrl.composer.shadow.querySelector('[data-slot="session-tok"]').textContent, '626.0K');
  assert.equal(ctrl.composer.shadow.querySelector('[data-slot="ctx-pct"]').textContent, '38.0%');
  assert.equal(ctrl.composer.shadow.querySelector('[data-slot="sub-badge"]').textContent, '1/2');
  assert.equal(ctrl.topbar.shadow.querySelector('[data-slot="pct-5h"]').textContent, '84%');
  assert.equal(ctrl.topbar.shadow.querySelector('[data-slot="pct-7d"]').textContent, '71%');
  assert.equal(ctrl.topbar.shadow.querySelector('[data-slot="today-tok"]').textContent, '4.8M');
  assert.ok(ctrl.topbar.shadow.innerHTML.includes('Today'));

  // Verify SPA pushState immediately triggers session refresh for new conversation URL
  const prevSessionCalls = sessionCalls;
  win.history.pushState({}, '', 'https://127.0.0.1:43000/c/22222222-2222-2222-2222-222222222222');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(sessionCalls, prevSessionCalls + 1);

  // Verify Shadow DOM mousedown isolation
  const nonEditEvt = ctrl.topbar.shadow.querySelector('[data-trigger="quota"]').dispatchEvent({ type: 'mousedown' });
  assert.equal(nonEditEvt.defaultPrevented, true);
  assert.equal(nonEditEvt.propagationStopped, true);
  const inputChild = doc.createElement('input');
  ctrl.topbar.shadow.appendChild(inputChild);
  const editEvt = inputChild.dispatchEvent({ type: 'mousedown' });
  assert.equal(editEvt.defaultPrevented, false);
  assert.equal(editEvt.propagationStopped, true);

  // Click Area A Context -> triggers on-demand getContext once
  ctrl.composer.shadow.querySelector('[data-trigger="context"]').dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(contextCalls, 1);
  assert.equal(ctrl.composer.getOpenCard(), 'context');
  const ctxHtml = ctrl.composer.shadow.querySelector('.agv-popover').innerHTML;
  assert.ok(ctxHtml.includes('System Prompt'));
  assert.ok(ctxHtml.includes('0.0K'));
  assert.ok(ctxHtml.includes('0.0%'));
  assert.equal(ctxHtml.includes('Prompt composition'), false);
  assert.equal(ctxHtml.includes('Estimated'), false);

  // Click Area B Usage -> closes Area A, opens Usage left-aligned, loads 7D
  const usageTrigger = ctrl.topbar.shadow.querySelector('[data-trigger="usage"]');
  usageTrigger._rect = { left: 260, top: 8, right: 340, bottom: 34, width: 80, height: 26 };
  usageTrigger.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(ctrl.composer.getOpenCard(), null);
  assert.equal(ctrl.topbar.getOpenPanel(), 'usage');
  assert.equal(usageCalls.length, 1);
  assert.equal(usageCalls[0].period, '7D');
  assert.equal(ctrl.topbar.shadow.querySelector('.agv-popover').style.left, '260px');
  const usageHtml = ctrl.topbar.shadow.querySelector('.agv-popover').innerHTML;
  assert.ok(usageHtml.includes('7 Days'));
  assert.ok(usageHtml.includes('30 Days'));
  assert.ok(usageHtml.includes('All'));
  assert.ok(usageHtml.includes('Est. Cost'));
  assert.ok(usageHtml.includes('Model Breakdown'));
  assert.ok(usageHtml.includes('Est. Cost (USD)'));
  assert.equal(usageHtml.includes('By Model'), false);
  assert.equal(usageHtml.includes('>Est. USD<'), false);
  assert.ok(usageHtml.includes('Daily Avg'));
  assert.ok(usageHtml.includes('Per Chat'));
  assert.ok(usageHtml.includes('Daily Time'));
  assert.ok(usageHtml.includes('agv-usage-meta'));
  assert.ok(usageHtml.includes('12.0M'));
  assert.ok(usageHtml.includes('5.0M'));
  assert.ok(usageHtml.includes('2.4M'));
  assert.ok(usageHtml.includes('12m'));

  // Click heatmap dot -> re-requests Usage with selectedDateKey
  const dot = ctrl.topbar.shadow.querySelector('[data-date="2026-11-24"]');
  dot.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(usageCalls[1].selectedDateKey, '2026-11-24');
  assert.ok(ctrl.topbar.shadow.querySelector('.agv-popover').innerHTML.includes('Day Filtered Chat'));

  // Esc closes popover
  doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(ctrl.topbar.getOpenPanel(), null);
  assert.equal(ctrl.topbar.shadow.querySelector('.agv-popover').hidden, true);

  // Narrow composer (<340px) triggers fallback row under agent-input-box
  composerFooter._rect = { left: 20, top: 660, right: 240, bottom: 690, width: 220, height: 30 };
  inputBox._rect = { left: 20, top: 600, right: 240, bottom: 700, width: 220, height: 100 };
  ctrl.refreshNow();
  assert.equal(ctrl.composer.host.parentElement, inputBox.parentElement);
  assert.equal(inputBox.nextSibling, ctrl.composer.host);
  } finally {
    ctrl.dispose();
  }
});

function buildSplitPaneNode(doc, { paneId, cascadeId, modelLabel, unfocused = false }) {
  const outer = doc.createElement('div');
  outer.setAttribute('data-pane-id', paneId);
  outer.setAttribute('data-tiling-pane', 'top');

  const inner = doc.createElement('div');
  inner.setAttribute('data-pane-id', paneId);
  if (unfocused) inner.setAttribute('data-pane-unfocused', '');

  const convView = doc.createElement('div');
  convView.setAttribute('data-testid', 'conversation-view');
  convView.setAttribute('data-cascade-id', cascadeId);

  const inputBox = doc.createElement('div');
  inputBox.setAttribute('data-testid', 'agent-input-box');
  inputBox._rect = { left: 20, top: 600, right: 620, bottom: 700, width: 600, height: 100 };

  const footer = doc.createElement('div');
  footer.className = 'agy-composer-footer flex w-full items-center justify-between';
  footer._rect = { left: 20, top: 660, right: 620, bottom: 690, width: 600, height: 30 };

  const leftCluster = doc.createElement('div');
  leftCluster.className = 'flex items-center';
  const trigger = doc.createElement('button');
  trigger.setAttribute('data-testid', 'model-selector-trigger');
  trigger.setAttribute('aria-label', `Select model, current: ${modelLabel}`);
  leftCluster.appendChild(trigger);

  const rightCluster = doc.createElement('div');
  rightCluster.className = 'shrink-0 flex items-center';

  footer.appendChild(leftCluster);
  footer.appendChild(rightCluster);
  inputBox.appendChild(footer);
  convView.appendChild(inputBox);
  inner.appendChild(convView);
  outer.appendChild(inner);

  return { outer, inner, convView, inputBox, footer, leftCluster, rightCluster, trigger };
}

test('mount: nested split panes resolve [data-cascade-id], switch focus, clear stale context, and handle New Chat', async () => {
  const id1 = '11111111-1111-1111-1111-111111111111';
  const id2 = '22222222-2222-2222-2222-222222222222';
  const { win, doc, pane } = createFakeDom('https://127.0.0.1:43000/');
  pane.remove();

  const pane1 = buildSplitPaneNode(doc, {
    paneId: 'pane-1',
    cascadeId: id1,
    modelLabel: 'Gemini 4 Neon Extra High',
    unfocused: true
  });
  const pane2 = buildSplitPaneNode(doc, {
    paneId: 'pane-2',
    cascadeId: id2,
    modelLabel: 'Claude Opus 5.5 (High)',
    unfocused: false
  });
  doc.body.appendChild(pane1.outer);
  doc.body.appendChild(pane2.outer);

  const sessionIds = [];
  const contextIds = [];
  const quotaModels = [];

  const api = {
    getQuota: async ({ currentModel }) => {
      quotaModels.push(currentModel);
      return { ok: true, data: { summaryRings: {}, pools: [] } };
    },
    getToday: async () => ({ ok: true, data: { totalTokens: 0 } }),
    getSession: async ({ conversationId }) => {
      sessionIds.push(conversationId);
      return {
        ok: true,
        data: {
          main: {
            turns: 1,
            steps: 2,
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 200,
            totalTokens: 350,
            waterline: { usedTokens: 300, contextLimit: 512000, ratio: 0.001, percent: 0, level: 'green' },
            primaryModel: { displayName: conversationId === id2 ? 'Claude Opus 5.5' : 'Gemini 4 Neon' },
            cost: { priced: false, costUsd: null }
          },
          totalTokens: 350,
          totalCost: { priced: false, costUsd: null, hasUnpriced: true },
          subagentSummary: { runningCount: 0, totalCount: 0, hasRunning: false, badgeText: '0', items: [] }
        }
      };
    },
    getContext: async ({ conversationId }) => {
      contextIds.push(conversationId);
      return {
        ok: true,
        data: {
          breakdownAvailable: true,
          exactPromptTokens: 300,
          waterline: { usedTokens: 300, contextLimit: 512000, ratio: 0.001, percent: 0, level: 'green' },
          categories: [{ key: 'system_prompt', label: 'System Prompt', tokens: 300, percent: 100 }]
        }
      };
    }
  };

  const ctrl = mount.start({ win, doc, api });
  try {
    await new Promise((r) => setTimeout(r, 15));

    // Both pane-1 and pane-2 mount their own composer bars simultaneously without duplicate IDs;
    // ctrl.composer points to the focused pane-2 (resolved via inner [data-pane-unfocused])
    assert.equal(ctrl.composers.size, 2);
    const comp1 = ctrl.composers.get('pane:pane-1');
    const comp2 = ctrl.composers.get('pane:pane-2');
    assert.ok(comp1 && comp2 && comp1 !== comp2);
    assert.equal(comp1.host.id, '');
    assert.equal(comp2.host.id, '');
    assert.equal(comp1.host.getAttribute('data-ag-vario-composer'), 'true');
    assert.equal(comp2.host.getAttribute('data-ag-vario-composer'), 'true');
    assert.equal(comp1.host.parentElement, pane1.footer);
    assert.equal(comp1.host.nextSibling, pane1.rightCluster);
    assert.equal(comp2.host.parentElement, pane2.footer);
    assert.equal(comp2.host.nextSibling, pane2.rightCluster);

    assert.equal(ctrl.getState().activeConversationId, id2);
    assert.equal(ctrl.composer, comp2);
    assert.equal(ctrl.composer.host.parentElement, pane2.footer);
    assert.equal(ctrl.composer.host.nextSibling, pane2.rightCluster);
    assert.equal(ctrl.composer.host.style.display, 'inline-flex');
    assert.ok(sessionIds.includes(id1) && sessionIds.includes(id2));

    // Repeated sync preserves position & never treats [data-ag-vario-composer] as rightCluster
    ctrl.refreshNow();
    ctrl.refreshNow();
    assert.equal(ctrl.composer.host.parentElement, pane2.footer);
    assert.equal(ctrl.composer.host.nextSibling, pane2.rightCluster);
    assert.equal(comp1.host.parentElement, pane1.footer);
    assert.equal(comp1.host.nextSibling, pane1.rightCluster);

    // Open context for id2 (focused pane-2)
    comp2.shadow.querySelector('[data-trigger="context"]').dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(contextIds, [id2]);
    assert.equal(comp2.getOpenCard(), 'context');

    // Clicking unfocused pane-1's Context trigger fetches id1 and closes pane-2's open card
    comp1.shadow.querySelector('[data-trigger="context"]').dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(contextIds, [id2, id1]);
    assert.equal(comp1.getOpenCard(), 'context');
    assert.equal(comp2.getOpenCard(), null);

    // Switch focus back to pane-1 (already loaded, zero flash)
    pane1.inner.attributes.delete('data-pane-unfocused');
    pane2.inner.setAttribute('data-pane-unfocused', '');
    doc.dispatchEvent({ type: 'click', target: pane1.trigger });
    await new Promise((r) => setTimeout(r, 15));

    assert.equal(ctrl.getState().activeConversationId, id1);
    assert.equal(ctrl.composer, comp1);
    assert.equal(ctrl.composer.host.parentElement, pane1.footer);
    assert.equal(ctrl.composer.host.nextSibling, pane1.rightCluster);
    assert.equal(comp1.shadow.querySelector('[data-slot="session-tok"]').textContent, '0.3K');

    // Re-opening context on newly focused pane-1 fetches for id1 cleanly
    if (comp1.getOpenCard() === 'context') comp1.close();
    comp1.shadow.querySelector('[data-trigger="context"]').dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(contextIds, [id2, id1, id1]);

    // Unsaved New Chat ("conversation") keeps Area A visible with empty slots and does NOT steal URL UUID, while updating quota model hint
    const prevCalls = sessionIds.length;
    win.location.href = `https://127.0.0.1:43000/c/${id2}`;
    pane1.convView.setAttribute('data-cascade-id', 'conversation');
    pane1.trigger.setAttribute('aria-label', 'Select model, current: Gemini 4 Carbon (High)');
    ctrl.refreshNow();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(ctrl.getState().activeConversationId, null);
    assert.equal(ctrl.composer.host.style.display, 'inline-flex');
    assert.equal(ctrl.composer.shadow.querySelector('[data-slot="session-tok"]').textContent, '—');
    assert.equal(ctrl.composer.shadow.querySelector('[data-slot="ctx-pct"]').textContent, '—');
    assert.equal(ctrl.composer.shadow.querySelector('[data-slot="sub-badge"]').textContent, '0');
    // Unfocused pane-2 still refreshed id2, while pane-1 ("conversation") did not fetch id2
    assert.equal(sessionIds.length, prevCalls + 1);
    assert.equal(sessionIds[sessionIds.length - 1], id2);
    assert.equal(quotaModels[quotaModels.length - 1], 'Gemini 4 Carbon (High)');

    // Removing composer anchors entirely (e.g. non-chat view) disposes pane bars & hides dormant composer
    pane1.outer.remove();
    pane2.outer.remove();
    ctrl.refreshNow();
    assert.equal(ctrl.composers.size, 0);
    assert.equal(ctrl.composer.host.style.display, 'none');
  } finally {
    ctrl.dispose();
  }
});

test('mount: uses Navigation API without touching history, and detached fallback never throws Illegal invocation', async () => {
  // 1. With window.navigation: history.pushState / replaceState stay untouched
  const { win: winNav, doc: docNav } = createFakeDom('https://127.0.0.1:43000/');
  const navListeners = new Map();
  winNav.navigation = {
    addEventListener(type, fn) {
      const list = navListeners.get(type) || [];
      list.push(fn);
      navListeners.set(type, list);
    },
    removeEventListener(type, fn) {
      navListeners.set(type, (navListeners.get(type) || []).filter((f) => f !== fn));
    }
  };
  const origPush = winNav.history.pushState;
  const origReplace = winNav.history.replaceState;
  const seenIds = [];
  const ctrl1 = mount.start({
    win: winNav,
    doc: docNav,
    api: {
      getQuota: async () => ({ ok: true, data: { summaryRings: {}, pools: [] } }),
      getToday: async () => ({ ok: true, data: { totalTokens: 0 } }),
      getSession: async ({ conversationId }) => {
        seenIds.push(conversationId);
        return { ok: false };
      }
    }
  });
  assert.equal(winNav.history.pushState, origPush);
  assert.equal(winNav.history.replaceState, origReplace);

  const id3 = '33333333-3333-3333-3333-333333333333';
  winNav.location.href = `https://127.0.0.1:43000/c/${id3}`;
  for (const fn of navListeners.get('currententrychange') || []) fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ctrl1.getState().activeConversationId, id3);
  assert.equal(seenIds[0], id3);
  ctrl1.dispose();
  assert.equal((navListeners.get('currententrychange') || []).length, 0);

  // 2. Fallback without window.navigation: detached (cond ? history.pushState : history.replaceState)(...) works
  const { win: winHist, doc: docHist } = createFakeDom('https://127.0.0.1:43000/');
  const strictHistory = {
    pushState(_s, _t, nextUrl) {
      if (this !== strictHistory) throw new TypeError('Illegal invocation');
      if (nextUrl) winHist.location.href = String(nextUrl);
    },
    replaceState(_s, _t, nextUrl) {
      if (this !== strictHistory) throw new TypeError('Illegal invocation');
      if (nextUrl) winHist.location.href = String(nextUrl);
    }
  };
  winHist.history = strictHistory;

  const ctrl2 = mount.start({
    win: winHist,
    doc: docHist,
    api: {
      getQuota: async () => ({ ok: true, data: { summaryRings: {}, pools: [] } }),
      getToday: async () => ({ ok: true, data: { totalTokens: 0 } }),
      getSession: async () => ({ ok: false })
    }
  });
  const id4 = '44444444-4444-4444-4444-444444444444';
  const detachedPush = winHist.history.pushState;
  detachedPush({}, '', `https://127.0.0.1:43000/c/${id4}`);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ctrl2.getState().activeConversationId, id4);
  ctrl2.dispose();
});

test('topbar: clicking a Token Activity dot >7 days ago auto-switches period from 7D to 30D', async () => {
  const { win, doc } = createFakeDom();
  const usageCalls = [];

  const heatmap30 = [];
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(Date.UTC(2026, 10, 24 - i));
    const dk = dt.toISOString().slice(0, 10);
    heatmap30.push({ dateKey: dk, totalTokens: i === 20 ? 100000 : 1000, costUsd: 1, hasUnpriced: false, level: 2 });
  }

  const ctrl = mount.start({
    win,
    doc,
    api: {
      getQuota: async () => ({ ok: true, data: { summaryRings: {}, pools: [] } }),
      getToday: async () => ({ ok: true, data: { totalTokens: 1000 } }),
      getSession: async () => ({ ok: false }),
      getUsage: async ({ period, selectedDateKey }) => {
        usageCalls.push({ period, selectedDateKey });
        return {
          ok: true,
          data: {
            today: { totalTokens: 1000 },
            summary: { tokens: 1000, estUsd: 1, avg7dTokens: 1000, avgPerChatTokens: 1000, dailyTimeMs: 60000 },
            heatmap: heatmap30,
            byModel: [],
            topSessions: []
          }
        };
      }
    }
  });

  try {
    ctrl.topbar.shadow.querySelector('[data-trigger="usage"]').dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctrl.topbar.getState().period, '7D');

    // Click recent dot (within 7 days) -> stays 7D
    const recentDate = heatmap30[27].dateKey;
    ctrl.topbar.shadow.querySelector(`[data-date="${recentDate}"]`).dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctrl.topbar.getState().period, '7D');
    assert.equal(usageCalls[usageCalls.length - 1].period, '7D');
    assert.equal(usageCalls[usageCalls.length - 1].selectedDateKey, recentDate);

    // Click old dot (>7 days ago) -> switches 7D to 30D
    const oldDate = heatmap30[5].dateKey;
    ctrl.topbar.shadow.querySelector(`[data-date="${oldDate}"]`).dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctrl.topbar.getState().period, '30D');
    assert.equal(usageCalls[usageCalls.length - 1].period, '30D');
    assert.equal(usageCalls[usageCalls.length - 1].selectedDateKey, oldDate);
    assert.equal(
      ctrl.topbar.shadow.querySelector('[data-period="30D"]').getAttribute('data-active'),
      'true'
    );
  } finally {
    ctrl.dispose();
  }
});

test('composer-bar: Session card renders aligned 3-tier layout, effort model name, and single total cost', () => {
  const { win, doc } = createFakeDom();
  const bar = composerBar.createComposerBar({ doc, win });
  try {
    const baseMain = {
      turns: 2,
      steps: 10,
      inputTokens: 570000,
      outputTokens: 71500,
      cacheReadTokens: 4000000,
      totalTokens: 4641500,
      cacheHitRate: 0.875,
      avgTtftMs: 6300,
      outputSpeedTps: 150,
      modelTimeMs: 647000,
      waterline: { usedTokens: 200000, contextLimit: 512000, ratio: 0.39, percent: 39, level: 'green' },
      primaryModel: { displayName: 'Gemini 4 Neon', displayNameWithEffort: 'Gemini 4 Neon (High)' },
      cost: { priced: true, costUsd: 3.42 }
    };

    bar.updateSession({
      main: baseMain,
      totalTokens: 4641500,
      totalCost: { priced: true, costUsd: 3.42, hasUnpriced: false },
      subagentSummary: { runningCount: 0, totalCount: 0, hasRunning: false, badgeText: '0', items: [] }
    });
    bar.openCard('session');

    const popNoSub = bar.shadow.querySelector('.agv-popover').innerHTML;
    assert.ok(popNoSub.includes('Gemini 4 Neon (High)'));
    assert.ok(popNoSub.includes('2 turns · 10 steps'));
    assert.ok(popNoSub.includes('4.6M'));
    assert.ok(popNoSub.includes('71.5K'));
    assert.ok(popNoSub.includes('$3.42'));
    assert.ok(popNoSub.includes('Token Breakdown'));
    assert.ok(popNoSub.includes('Hit 87.5%'));
    assert.ok(popNoSub.includes('agv-stack-bar'));
    assert.equal(popNoSub.includes('agv-block-quiet'), false);
    assert.ok(popNoSub.includes('Avg TTFT'));
    assert.ok(popNoSub.includes('Speed'));
    assert.ok(popNoSub.includes('Model Time'));
    assert.equal(popNoSub.includes('agv-hero-sub'), false);

    bar.updateSession({
      main: baseMain,
      totalTokens: 5100000,
      totalCost: { priced: true, costUsd: 4.12, hasUnpriced: false },
      subagentSummary: { runningCount: 0, totalCount: 2, hasRunning: false, badgeText: '0/2', items: [] }
    });
    const popWithSub = bar.shadow.querySelector('.agv-popover').innerHTML;
    assert.equal(popWithSub.includes('agv-hero-sub'), false);
    assert.equal(popWithSub.includes('Main $3.42'), false);
    assert.ok(popWithSub.includes('$4.12'));
    assert.ok(popWithSub.includes('5.1M'));
  } finally {
    bar.dispose();
  }
});

test('composer-bar: 16px Lap Ring counter and Ice Blue aligned compaction banner render accurately and survive updateContext', () => {
  const { win, doc } = createFakeDom();
  const bar = composerBar.createComposerBar({ doc, win });
  try {
    const makeMain = (compaction) => ({
      turns: 4,
      steps: 18,
      inputTokens: 12000,
      outputTokens: 3000,
      cacheReadTokens: 11000,
      totalTokens: 26000,
      cacheHitRate: 0.48,
      avgTtftMs: 1200,
      outputSpeedTps: 120,
      modelTimeMs: 15000,
      waterline: { usedTokens: 23014, contextLimit: 512000, ratio: 23014 / 512000, percent: 4, level: 'green' },
      compaction,
      primaryModel: { displayName: 'Gemini 4 Neon', displayNameWithEffort: 'Gemini 4 Neon (xhigh)' },
      cost: { priced: true, costUsd: 0.12 }
    });

    // Uncompacted: 16px ring, empty center, no banner
    bar.updateSession({
      main: makeMain({ compacted: false, count: 0, lastBeforeTokens: null, lastAfterTokens: null }),
      totalTokens: 26000,
      totalCost: { priced: true, costUsd: 0.12, hasUnpriced: false },
      subagentSummary: { runningCount: 0, totalCount: 0, hasRunning: false, badgeText: '0', items: [] }
    });
    assert.equal(bar.shadow.querySelector('[data-trigger="context"]').getAttribute('data-compacted'), 'false');
    const uncompRing = bar.shadow.querySelector('[data-slot="ctx-ring"]').innerHTML;
    assert.ok(uncompRing.includes('width="16"'));
    assert.equal(uncompRing.includes('data-ring-label'), false);

    // 1x compacted
    bar.updateSession({
      main: makeMain({ compacted: true, count: 1, lastBeforeTokens: 514867, lastAfterTokens: 23014 }),
      totalTokens: 26000,
      totalCost: { priced: true, costUsd: 0.12, hasUnpriced: false },
      subagentSummary: { runningCount: 0, totalCount: 0, hasRunning: false, badgeText: '0', items: [] }
    });
    assert.equal(bar.shadow.querySelector('[data-trigger="context"]').getAttribute('data-compacted'), 'true');
    const ring1x = bar.shadow.querySelector('[data-slot="ctx-ring"]').innerHTML;
    assert.ok(ring1x.includes('width="16"'));
    assert.ok(ring1x.includes('data-ring-text="1"'));
    assert.ok(ring1x.includes('>1</text>'));

    bar.openCard('context');
    bar.updateContext({
      breakdownAvailable: true,
      exactPromptTokens: 23014,
      waterline: { usedTokens: 23014, contextLimit: 512000, ratio: 23014 / 512000, percent: 4, level: 'green' },
      categories: [{ key: 'system_prompt', label: 'System Prompt', tokens: 23014, percent: 100 }]
    });
    // Preserves centered count inside 16px ring after updateContext
    assert.ok(bar.shadow.querySelector('[data-slot="ctx-ring"]').innerHTML.includes('data-ring-text="1"'));
    const html1x = bar.shadow.querySelector('.agv-popover').innerHTML;
    assert.ok(html1x.includes('agv-compact-banner'));
    assert.ok(html1x.includes('agv-compact-left'));
    assert.ok(html1x.includes('agv-compact-right'));
    assert.ok(html1x.includes('Compacted 1×'));
    assert.ok(html1x.includes('514.9K → 23.0K'));
    assert.ok(html1x.includes(styles.COLORS.iceBlue));
    assert.equal(html1x.includes('#c49bf5'), false);
    assert.ok(html1x.indexOf('agv-compact-banner') < html1x.indexOf('agv-ctx-list'));

    // 3x compacted -> ring shows "3", right side includes "Last "
    bar.updateSession({
      main: makeMain({ compacted: true, count: 3, lastBeforeTokens: 514867, lastAfterTokens: 23014 }),
      totalTokens: 26000,
      totalCost: { priced: true, costUsd: 0.12, hasUnpriced: false },
      subagentSummary: { runningCount: 0, totalCount: 0, hasRunning: false, badgeText: '0', items: [] }
    });
    assert.ok(bar.shadow.querySelector('[data-slot="ctx-ring"]').innerHTML.includes('data-ring-text="3"'));
    const html3x = bar.shadow.querySelector('.agv-popover').innerHTML;
    assert.ok(html3x.includes('Compacted 3×'));
    assert.ok(html3x.includes('Last 514.9K → 23.0K'));

    // 12x compacted -> ring caps at "9+", banner keeps exact "Compacted 12×"
    bar.updateSession({
      main: makeMain({ compacted: true, count: 12, lastBeforeTokens: 514867, lastAfterTokens: 23014 }),
      totalTokens: 26000,
      totalCost: { priced: true, costUsd: 0.12, hasUnpriced: false },
      subagentSummary: { runningCount: 0, totalCount: 0, hasRunning: false, badgeText: '0', items: [] }
    });
    assert.ok(bar.shadow.querySelector('[data-slot="ctx-ring"]').innerHTML.includes('data-ring-text="9+"'));
    assert.ok(bar.shadow.querySelector('.agv-popover').innerHTML.includes('Compacted 12×'));
  } finally {
    bar.dispose();
  }
});

test('topbar: Quota panel renders official names, 5h/Weekly limits, Ultra (5x), per-pool Last reset, Gemini burn rate, and Claude note', () => {
  const { win, doc } = createFakeDom();
  const bar = topbarBar.createTopbarBar({ doc, win });
  try {
    const nowMs = Date.UTC(2026, 10, 24, 12, 0);
    bar.updateQuota({
      profile: { planBadge: 'Ultra', planFullName: 'Google AI Ultra (5x)' },
      updatedAtMs: nowMs,
      summaryRings: {
        window5h: { remainingFraction: 0.79, percent: 79 },
        window7d: { remainingFraction: 0.94, percent: 94 }
      },
      pools: [
        {
          poolKey: 'gemini_main',
          title: 'Gemini Models',
          bucket5h: { label: '5h limit', percent: 79, countdown: '14m' },
          bucket7d: { label: 'Weekly limit', percent: 94, countdown: '6d 14h' },
          weeklyCycle: {
            lastResetAtMs: nowMs - 10 * 3600000,
            pace: { state: 'on_pace', label: 'On pace · 1.0×', tone: 'ice' }
          },
          buckets: []
        },
        {
          poolKey: 'claude_3p',
          title: 'Claude and GPT models',
          bucket5h: { label: '5h limit', percent: 100, countdown: '4h 56m' },
          bucket7d: { label: 'Weekly limit', percent: 30, countdown: '19h 15m' },
          weeklyCycle: {
            lastResetAtMs: nowMs - 149 * 3600000,
            pace: { state: 'high_burn', label: 'High burn · 0.8×', tone: 'ok' }
          },
          buckets: []
        }
      ]
    });
    bar.openPanel('quota');

    const html = bar.shadow.querySelector('.agv-popover').innerHTML;
    assert.ok(html.includes('Google AI Ultra (5x)'));
    assert.ok(html.includes('Gemini Models'));
    assert.ok(html.includes('Claude and GPT models'));
    assert.ok(html.includes('5h limit'));
    assert.ok(html.includes('Weekly limit'));
    assert.ok(html.includes('agv-quota-meta'));
    assert.ok(html.includes('agv-q-pct'));
    assert.ok(html.includes('agv-q-phrase'));
    assert.ok(html.includes('agv-q-word'));
    assert.ok(html.includes('agv-q-time'));
    assert.ok(html.includes('Resets in'));
    assert.ok(html.includes('Last reset:'));
    assert.ok(html.includes('On pace · 1.0×'));
    assert.ok(html.includes('Fuck Anthropic'));
    assert.equal(html.includes('Next reset'), false);

    // Resetting countdown omits .agv-q-word so no extra empty span gap is rendered
    bar.updateQuota({
      profile: { planBadge: 'Ultra', planFullName: 'Google AI Ultra (5x)' },
      updatedAtMs: nowMs,
      summaryRings: {},
      pools: [
        {
          poolKey: 'gemini_main',
          title: 'Gemini Models',
          bucket5h: { label: '5h limit', percent: 100, countdown: 'Resetting' },
          buckets: []
        }
      ]
    });
    const resettingHtml = bar.shadow.querySelector('.agv-popover').innerHTML;
    assert.ok(resettingHtml.includes('agv-q-phrase'));
    assert.ok(resettingHtml.includes('Resetting'));
    assert.equal(resettingHtml.includes('agv-q-word'), false);
  } finally {
    bar.dispose();
  }
});

test('topbar: Usage panel renders full plan badge, clamps at 420px width, and uses no-wrap Q3/U1 flex CSS', () => {
  const { win, doc } = createFakeDom();
  win.innerWidth = 436;
  const bar = topbarBar.createTopbarBar({ doc, win });
  try {
    const usageTrigger = bar.shadow.querySelector('[data-trigger="usage"]');
    usageTrigger._rect = { left: 260, top: 8, right: 340, bottom: 34, width: 80, height: 26 };

    const sampleUsage = {
      today: { totalTokens: 1000 },
      summary: { tokens: 1000, estUsd: 1.5, avg7dTokens: 1000, avgPerChatTokens: 1000, dailyTimeMs: 60000 },
      heatmap: [],
      byModel: [{ displayName: 'Gemini 4 Neon', totalTokens: 1000, isPriced: true, costUsd: 1.5 }],
      topSessions: [
        {
          title: 'Chat',
          primaryModel: { displayName: 'Gemini 4 Neon' },
          totalTokens: 1000,
          subagentCount: 0,
          isPriced: true,
          costUsd: 1.5,
          hasUnpriced: false
        }
      ]
    };

    bar.updateUsage(sampleUsage, { profile: { name: 'Pilot', email: 'pilot@example.com', planBadge: 'Ultra', planFullName: 'Google AI Ultra (5x)', initials: 'PI' } });
    bar.openPanel('usage');
    const pop = bar.shadow.querySelector('.agv-popover');
    assert.ok(pop.innerHTML.includes('Google AI Ultra (5x)'));
    // With vw=436 and panelW=420, clamped left = min(436 - 420 - 8, 260) = 8px
    assert.equal(pop.style.left, '8px');

    // Fallback to planBadge when planFullName is absent
    bar.updateUsage(sampleUsage, { profile: { name: 'Pilot', email: 'pilot@example.com', planBadge: 'Ultra', initials: 'PI' } });
    assert.ok(pop.innerHTML.includes('>Ultra<'));
    assert.equal(pop.innerHTML.includes('Google AI Ultra (5x)'), false);

    // CSS assertions for no-wrap badge, 420px usage panel, Q3 quota meta, U1 usage meta, and 10x10 heatmap
    assert.deepEqual(styles.COLORS.heatmapRamp, ['#343944', '#1b466e', '#2c70ad', '#52a3e8', '#b5dcff']);
    assert.ok(styles.TOPBAR_CSS.includes('repeat(30, 10px)'));
    assert.match(styles.TOPBAR_CSS, /\.agv-heat-dot\s*\{[^}]*width:\s*10px;[^}]*height:\s*10px;[^}]*border-radius:\s*2\.5px;/s);
    assert.match(styles.SHARED_CSS, /\.agv-badge\s*\{[^}]*white-space:\s*nowrap;[^}]*flex-shrink:\s*0;/s);
    assert.match(styles.TOPBAR_CSS, /\.agv-usage-panel\s*\{[^}]*width:\s*420px;/s);
    assert.match(styles.TOPBAR_CSS, /\.agv-quota-meta\s*\{[^}]*display:\s*inline-flex;[^}]*white-space:\s*nowrap;/s);
    assert.match(styles.TOPBAR_CSS, /\.agv-usage-meta\s*\{[^}]*display:\s*inline-flex;[^}]*gap:\s*6px;[^}]*white-space:\s*nowrap;/s);
  } finally {
    bar.dispose();
  }
});

test('mount: 3-pane and 4-pane splits (narrow fallback, 2x2 vertical popover flip, global popover mutex, and pane close cleanup)', async () => {
  const id1 = '11111111-1111-1111-1111-111111111111';
  const id2 = '22222222-2222-2222-2222-222222222222';
  const id3 = '33333333-3333-3333-3333-333333333333';
  const id4 = '44444444-4444-4444-4444-444444444444';

  const { win, doc, pane } = createFakeDom('https://127.0.0.1:43000/');
  win.innerWidth = 1400;
  win.innerHeight = 800;
  pane.remove();

  const pane1 = buildSplitPaneNode(doc, { paneId: 'pane-1', cascadeId: id1, modelLabel: 'Gemini 4 Neon (High)', unfocused: false });
  const pane2 = buildSplitPaneNode(doc, { paneId: 'pane-2', cascadeId: id2, modelLabel: 'Gemini 4 Carbon (High)', unfocused: true });
  const pane3 = buildSplitPaneNode(doc, { paneId: 'pane-3', cascadeId: id3, modelLabel: 'Claude Opus 5.5 (High)', unfocused: true });
  for (const p of [pane1, pane2, pane3]) {
    p.footer._rect = { left: 20, top: 660, right: 460, bottom: 690, width: 440, height: 30 };
    p.inputBox._rect = { left: 20, top: 600, right: 460, bottom: 700, width: 440, height: 100 };
    doc.body.appendChild(p.outer);
  }

  const tokensById = { [id1]: 100000, [id2]: 200000, [id3]: 300000, [id4]: 400000 };
  const api = {
    getQuota: async () => ({ ok: true, data: { summaryRings: {}, pools: [] } }),
    getToday: async () => ({ ok: true, data: { totalTokens: 0 } }),
    getSession: async ({ conversationId }) => {
      const tok = tokensById[conversationId] || 0;
      return {
        ok: true,
        data: {
          main: {
            turns: 1,
            steps: 2,
            inputTokens: tok,
            outputTokens: 100,
            cacheReadTokens: 0,
            totalTokens: tok + 100,
            cacheHitRate: 0,
            avgTtftMs: 1000,
            outputSpeedTps: 100,
            modelTimeMs: 5000,
            waterline: { usedTokens: tok, contextLimit: 1000000, ratio: tok / 1000000, percent: Math.round((tok / 1000000) * 100), level: 'green' },
            primaryModel: { displayName: 'Gemini 4 Neon', displayNameWithEffort: 'Gemini 4 Neon (High)' },
            cost: { priced: true, costUsd: 1.0 }
          },
          totalTokens: tok + 100,
          totalCost: { priced: true, costUsd: 1.0, hasUnpriced: false },
          subagentSummary: { runningCount: 0, totalCount: 0, hasRunning: false, badgeText: '0', items: [] }
        }
      };
    }
  };

  const ctrl = mount.start({ win, doc, api });
  try {
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctrl.composers.size, 3);

    const c1 = ctrl.composers.get('pane:pane-1');
    const c2 = ctrl.composers.get('pane:pane-2');
    const c3 = ctrl.composers.get('pane:pane-3');
    assert.equal(c1.shadow.querySelector('[data-slot="session-tok"]').textContent, '100.1K');
    assert.equal(c2.shadow.querySelector('[data-slot="session-tok"]').textContent, '200.1K');
    assert.equal(c3.shadow.querySelector('[data-slot="session-tok"]').textContent, '300.1K');
    assert.equal(c1.shadow.querySelector('.agv-comp-row').getAttribute('data-compact'), 'true');
    assert.equal(c2.shadow.querySelector('.agv-comp-row').getAttribute('data-compact'), 'true');
    assert.equal(c3.shadow.querySelector('.agv-comp-row').getAttribute('data-compact'), 'true');

    // Global popover mutex: opening pane-1, then topbar, then pane-3
    c1.shadow.querySelector('[data-trigger="session"]').dispatchEvent({ type: 'click' });
    assert.equal(c1.getOpenCard(), 'session');
    ctrl.topbar.shadow.querySelector('[data-trigger="quota"]').dispatchEvent({ type: 'click' });
    assert.equal(ctrl.topbar.getOpenPanel(), 'quota');
    assert.equal(c1.getOpenCard(), null);

    c3.shadow.querySelector('[data-trigger="session"]').dispatchEvent({ type: 'click' });
    assert.equal(c3.getOpenCard(), 'session');
    assert.equal(c1.getOpenCard(), null);
    assert.equal(ctrl.topbar.getOpenPanel(), null);

    // Add 4th narrow pane near top edge of viewport (2x2 split top-right quadrant)
    const pane4 = buildSplitPaneNode(doc, { paneId: 'pane-4', cascadeId: id4, modelLabel: 'Gemini 4 Neon (High)', unfocused: true });
    pane4.footer._rect = { left: 720, top: 120, right: 1020, bottom: 144, width: 300, height: 24 };
    pane4.inputBox._rect = { left: 720, top: 60, right: 1020, bottom: 150, width: 300, height: 90 };
    doc.body.appendChild(pane4.outer);

    ctrl.refreshNow();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctrl.composers.size, 4);

    const c4 = ctrl.composers.get('pane:pane-4');
    assert.equal(c4.shadow.querySelector('[data-slot="session-tok"]').textContent, '400.1K');
    assert.equal(c4.shadow.querySelector('.agv-comp-row').getAttribute('data-fallback'), 'true');
    assert.equal(c4.host.parentElement, pane4.inputBox.parentElement);
    assert.equal(pane4.inputBox.nextSibling, c4.host);

    // Top-quadrant trigger flips popover downward instead of clipping above viewport
    const c4SessionBtn = c4.shadow.querySelector('[data-trigger="session"]');
    c4SessionBtn._rect = { left: 730, top: 120, right: 790, bottom: 144, width: 60, height: 24 };
    c4SessionBtn.dispatchEvent({ type: 'click' });
    assert.equal(c4.getOpenCard(), 'session');
    assert.equal(c3.getOpenCard(), null);
    const c4Pop = c4.shadow.querySelector('.agv-popover');
    assert.equal(c4Pop.style.top, '152px');
    assert.equal(c4Pop.style.bottom, 'auto');

    // Close pane-2 and pane-4 -> cleaned up cleanly while pane-1 & pane-3 keep intact
    pane2.outer.remove();
    pane4.outer.remove();
    ctrl.refreshNow();
    assert.equal(ctrl.composers.size, 2);
    assert.ok(ctrl.composers.has('pane:pane-1'));
    assert.ok(ctrl.composers.has('pane:pane-3'));
    assert.equal(c1.shadow.querySelector('[data-slot="session-tok"]').textContent, '100.1K');
    assert.equal(c3.shadow.querySelector('[data-slot="session-tok"]').textContent, '300.1K');
  } finally {
    ctrl.dispose();
  }
});

test('theme: detectHostTheme handles data-theme, classes, color-scheme, background luminance, and matchMedia', () => {
  assert.ok(styles.SHARED_CSS.includes(':host([data-theme="light"])'));
  assert.ok(styles.SHARED_CSS.includes('color-scheme: light'));

  // 1. data-theme attribute takes precedence
  const docAttr = {
    documentElement: new FakeElement('HTML', null),
    body: new FakeElement('BODY', null)
  };
  docAttr.documentElement.setAttribute('data-theme', 'light');
  assert.equal(styles.detectHostTheme(docAttr, {}), 'light');
  docAttr.documentElement.setAttribute('data-theme', 'dark');
  assert.equal(styles.detectHostTheme(docAttr, {}), 'dark');

  // 2. Class names (html.light / html.dark / vscode-light)
  const docCls = {
    documentElement: new FakeElement('HTML', null),
    body: new FakeElement('BODY', null)
  };
  docCls.documentElement.className = 'antigravity light';
  assert.equal(styles.detectHostTheme(docCls, {}), 'light');
  docCls.documentElement.className = 'antigravity dark';
  assert.equal(styles.detectHostTheme(docCls, {}), 'dark');
  docCls.documentElement.className = '';
  docCls.body.className = 'vscode-light';
  assert.equal(styles.detectHostTheme(docCls, {}), 'light');

  // 3. Computed color-scheme & background luminance (--background and backgroundColor)
  const docLum = {
    documentElement: new FakeElement('HTML', null),
    body: new FakeElement('BODY', null)
  };
  const winLightScheme = {
    getComputedStyle: () => ({ colorScheme: 'light', getPropertyValue: () => '' })
  };
  assert.equal(styles.detectHostTheme(docLum, winLightScheme), 'light');

  const winLightBg = {
    getComputedStyle: (el) => ({
      colorScheme: 'light dark',
      backgroundColor: el.tagName === 'BODY' ? 'rgb(248, 250, 252)' : 'rgba(0, 0, 0, 0)',
      getPropertyValue: (prop) => (prop === '--background' && el.tagName === 'HTML' ? '#ffffff' : '')
    })
  };
  assert.equal(styles.detectHostTheme(docLum, winLightBg), 'light');

  const winDarkBg = {
    getComputedStyle: () => ({
      colorScheme: '',
      backgroundColor: 'rgb(24, 26, 32)',
      getPropertyValue: () => ''
    })
  };
  assert.equal(styles.detectHostTheme(docLum, winDarkBg), 'dark');

  // 4. matchMedia fallback & default dark
  const docEmpty = {
    documentElement: new FakeElement('HTML', null),
    body: new FakeElement('BODY', null)
  };
  const winMediaLight = {
    matchMedia: (q) => ({ matches: q.includes('light') })
  };
  assert.equal(styles.detectHostTheme(docEmpty, winMediaLight), 'light');
  assert.equal(styles.detectHostTheme(docEmpty, {}), 'dark');
});

test('theme: mountController auto-detects light mode and live-syncs host theme switches', async () => {
  const { win, doc } = createFakeDom();
  doc.documentElement = new FakeElement('HTML', doc);
  doc.documentElement.className = 'light';

  let observerCb = null;
  let observerDisconnected = false;
  win.MutationObserver = class FakeMutationObserver {
    constructor(cb) {
      observerCb = cb;
    }
    observe() {}
    disconnect() {
      observerDisconnected = true;
    }
  };

  const mediaListeners = [];
  win.matchMedia = () => ({
    matches: false,
    addEventListener: (_ev, fn) => mediaListeners.push(fn),
    removeEventListener: (_ev, fn) => {
      const idx = mediaListeners.indexOf(fn);
      if (idx >= 0) mediaListeners.splice(idx, 1);
    }
  });

  const fakeApi = {
    getQuota: async () => ({
      ok: true,
      data: {
        updatedAtMs: Date.now(),
        summaryRings: {
          window5h: { remainingFraction: 0.75, percent: 75 },
          window7d: { remainingFraction: 0.5, percent: 50 }
        },
        pools: []
      }
    }),
    getToday: async () => ({ ok: true, data: { totalTokens: 1000 } }),
    getSession: async () => ({
      ok: true,
      data: {
        totalTokens: 5000,
        totalCost: { costUsd: 0.05, priced: true, hasUnpriced: false },
        main: {
          turns: 1,
          steps: 2,
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 3500,
          cacheHitRate: 0.777,
          avgTtftMs: 400,
          outputSpeedTps: 60,
          modelTimeMs: 2000,
          primaryModel: { displayName: 'Gemini 4 Neon' },
          cost: { costUsd: 0.05, priced: true },
          waterline: { usedTokens: 100000, contextLimit: 1000000, ratio: 0.1, percent: 10, level: 'green' }
        },
        subagentSummary: { totalCount: 0, runningCount: 0, hasRunning: false, badgeText: '0', items: [] }
      }
    }),
    getUsage: async () => ({
      ok: true,
      data: {
        summary: { tokens: 5000, estUsd: 0.05, dailyAvgTokens: 5000, avgPerChatTokens: 5000, activeDailyTimeMs: 60000 },
        heatmap: [{ dateKey: '2026-11-25', totalTokens: 5000, level: 3, costUsd: 0.05 }],
        byModel: [],
        topSessions: []
      }
    })
  };

  const ctrl = mount.mountController({ win, doc, api: fakeApi });
  try {
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctrl.getState().theme, 'light');
    assert.equal(ctrl.topbar.host.getAttribute('data-theme'), 'light');
    assert.equal(ctrl.composer.host.getAttribute('data-theme'), 'light');

    // Light-mode ring colors and heatmap ramp are used
    assert.ok(ctrl.topbar.shadow.querySelector('[data-slot="ring-5h"]').innerHTML.includes(styles.THEMES.light.iceBlue));
    assert.ok(ctrl.composer.shadow.querySelector('[data-slot="ctx-ring"]').innerHTML.includes(styles.THEMES.light.contextLevels.green));

    ctrl.topbar.openPanel('usage');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(ctrl.topbar.shadow.querySelector('.agv-popover').innerHTML.includes(styles.THEMES.light.heatmapRamp[3]));

    // Switch host theme from light -> dark via MutationObserver
    doc.documentElement.className = 'dark';
    assert.ok(typeof observerCb === 'function');
    observerCb();

    assert.equal(ctrl.getState().theme, 'dark');
    assert.equal(ctrl.topbar.host.getAttribute('data-theme'), 'dark');
    assert.equal(ctrl.composer.host.getAttribute('data-theme'), 'dark');
    assert.ok(ctrl.topbar.shadow.querySelector('[data-slot="ring-5h"]').innerHTML.includes(styles.THEMES.dark.iceBlue));
    assert.ok(ctrl.composer.shadow.querySelector('[data-slot="ctx-ring"]').innerHTML.includes(styles.THEMES.dark.contextLevels.green));
    assert.ok(ctrl.topbar.shadow.querySelector('.agv-popover').innerHTML.includes(styles.THEMES.dark.heatmapRamp[3]));
  } finally {
    ctrl.dispose();
  }
  assert.equal(observerDisconnected, true);
  assert.equal(mediaListeners.length, 0);
});

test('split-pane & Top Layer: pane-bounded left alignment, narrow pane fallback, popover="manual" lifecycle, and modal dialog auto-close', async () => {
  const id1 = '11111111-1111-1111-1111-111111111111';
  const id2 = '22222222-2222-2222-2222-222222222222';
  const { win, doc, pane } = createFakeDom('https://127.0.0.1:43000/');
  win.innerWidth = 1400;
  win.innerHeight = 800;
  pane.remove();

  const pane1 = buildSplitPaneNode(doc, { paneId: 'pane-1', cascadeId: id1, modelLabel: 'Gemini 4 Neon (High)', unfocused: false });
  const pane2 = buildSplitPaneNode(doc, { paneId: 'pane-2', cascadeId: id2, modelLabel: 'Gemini 4 Carbon (High)', unfocused: true });
  pane1.outer._rect = { left: 0, top: 40, right: 700, bottom: 800, width: 700, height: 760 };
  pane1.inner._rect = pane1.outer._rect;
  pane1.footer._rect = { left: 20, top: 720, right: 680, bottom: 750, width: 660, height: 30 };
  pane1.inputBox._rect = { left: 20, top: 650, right: 680, bottom: 760, width: 660, height: 110 };

  pane2.outer._rect = { left: 700, top: 40, right: 1400, bottom: 800, width: 700, height: 760 };
  pane2.inner._rect = pane2.outer._rect;
  pane2.footer._rect = { left: 720, top: 720, right: 1380, bottom: 750, width: 660, height: 30 };
  pane2.inputBox._rect = { left: 720, top: 650, right: 1380, bottom: 760, width: 660, height: 110 };

  doc.body.appendChild(pane1.outer);
  doc.body.appendChild(pane2.outer);

  const api = {
    getQuota: async () => ({ ok: true, data: { summaryRings: {}, pools: [] } }),
    getToday: async () => ({ ok: true, data: { totalTokens: 0 } }),
    getSession: async () => ({
      ok: true,
      data: {
        main: {
          turns: 1,
          steps: 2,
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 0,
          totalTokens: 1200,
          cacheHitRate: 0,
          avgTtftMs: 500,
          outputSpeedTps: 80,
          modelTimeMs: 2500,
          waterline: { usedTokens: 10000, contextLimit: 1000000, ratio: 0.01, percent: 1, level: 'green' },
          primaryModel: { displayName: 'Gemini 4 Neon', displayNameWithEffort: 'Gemini 4 Neon (High)' },
          cost: { priced: true, costUsd: 0.01 }
        },
        totalTokens: 1200,
        totalCost: { priced: true, costUsd: 0.01, hasUnpriced: false },
        subagentSummary: {
          runningCount: 0,
          totalCount: 1,
          hasRunning: false,
          badgeText: '0/1',
          items: [
            {
              title: 'Independent Manuscript Reviewer',
              status: 'Done',
              modelDisplayName: 'Gemini 4 Carbon',
              currentContextTokens: 49200,
              waterline: { percent: 10 }
            }
          ]
        }
      }
    })
  };

  const ctrl = mount.start({ win, doc, api });
  try {
    await new Promise((r) => setTimeout(r, 20));
    const c1 = ctrl.composers.get('pane:pane-1');
    const c2 = ctrl.composers.get('pane:pane-2');
    const c1Pop = c1.shadow.querySelector('.agv-popover');
    const c2Pop = c2.shadow.querySelector('.agv-popover');
    const topPop = ctrl.topbar.shadow.querySelector('.agv-popover');

    assert.equal(c1Pop.getAttribute('popover'), 'manual');
    assert.equal(c2Pop.getAttribute('popover'), 'manual');
    assert.equal(topPop.getAttribute('popover'), 'manual');

    // 1a. Left pane trigger with room [320, 366] pure left-aligns inside left pane (320 + 288 = 608 <= 692)
    const c1SubBtn = c1.shadow.querySelector('[data-trigger="subagents"]');
    c1SubBtn._rect = { left: 320, top: 720, right: 366, bottom: 744, width: 46, height: 24 };
    c1SubBtn.dispatchEvent({ type: 'click' });
    assert.equal(c1.getOpenCard(), 'subagents');
    assert.equal(c1Pop.style.left, '320px');
    assert.equal(c1Pop._popoverOpen, true);
    assert.equal(c1Pop.popoverShowCalls, 1);

    // Periodic updateSession while open does not double-call showPopover() or throw
    c1.updateSession({
      main: {
        turns: 2,
        steps: 3,
        inputTokens: 2000,
        outputTokens: 300,
        cacheReadTokens: 0,
        totalTokens: 2300,
        cacheHitRate: 0,
        avgTtftMs: 500,
        outputSpeedTps: 80,
        modelTimeMs: 3000,
        waterline: { usedTokens: 12000, contextLimit: 1000000, ratio: 0.012, percent: 1, level: 'green' },
        primaryModel: { displayName: 'Gemini 4 Neon', displayNameWithEffort: 'Gemini 4 Neon (High)' },
        cost: { priced: true, costUsd: 0.02 }
      },
      totalTokens: 2300,
      totalCost: { priced: true, costUsd: 0.02, hasUnpriced: false },
      subagentSummary: { runningCount: 0, totalCount: 1, hasRunning: false, badgeText: '0/1', items: [] }
    });
    assert.equal(c1Pop.popoverShowCalls, 1);
    assert.equal(c1Pop._popoverOpen, true);

    // 1b. Left pane Subagents trigger near right side [523, 566] would cross 700 -> clamps to 700 - 288 - 8 = 404px
    c1SubBtn._rect = { left: 523, top: 720, right: 566, bottom: 744, width: 43, height: 24 };
    c1.reposition();
    assert.equal(c1Pop.style.left, '404px');

    // 1c. Right pane trigger [740, 780] pure left-aligns at 740px; near right edge [1223, 1266] clamps to 1400 - 288 - 8 = 1104px
    const c2SubBtn = c2.shadow.querySelector('[data-trigger="subagents"]');
    c2SubBtn._rect = { left: 740, top: 720, right: 780, bottom: 744, width: 40, height: 24 };
    c2SubBtn.dispatchEvent({ type: 'click' });
    assert.equal(c1.getOpenCard(), null);
    assert.equal(c1Pop._popoverOpen, false);
    assert.equal(c1Pop.popoverHideCalls, 1);
    assert.equal(c2.getOpenCard(), 'subagents');
    assert.equal(c2Pop.style.left, '740px');
    assert.equal(c2Pop._popoverOpen, true);

    c2SubBtn._rect = { left: 1223, top: 720, right: 1266, bottom: 744, width: 43, height: 24 };
    c2.reposition();
    assert.equal(c2Pop.style.left, '1104px');

    // 2. Ultra-narrow pane (<304px): centers over pane and clamps within viewport while staying in Top Layer
    pane1.outer._rect = { left: 0, top: 40, right: 260, bottom: 800, width: 260, height: 760 };
    pane1.inner._rect = pane1.outer._rect;
    pane1.footer._rect = { left: 10, top: 720, right: 250, bottom: 750, width: 240, height: 30 };
    pane1.inputBox._rect = { left: 10, top: 650, right: 250, bottom: 760, width: 240, height: 110 };
    c1SubBtn._rect = { left: 180, top: 720, right: 220, bottom: 744, width: 40, height: 24 };
    c1SubBtn.dispatchEvent({ type: 'click' });
    assert.equal(c1Pop.style.left, '8px');
    assert.equal(c1Pop._popoverOpen, true);

    // Re-parenting into <340px fallback row while open re-promotes popover to Top Layer
    const showCallsBeforeReparent = c1Pop.popoverShowCalls;
    ctrl.refreshNow();
    assert.equal(c1.host.parentElement, pane1.inputBox.parentElement);
    assert.equal(c1Pop._popoverOpen, true);
    assert.equal(c1Pop.popoverShowCalls, showCallsBeforeReparent + 1);

    // Ultra-narrow pane in middle/right [700, 960] centers at (700+960-288)/2 = 686px
    pane2.outer._rect = { left: 700, top: 40, right: 960, bottom: 800, width: 260, height: 760 };
    pane2.inner._rect = pane2.outer._rect;
    pane2.footer._rect = { left: 710, top: 720, right: 950, bottom: 750, width: 240, height: 30 };
    pane2.inputBox._rect = { left: 710, top: 650, right: 950, bottom: 760, width: 240, height: 110 };
    c2SubBtn._rect = { left: 880, top: 720, right: 920, bottom: 744, width: 40, height: 24 };
    c2SubBtn.dispatchEvent({ type: 'click' });
    assert.equal(c2Pop.style.left, '686px');
    assert.equal(c2Pop._popoverOpen, true);

    // 3. Topbar popover uses Top Layer lifecycle and closes on hide
    const quotaBtn = ctrl.topbar.shadow.querySelector('[data-trigger="quota"]');
    quotaBtn._rect = { left: 180, top: 8, right: 260, bottom: 34, width: 80, height: 26 };
    quotaBtn.dispatchEvent({ type: 'click' });
    assert.equal(ctrl.topbar.getOpenPanel(), 'quota');
    assert.equal(c2.getOpenCard(), null);
    assert.equal(c2Pop._popoverOpen, false);
    assert.equal(topPop._popoverOpen, true);
    assert.equal(topPop.popoverShowCalls, 1);

    // 4. Focusin on regular chat input does NOT close open popover; focusin inside [role="dialog"] closes it
    const regularInput = doc.createElement('textarea');
    pane1.inputBox.appendChild(regularInput);
    doc.dispatchEvent({ type: 'focusin', target: regularInput });
    assert.equal(ctrl.topbar.getOpenPanel(), 'quota');
    assert.equal(topPop._popoverOpen, true);

    const modalDialog = doc.createElement('div');
    modalDialog.setAttribute('role', 'dialog');
    const modalInput = doc.createElement('input');
    modalDialog.appendChild(modalInput);
    doc.body.appendChild(modalDialog);
    doc.dispatchEvent({ type: 'focusin', target: modalInput });
    assert.equal(ctrl.topbar.getOpenPanel(), null);
    assert.equal(topPop._popoverOpen, false);
    assert.equal(topPop.popoverHideCalls, 1);
  } finally {
    ctrl.dispose();
  }

  // Standalone disconnected createComposerBar opens without throwing InvalidStateError
  const { win: w2, doc: d2 } = createFakeDom();
  const standalone = composerBar.createComposerBar({ doc: d2, win: w2 });
  try {
    standalone.openCard('subagents');
    assert.equal(standalone.getOpenCard(), 'subagents');
    assert.equal(standalone.shadow.querySelector('.agv-popover')._popoverOpen, false);
  } finally {
    standalone.dispose();
  }
});


test('mount: coalesces resize via requestAnimationFrame, cancels on dispose, and deduplicates nav microtasks', async () => {
  const { win, doc } = createFakeDom('https://127.0.0.1:43000/');
  const winListeners = new Map();
  const navListeners = new Map();
  const rafQueue = new Map();
  let rafSeq = 1;
  let cancelledIds = [];

  win.addEventListener = (t, fn) => {
    const arr = winListeners.get(t) || [];
    arr.push(fn);
    winListeners.set(t, arr);
  };
  win.removeEventListener = (t, fn) => {
    winListeners.set(t, (winListeners.get(t) || []).filter((f) => f !== fn));
  };
  win.requestAnimationFrame = (fn) => {
    const id = rafSeq++;
    rafQueue.set(id, fn);
    return id;
  };
  win.cancelAnimationFrame = (id) => {
    cancelledIds.push(id);
    rafQueue.delete(id);
  };
  win.navigation = {
    addEventListener(t, fn) {
      const arr = navListeners.get(t) || [];
      arr.push(fn);
      navListeners.set(t, arr);
    },
    removeEventListener(t, fn) {
      navListeners.set(t, (navListeners.get(t) || []).filter((f) => f !== fn));
    }
  };

  let queryAllCalls = 0;
  const origQueryAll = doc.querySelectorAll.bind(doc);
  doc.querySelectorAll = (sel) => {
    queryAllCalls++;
    return origQueryAll(sel);
  };

  const ctrl = mount.start({
    win,
    doc,
    api: {
      getQuota: async () => ({ ok: false }),
      getToday: async () => ({ ok: true, data: { totalTokens: 0 } }),
      getSession: async () => ({ ok: false })
    }
  });

  try {
    // 1. Multiple resize events in one frame coalesce into a single syncAll
    queryAllCalls = 0;
    for (let i = 0; i < 10; i++) {
      for (const fn of winListeners.get('resize') || []) fn();
    }
    assert.equal(queryAllCalls, 0);
    assert.equal(rafQueue.size, 1);
    const [pendingId, pendingFn] = rafQueue.entries().next().value;
    rafQueue.delete(pendingId);
    pendingFn(16);
    assert.equal(queryAllCalls, 1);

    // 2. Navigation currententrychange runs only 1 syncAll in microtask (not 2)
    queryAllCalls = 0;
    win.location.href = 'https://127.0.0.1:43000/c/55555555-5555-5555-5555-555555555555';
    for (const fn of navListeners.get('currententrychange') || []) fn();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(queryAllCalls, 1);

    // 3. Pending rAF resize callback is cancelled on dispose()
    for (const fn of winListeners.get('resize') || []) fn();
    assert.equal(rafQueue.size, 1);
    const queuedId = rafQueue.keys().next().value;
    ctrl.dispose();
    assert.ok(cancelledIds.includes(queuedId));
    assert.equal(rafQueue.size, 0);
  } finally {
    ctrl.dispose();
  }
});

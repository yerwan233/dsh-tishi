/**
 * DOM 冒烟：用迷你 DOM + 带 hooks/effects 的迷你 React，在 Node 里跑真实路径：
 *   控制器渲染 → effect 扫描侧栏行 → 插入/更新/隐藏/移除角标 → 卸载清理。
 *
 * 覆盖：
 *   ① 角标插在 folder 图标前（行首子元素），指针事件由 CSS 放行；
 *   ② 三种状态可同时出现、计数 >1 才显示数字、0 项隐藏、整块 total=0 隐藏；
 *   ③ 数据变化后重渲染即更新；1s 轮询能发现新行；click 捕获会安排一次补同步；
 *   ④ expanded 策略（常量 true / 覆盖 false）符合预期；
 *   ⑤ 隐藏工作区：标题行 / 自己的会话 / overflow 隐藏，嵌套子工作区保留；
 *      菜单动作可恢复、状态写 localStorage、卸载后恢复完整侧栏；
 *   ⑥ 行消失后文档里没有遗留角标；卸载清 interval、监听、样式和所有角标。
 *
 * 用法：node tools/status-badges-smoke.mjs（成功打印 SMOKE OK；失败退出码 1）
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  console.log(`PASS ${label}`);
}

// ---------------------------------------------------------------- 迷你 DOM

/**
 * 只实现本插件用到的 DOM 子集：属性、子节点、style、insertBefore/removeChild、
 * querySelector(All)。选择器写死成白名单，出现新选择器就立即报错（契约守卫）。
 */
class FakeNode {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.id = '';
    // 面板栏装饰用到的宿主属性 / 监听：真实 DOM 里 clientWidth 由布局给出。
    this.clientWidth = 240;
    this.clientHeight = 0;
    this.listeners = [];
  }

  get firstChild() {
    return this.children.length > 0 ? this.children[0] : null;
  }

  get parentElement() {
    return this.parentNode !== null && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get previousElementSibling() {
    const parent = this.parentNode;
    if (parent === null) return null;
    const index = parent.children.indexOf(this);
    return index > 0 ? parent.children[index - 1] : null;
  }

  get nextElementSibling() {
    const parent = this.parentNode;
    if (parent === null) return null;
    const index = parent.children.indexOf(this);
    return index !== -1 && index + 1 < parent.children.length ? parent.children[index + 1] : null;
  }

  addEventListener(type, fn) {
    this.listeners.push({ type, fn });
  }

  removeEventListener(type, fn) {
    const index = this.listeners.findIndex((item) => item.type === type && item.fn === fn);
    if (index !== -1) this.listeners.splice(index, 1);
  }

  /** 测试触发：模拟一次真实点击。 */
  click() {
    const handler = this.listeners.find((item) => item.type === 'click');
    if (handler !== undefined) handler.fn({ preventDefault() {}, stopPropagation() {} });
    else if (typeof this.onclick === 'function') this.onclick({});
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    const key = String(name);
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  appendChild(child) {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    if (reference === null || reference === undefined) return this.appendChild(child);
    const index = this.children.indexOf(reference);
    if (index === -1) return this.appendChild(child);
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  querySelector(selector) {
    const found = this.ownerDocument.collect(selector, this);
    return found.length > 0 ? found[0] : null;
  }

  querySelectorAll(selector) {
    return this.ownerDocument.collect(selector, this);
  }
}

/** 白名单选择器匹配。 */
function matches(node, selector) {
  if (node === null || node === undefined || typeof node.getAttribute !== 'function') return false;
  if (selector === '[data-dsh-tishi-status]') return node.hasAttribute('data-dsh-tishi-status');
  if (selector === '[data-dsh-tishi-hidden]') return node.hasAttribute('data-dsh-tishi-hidden');
  if (selector === '[data-row-key^="workspace:"]') {
    const key = node.getAttribute('data-row-key');
    return typeof key === 'string' && key.startsWith('workspace:');
  }
  if (selector === '[data-row-key^="session:"]') {
    const key = node.getAttribute('data-row-key');
    return typeof key === 'string' && key.startsWith('session:');
  }
  if (selector === '[data-row-key^="overflow:"]') {
    const key = node.getAttribute('data-row-key');
    return typeof key === 'string' && key.startsWith('overflow:');
  }
  if (selector === 'style[data-plugin="dsh-tishi"]') {
    return node.tagName === 'STYLE' && node.getAttribute('data-plugin') === 'dsh-tishi';
  }
  if (selector === 'nav') return node.tagName === 'NAV';
  if (selector === 'button') return node.tagName === 'BUTTON';
  if (selector === '[data-dsh-tishi-panel-nav]') return node.hasAttribute('data-dsh-tishi-panel-nav');
  if (selector === '[data-dsh-tishi-panels-collapsed]') return node.hasAttribute('data-dsh-tishi-panels-collapsed');
  if (selector === '[data-dsh-tishi-panel-toggle]') return node.hasAttribute('data-dsh-tishi-panel-toggle');
  if (selector === '[data-dsh-tishi-panel-control]') return node.hasAttribute('data-dsh-tishi-panel-control');
  if (selector === '[data-dsh-tishi-panel-keep]') return node.hasAttribute('data-dsh-tishi-panel-keep');
  if (selector === '[data-dsh-tishi-panel-sort-panel]') return node.hasAttribute('data-dsh-tishi-panel-sort-panel');
  if (selector === '[data-dsh-tishi-panel-sort-row]') return node.hasAttribute('data-dsh-tishi-panel-sort-row');
  if (selector === '[data-dsh-tishi-panel-handle]') return node.hasAttribute('data-dsh-tishi-panel-handle');
  if (selector === '[data-dsh-tishi-panel-menu]') return node.hasAttribute('data-dsh-tishi-panel-menu');
  if (selector === '[data-dsh-tishi-panel-menu-panel]') return node.hasAttribute('data-dsh-tishi-panel-menu-panel');
  if (selector === '[data-dsh-tishi-panel-menu-item]') return node.hasAttribute('data-dsh-tishi-panel-menu-item');
  if (selector === '[data-dsh-tishi-hide-new-session]') return node.hasAttribute('data-dsh-tishi-hide-new-session');
  if (selector.startsWith('#')) {
    const id = selector.slice(1);
    return node.id === id || node.getAttribute('id') === id;
  }
  throw new Error(`fake DOM: unsupported selector ${selector}`);
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeNode(this, 'html');
    this.head = new FakeNode(this, 'head');
    this.body = new FakeNode(this, 'body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.listeners = [];
  }

  createElement(tag) {
    return new FakeNode(this, tag);
  }

  getElementById(id) {
    const found = this.collect('#' + id, this.documentElement);
    return found.length > 0 ? found[0] : null;
  }

  querySelector(selector) {
    const found = this.collect(selector, this.documentElement);
    return found.length > 0 ? found[0] : null;
  }

  querySelectorAll(selector) {
    return this.collect(selector, this.documentElement);
  }

  collect(selector, scope) {
    const found = [];
    const visit = (node) => {
      if (matches(node, selector)) found.push(node);
      for (const child of node.children) visit(child);
    };
    visit(scope);
    return found;
  }

  addEventListener(type, fn, capture) {
    this.listeners.push({ type, fn, capture });
  }

  removeEventListener(type, fn, capture) {
    const index = this.listeners.findIndex((item) => item.type === type && item.fn === fn && item.capture === capture);
    if (index !== -1) this.listeners.splice(index, 1);
  }
}

// ------------------------------------------------------ 计时器 / React 桩

const intervals = [];
const timeouts = [];
globalThis.setInterval = (fn, ms) => {
  intervals.push({ fn, ms, cleared: false });
  return intervals.length;
};
globalThis.clearInterval = (id) => {
  const item = intervals[id - 1];
  if (item !== undefined) item.cleared = true;
};
globalThis.setTimeout = (fn, ms) => {
  timeouts.push({ fn, ms, cleared: false, fired: false });
  return timeouts.length;
};
globalThis.clearTimeout = (id) => {
  const item = timeouts[id - 1];
  if (item !== undefined) item.cleared = true;
};
function runTimeout(id) {
  const item = timeouts[id - 1];
  if (item === undefined || item.fired) return;
  item.fired = true;
  item.fn();
}

let hookState = [];
let effectMeta = [];
let hookIndex = 0;
let pendingEffects = [];
const cleanups = [];
const React = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children };
  },
  useState(initial) {
    const index = hookIndex++;
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial;
    const set = (value) => {
      const next = typeof value === 'function' ? value(hookState[index]) : value;
      if (next !== hookState[index]) {
        hookState[index] = next;
        renderCount += 1;
      }
    };
    return [hookState[index], set];
  },
  useRef(initial) {
    const index = hookIndex++;
    if (!(index in hookState)) hookState[index] = { current: initial };
    return hookState[index];
  },
  useEffect(fn, deps) {
    const index = hookIndex++;
    const previous = effectMeta[index];
    const changed =
      previous === undefined ||
      deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((dep, i) => dep !== previous.deps[i]);
    effectMeta[index] = { deps: deps === undefined ? null : deps };
    if (changed) pendingEffects.push(fn);
  },
};
let renderCount = 0;

function render(props) {
  hookIndex = 0;
  pendingEffects = [];
  const tree = TEST.StatusBadgeController(props);
  for (const fn of pendingEffects) {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
  renderCount += 1;
  return tree;
}

// ---------------------------------------------------------------- 夹具

const doc = new FakeDocument();
globalThis.document = doc;

globalThis.__DSH_TISHI_TEST__ = {};
let captured = null;
const storageData = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition;
    },
  },
  localStorage: {
    getItem(key) {
      return storageData.has(key) ? storageData.get(key) : null;
    },
    setItem(key, value) {
      storageData.set(key, String(value));
    },
    removeItem(key) {
      storageData.delete(key);
    },
  },
};
await import(pathToFileURL(path.join(root, 'client.js')).href);
const TEST = globalThis.__DSH_TISHI_TEST__;
const plugin = captured.factory(() => React);
assert.equal(plugin.name, 'dsh-tishi');

function addRow(workspaceId, expanded) {
  const row = doc.createElement('div');
  row.setAttribute('data-row-key', 'workspace:' + workspaceId);
  row.setAttribute('aria-expanded', expanded === false ? 'false' : 'true');
  const folder = doc.createElement('span');
  folder.className = 'folder';
  row.appendChild(folder);
  const title = doc.createElement('span');
  title.className = 'title';
  title.textContent = workspaceId;
  row.appendChild(title);
  doc.body.appendChild(row);
  return row;
}

/** 分组夹具：groupSection > workspace 行、自己的会话行、可选的嵌套子分组、overflow 行。 */
function addGroup(workspaceId, options) {
  const config = options !== null && typeof options === 'object' ? options : {};
  const section = doc.createElement('div');
  section.className = 'groupSection';
  const header = doc.createElement('div');
  header.setAttribute('data-row-key', 'workspace:' + workspaceId);
  header.setAttribute('aria-expanded', 'true');
  section.appendChild(header);
  const sessions = new Map();
  const sessionIds = Array.isArray(config.sessions) ? config.sessions : [];
  for (const sessionId of sessionIds) {
    const row = doc.createElement('div');
    row.setAttribute('data-row-key', 'session:' + sessionId);
    section.appendChild(row);
    sessions.set(sessionId, row);
  }
  const child = config.child !== undefined ? addGroup(config.child.workspaceId, config.child) : null;
  if (child !== null) section.appendChild(child.section);
  let overflow = null;
  if (config.overflow === true || sessionIds.length > 0) {
    overflow = doc.createElement('div');
    overflow.setAttribute('data-row-key', 'overflow:' + workspaceId);
    section.appendChild(overflow);
  }
  doc.body.appendChild(section);
  return { section, header, sessions, overflow, child };
}

function badgeOf(row) {
  return row === null || row === undefined ? null : row.querySelector('[' + TEST.BADGE_ATTR + ']');
}

function itemOf(badge, key) {
  return badge.children.find((child) => String(child.className).split(' ').includes('is-' + key));
}

function countOf(badge, key) {
  return itemOf(badge, key).children[1];
}

const row1 = addRow('w1');
const row2 = addRow('w2');
const row3 = addRow('w3', false);

const snapshot = {
  items: [
    { workspaceId: 'w1', sessionIds: ['s1', 's2', 's3', 's4'] },
    { workspaceId: 'w2', sessionIds: ['s5'] },
    { workspaceId: 'w3', sessionIds: ['s6'] },
    { workspaceId: '', sessionIds: ['s9'] },
  ],
  archivedSessionIds: ['s9'],
};
const statuses = new Map([
  ['s1', { pendingInteraction: { kind: 'approval' } }],
  ['s2', { running: true }],
  ['s3', { completionUnread: true }],
  ['s4', {}],
  ['s5', { running: true }],
  ['s6', { completionUnread: false }],
  ['s9', { running: true }],
]);
const sessionList = { ids: ['s1', 's2', 's3', 's4', 's5', 's6'], byId: {} };
const props = {
  useWorkspaces: (selector) => selector(snapshot),
  useSessions: () => sessionList,
  useSessionStatus: () => statuses,
};

// ---------------------------------------------------------------- 主路径

let tree = render(props);
check('控制器返回 null，不渲染可见 UI', () => {
  assert.equal(tree, null);
});

check('角标插在 folder 图标前（行首子元素）', () => {
  const badge = badgeOf(row1);
  assert.ok(badge !== null, 'w1 没有角标');
  assert.equal(row1.children[0], badge);
  assert.equal(row1.children[1].className, 'folder');
  assert.equal(badge.getAttribute(TEST.BADGE_ATTR), '');
  assert.equal(badge.getAttribute('aria-hidden'), 'false');
});

check('三种状态可同时出现，顺序 pending→running→done', () => {
  const badge = badgeOf(row1);
  assert.deepEqual(badge.children.map((child) => child.className), [
    'dsh-tishi-item is-pending',
    'dsh-tishi-item is-running',
    'dsh-tishi-item is-done',
  ]);
  assert.equal(badge.getAttribute('aria-label'), '待处理 1 · 运行中 1 · 未读完成 1');
  for (const key of ['pending', 'running', 'done']) {
    assert.notEqual(itemOf(badge, key).style.display, 'none', `${key} 应可见`);
  }
});

check('计数 = 1 时不显示数字', () => {
  const badge = badgeOf(row1);
  for (const key of ['pending', 'running', 'done']) assert.equal(countOf(badge, key).textContent, '');
});

check('只有运行中的工作区只显示一项，0 项隐藏', () => {
  const badge = badgeOf(row2);
  assert.notEqual(itemOf(badge, 'running').style.display, 'none');
  assert.equal(itemOf(badge, 'pending').style.display, 'none');
  assert.equal(itemOf(badge, 'done').style.display, 'none');
  assert.equal(badge.getAttribute('aria-label'), '运行中 1');
});

check('无活动的工作区整块隐藏（total=0）', () => {
  const badge = badgeOf(row3);
  assert.ok(badge !== null, 'idle 行也应保留（隐藏的）角标节点');
  assert.equal(badge.style.display, 'none');
  assert.equal(badge.getAttribute('aria-hidden'), 'true');
});

check('计数 >1 时显示数字', () => {
  statuses.set('s4', { running: true });
  statuses.delete('s1');
  render(props);
  const badge = badgeOf(row1);
  assert.equal(countOf(badge, 'running').textContent, '2');
  assert.equal(itemOf(badge, 'pending').style.display, 'none');
  assert.equal(badge.getAttribute('aria-label'), '运行中 2 · 未读完成 1');
});

check('样式表只注入一次，带 data-plugin 标记', () => {
  const styles = doc.querySelectorAll('style[data-plugin="dsh-tishi"]');
  assert.equal(styles.length, 1);
  assert.equal(styles[0].getAttribute('data-plugin-css'), 'dsh-tishi/status.css');
  assert.ok(styles[0].textContent.includes('--dsw-alias-state-warn-primary'));
  render(props);
  assert.equal(doc.querySelectorAll('style[data-plugin="dsh-tishi"]').length, 1);
});

// -------------------------------------------------------------- 补同步路径

check('1s 轮询能发现新工作区行', () => {
  assert.equal(intervals.length, 1);
  const row4 = addRow('w4');
  assert.equal(badgeOf(row4), null);
  intervals[0].fn();
  assert.ok(badgeOf(row4) !== null, '轮询后新行应有角标节点');
});

check('click 捕获会安排一次 setTimeout 补同步', () => {
  const row5 = addRow('w5');
  const before = timeouts.length;
  const listener = doc.listeners.find((item) => item.type === 'click' && item.capture === true);
  assert.ok(listener !== undefined, '没有 click 捕获监听');
  listener.fn({});
  assert.equal(timeouts.length, before + 1);
  runTimeout(timeouts.length);
  assert.ok(badgeOf(row5) !== null, '补同步后新行应有角标节点');
});

check('expanded 策略：常量 true 时折叠/展开都显示', () => {
  assert.equal(TEST.SHOW_WHEN_EXPANDED, true);
  statuses.set('s6', { completionUnread: true });
  render(props);
  const expandedBadge = badgeOf(row1);
  const collapsedBadge = badgeOf(row3);
  assert.notEqual(expandedBadge.style.display, 'none');
  assert.notEqual(collapsedBadge.style.display, 'none');
});

check('expanded 策略可覆盖为「仅折叠时显示」', () => {
  const badges = TEST.computeWorkspaceBadges(snapshot, statuses, sessionList);
  const result = TEST.syncBadges(doc, badges, { showWhenExpanded: false });
  assert.ok(result.rows >= 3);
  assert.equal(badgeOf(row1), null, '展开行应移除角标');
  assert.ok(badgeOf(row3) !== null, '折叠行应保留角标');
  assert.notEqual(badgeOf(row3).style.display, 'none');
  TEST.syncBadges(doc, badges, { showWhenExpanded: true });
  assert.ok(badgeOf(row1) !== null, '恢复策略后展开行应重新出现角标');
});

check('折叠父工作区：子行不在 DOM 时父行仍显示后代活动', () => {
  const doc2 = new FakeDocument();
  const parentRow = doc2.createElement('div');
  parentRow.setAttribute('data-row-key', 'workspace:parent');
  parentRow.setAttribute('aria-expanded', 'false');
  const folder = doc2.createElement('span');
  folder.className = 'folder';
  parentRow.appendChild(folder);
  doc2.body.appendChild(parentRow);

  const snapshot2 = {
    items: [
      { workspaceId: 'parent', path: 'D:/QAQ/dsh_plugins', sessionIds: [] },
      { workspaceId: 'child', path: 'D:/QAQ/dsh_plugins/dsh_tishi', sessionIds: ['s1'] },
    ],
  };
  const badges = TEST.computeWorkspaceBadges(snapshot2, new Map([['s1', { running: true }]]), { byId: {} });
  const result = TEST.syncBadges(doc2, badges, { showWhenExpanded: true });
  const badge = badgeOf(parentRow);
  assert.equal(result.rows, 1);
  assert.ok(badge !== null, '折叠父行应有角标');
  assert.notEqual(badge.style.display, 'none');
  assert.equal(badge.getAttribute('aria-label'), '运行中 1');
});

check('父子行同时在 DOM：父角标含自身+子，子角标只含自身', () => {
  const doc2 = new FakeDocument();
  const makeRow = (workspaceId, expanded) => {
    const row = doc2.createElement('div');
    row.setAttribute('data-row-key', 'workspace:' + workspaceId);
    row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const folder = doc2.createElement('span');
    folder.className = 'folder';
    row.appendChild(folder);
    doc2.body.appendChild(row);
    return row;
  };
  const parentRow = makeRow('parent', true);
  const childRow = makeRow('child', true);

  const snapshot2 = {
    items: [
      { workspaceId: 'parent', path: 'D:/QAQ/dsh_plugins', sessionIds: ['p1'] },
      { workspaceId: 'child', path: 'D:/QAQ/dsh_plugins/dsh_tishi', sessionIds: ['c1'] },
    ],
  };
  const statuses2 = new Map([
    ['p1', { running: true }],
    ['c1', { running: true }],
  ]);
  const badges = TEST.computeWorkspaceBadges(snapshot2, statuses2, { byId: {} });
  const result = TEST.syncBadges(doc2, badges, { showWhenExpanded: true });
  assert.equal(result.rows, 2);
  assert.equal(badgeOf(parentRow).getAttribute('aria-label'), '运行中 2');
  assert.equal(badgeOf(childRow).getAttribute('aria-label'), '运行中 1');
});

// ---------------------------------------------------------- 隐藏工作区（DOM）

const g1 = addGroup('g1', {
  sessions: ['gs1', 'gs1b'],
  child: { workspaceId: 'g1c', sessions: ['gs1c'] },
});
const g2 = addGroup('g2', { sessions: ['gs2'] });
snapshot.items.push(
  { workspaceId: 'g1', title: 'G1', path: 'D:\\G1', sessionIds: ['gs1', 'gs1b'] },
  { workspaceId: 'g1c', title: 'G1C', path: 'D:\\G1\\child', sessionIds: ['gs1c'] },
  { workspaceId: 'g2', title: 'G2', path: 'D:\\G2', sessionIds: ['gs2'] },
);

check('隐藏工作区：标题行/会话/overflow 隐藏，嵌套子工作区保留', () => {
  TEST.setHiddenIds(new Set());
  render(props);
  assert.equal(TEST.hideWorkspace('g1', 'G1'), true);
  for (const node of [g1.header, g1.sessions.get('gs1'), g1.sessions.get('gs1b'), g1.overflow]) {
    assert.ok(node.hasAttribute(TEST.HIDDEN_ATTR), '应带上隐藏标记');
  }
  assert.equal(g1.section.hasAttribute(TEST.HIDDEN_ATTR), false, '只藏行，不藏整段容器');
  assert.equal(g2.header.hasAttribute(TEST.HIDDEN_ATTR), false);
  assert.equal(g2.sessions.get('gs2').hasAttribute(TEST.HIDDEN_ATTR), false);
  // 嵌套子工作区是独立工作区：父隐藏不波及。
  assert.equal(g1.child.header.hasAttribute(TEST.HIDDEN_ATTR), false);
  assert.equal(g1.child.sessions.get('gs1c').hasAttribute(TEST.HIDDEN_ATTR), false);
  assert.match(storageData.get(TEST.HIDDEN_STORAGE_KEY), /g1/);
});

check('显示 / 全部显示：DOM 隐藏标记被移除', () => {
  assert.equal(TEST.showWorkspace('g1'), true);
  for (const node of [g1.header, g1.sessions.get('gs1'), g1.sessions.get('gs1b'), g1.overflow]) {
    assert.equal(node.hasAttribute(TEST.HIDDEN_ATTR), false);
  }
  TEST.setHiddenIds(new Set(['g1', 'g2']));
  render(props);
  assert.ok(g1.header.hasAttribute(TEST.HIDDEN_ATTR));
  assert.ok(g2.header.hasAttribute(TEST.HIDDEN_ATTR));
  assert.equal(TEST.showAllWorkspaces(), true);
  for (const node of [g1.header, g2.header, g2.sessions.get('gs2')]) {
    assert.equal(node.hasAttribute(TEST.HIDDEN_ATTR), false);
  }
});

check('菜单 resolve 集成：从 g2 菜单恢复 g1', () => {
  assert.equal(TEST.hideWorkspace('g1', 'G1'), true);
  const actions = TEST.resolveWorkspaceMenu({ workspaceId: 'g2', displayTitle: 'G2' });
  assert.equal(actions[0].id, 'hide');
  const manage = actions.find((action) => action.id === 'manage');
  assert.ok(manage !== undefined, '应有管理子菜单');
  const restore = manage.children.find((action) => action.id === 'show:g1');
  assert.ok(restore !== undefined, '子菜单应列出 g1');
  assert.equal(restore.run(), true);
  assert.equal(g1.header.hasAttribute(TEST.HIDDEN_ATTR), false);
  assert.equal(g1.sessions.get('gs1').hasAttribute(TEST.HIDDEN_ATTR), false);
});

check('隐藏标记被 React 重建清掉后，1s 轮询会补回来', () => {
  assert.equal(TEST.hideWorkspace('g1', 'G1'), true);
  g1.header.removeAttribute(TEST.HIDDEN_ATTR);
  g1.sessions.get('gs1').removeAttribute(TEST.HIDDEN_ATTR);
  intervals[0].fn();
  assert.ok(g1.header.hasAttribute(TEST.HIDDEN_ATTR));
  assert.ok(g1.sessions.get('gs1').hasAttribute(TEST.HIDDEN_ATTR));
});

check('click 捕获补同步同样恢复隐藏标记', () => {
  g1.header.removeAttribute(TEST.HIDDEN_ATTR);
  const listener = doc.listeners.find((item) => item.type === 'click' && item.capture === true);
  assert.ok(listener !== undefined);
  listener.fn({});
  runTimeout(timeouts.length);
  assert.ok(g1.header.hasAttribute(TEST.HIDDEN_ATTR));
});

check('没有分组容器的会话行（平铺 / 门户）不会被隐藏', () => {
  const doc2 = new FakeDocument();
  const header = doc2.createElement('div');
  header.setAttribute('data-row-key', 'workspace:p1');
  doc2.body.appendChild(header);
  const flat = doc2.createElement('div');
  flat.setAttribute('data-row-key', 'session:flat1');
  doc2.body.appendChild(flat);
  const result = TEST.syncHiddenRows(doc2, new Set(['p1']));
  assert.equal(header.hasAttribute(TEST.HIDDEN_ATTR), true);
  assert.equal(flat.hasAttribute(TEST.HIDDEN_ATTR), false);
  assert.equal(result.sessions, 0);
});

// ---------------------------------------------------------------- 清理路径

check('行从 DOM 消失后，文档里不再有它的角标', () => {
  const row6 = addRow('w6');
  TEST.syncBadges(doc, new Map([['w6', { pending: 1, running: 0, done: 0, total: 1 }]]), {});
  assert.ok(badgeOf(row6) !== null);
  const badge = badgeOf(row6);
  doc.body.removeChild(row6);
  const visible = doc.querySelectorAll('[' + TEST.BADGE_ATTR + ']');
  assert.equal(visible.includes(badge), false);
  TEST.syncBadges(doc, new Map(), {});
});

check('快速连续 click 会累积补同步 timer（句柄不丢）', () => {
  const listener = doc.listeners.find((item) => item.type === 'click' && item.capture === true);
  assert.ok(listener !== undefined);
  for (let i = 0; i < 12; i += 1) listener.fn({});
  assert.ok(timeouts.filter((item) => !item.fired).length >= 12);
});

check('卸载清理：角标、隐藏标记、样式、interval、监听、待执行 timer 全清', () => {
  const pendingListener = doc.listeners.length;
  assert.ok(pendingListener > 0);
  assert.ok(g1.header.hasAttribute(TEST.HIDDEN_ATTR), '卸载前应有隐藏标记（便于验证清理）');
  for (const cleanup of cleanups) cleanup();
  assert.equal(doc.querySelectorAll('[' + TEST.BADGE_ATTR + ']').length, 0);
  assert.equal(doc.querySelectorAll('[data-dsh-tishi-hidden]').length, 0, '隐藏标记未恢复');
  assert.equal(doc.getElementById('dsh-tishi-status-style'), null);
  assert.ok(intervals.every((item) => item.cleared), 'interval 未清理');
  assert.equal(doc.listeners.length, 0, 'click 监听未移除');
  assert.equal(timeouts.filter((item) => !item.fired && !item.cleared).length, 0, '待执行 timeout 未清理');
});

check('卸载后迟到的补同步回调不会复活角标（竞态守卫）', () => {
  // 模拟「clearTimeout 之前已进入任务队列」：手动调用所有未触发的旧 timer。
  const late = timeouts.filter((item) => !item.fired);
  assert.ok(late.length >= 12, `应有快速点击留下的 timer，实际 ${late.length}`);
  for (const item of late) {
    item.fired = true;
    item.fn();
  }
  assert.equal(doc.querySelectorAll('[' + TEST.BADGE_ATTR + ']').length, 0, '角标被迟到回调复活');
  assert.equal(doc.getElementById('dsh-tishi-status-style'), null, '样式被迟到回调重建');
});

// --------------------------------------------------------------- 契约守卫

check('findBadge 只认本行直属角标，不搬走后代节点', () => {
  const doc3 = new FakeDocument();
  const outer = doc3.createElement('div');
  outer.setAttribute('data-row-key', 'workspace:w9');
  const inner = doc3.createElement('div');
  const foreign = doc3.createElement('span');
  foreign.setAttribute(TEST.BADGE_ATTR, '');
  inner.appendChild(foreign);
  outer.appendChild(inner);
  doc3.body.appendChild(outer);
  assert.equal(TEST.findBadge(outer), null);
  TEST.syncBadges(doc3, new Map([['w9', { pending: 0, running: 1, done: 0, total: 1 }]]), {});
  assert.equal(inner.children.includes(foreign), true, '不应搬走后代角标');
  const own = TEST.findBadge(outer);
  assert.ok(own !== null && own !== foreign);
  assert.equal(outer.children[0], own);
});

check('只装饰 workspace: 行：session 行/空 key 被跳过', () => {
  const doc2 = new FakeDocument();
  const sessionRow = doc2.createElement('div');
  sessionRow.setAttribute('data-row-key', 'session:x');
  const emptyWorkspace = doc2.createElement('div');
  emptyWorkspace.setAttribute('data-row-key', 'workspace:');
  doc2.body.appendChild(sessionRow);
  doc2.body.appendChild(emptyWorkspace);
  const result = TEST.syncBadges(doc2, new Map(), {});
  assert.equal(result.rows, 0);
  assert.equal(doc2.querySelectorAll('[' + TEST.BADGE_ATTR + ']').length, 0);
});

check('缺 document 时 syncBadges 静默返回', () => {
  assert.deepEqual(TEST.syncBadges(null, new Map()), { rows: 0, visible: 0, hidden: 0, removed: 0 });
  assert.deepEqual(TEST.syncBadges(undefined, new Map()), { rows: 0, visible: 0, hidden: 0, removed: 0 });
});

// ---------------------------------------------------------------- 面板栏装饰

/** 侧栏夹具：root > nav + regionArea(workspace 行)，与宿主 0.2.2 结构一致。 */
function addPanelNav(targetDoc, options) {
  const config = options !== null && typeof options === 'object' ? options : {};
  const root = targetDoc.createElement('div');
  root.className = 'root';
  const nav = targetDoc.createElement('nav');
  nav.setAttribute('aria-label', '全局面板');
  const count = typeof config.panels === 'number' ? config.panels : 3;
  for (let index = 0; index < count; index += 1) {
    const panel = targetDoc.createElement('button');
    panel.setAttribute('aria-label', '面板' + index);
    nav.appendChild(panel);
  }
  // 宿主在 nav 之前渲染「＋ 新会话」按钮（logo 行之后）；默认带上，方便验证隐藏/恢复。
  let logoRow = null;
  if (config.logoRow === true) {
    logoRow = targetDoc.createElement('div');
    logoRow.setAttribute('data-window-drag', '');
    const brand = targetDoc.createElement('button');
    brand.setAttribute('aria-label', '新会话');
    logoRow.appendChild(brand);
    root.appendChild(logoRow);
  }
  let newSession = null;
  let newSessionWrapper = null;
  if (config.newSession !== false) {
    newSession = targetDoc.createElement('button');
    newSession.setAttribute('aria-label', '新会话');
    newSession.textContent = '新会话';
    if (config.wrapNewSession === true) {
      // 宿主用 Tooltip 把按钮包一层：nav 的前一个兄弟是容器而不是 button。
      newSessionWrapper = targetDoc.createElement('span');
      newSessionWrapper.appendChild(newSession);
      root.appendChild(newSessionWrapper);
    } else {
      root.appendChild(newSession);
    }
  }
  root.appendChild(nav);
  const region = targetDoc.createElement('div');
  const row = targetDoc.createElement('div');
  row.setAttribute('data-row-key', 'workspace:w1');
  region.appendChild(row);
  root.appendChild(region);
  targetDoc.body.appendChild(root);
  nav.clientWidth = typeof config.width === 'number' ? config.width : 240;
  // 布局尺寸：真实 DOM 由布局给出，这里给可预测的固定值（nav + region 之和恒定）。
  nav.clientHeight = typeof config.navHeight === 'number' ? config.navHeight : 280;
  region.clientHeight = typeof config.regionHeight === 'number' ? config.regionHeight : 600;
  return { root, nav, row, region, newSession, newSessionWrapper, logoRow };
}

function panelControlOf(nav) {
  return nav.children.find((child) => child.hasAttribute(TEST.PANEL_CONTROL_ATTR)) || null;
}

function panelToggleOf(nav) {
  const control = panelControlOf(nav);
  if (control === null) return null;
  return control.children.find((child) => child.hasAttribute(TEST.PANEL_TOGGLE_ATTR)) || null;
}

function panelSortButtonOf(nav) {
  const control = panelControlOf(nav);
  if (control === null) return null;
  return control.children.find((child) => child.hasAttribute(TEST.PANEL_SORT_ATTR)) || null;
}

function panelHandleOf(nav) {
  const control = panelControlOf(nav);
  if (control === null) return null;
  return control.children.find((child) => child.hasAttribute(TEST.PANEL_HANDLE_ATTR)) || null;
}

function panelMenuButtonOf(nav) {
  const control = panelControlOf(nav);
  if (control === null) return null;
  return control.children.find((child) => child.hasAttribute(TEST.PANEL_MENU_ATTR)) || null;
}

/** 浮层里的菜单项：按 PANEL_MENU_ITEM_ATTR 的取值（new-session / height）。 */
function panelMenuItemOf(targetDoc, name) {
  const panel = targetDoc.querySelector('[' + TEST.PANEL_MENU_PANEL_ATTR + ']');
  if (panel === null) return null;
  const found = targetDoc.collect('[' + TEST.PANEL_MENU_ITEM_ATTR + ']', panel);
  return found.find((item) => item.getAttribute(TEST.PANEL_MENU_ITEM_ATTR) === name) || null;
}

/** 触发元素上的某类监听（pointerdown / keydown / dblclick）。 */
function fireNode(node, type, event) {
  const payload = event !== null && typeof event === 'object' ? event : {};
  const listeners = node.listeners.filter((item) => item.type === type);
  for (const item of listeners) item.fn(payload);
  return listeners.length;
}

/** 触发文档级监听（pointermove / pointerup / keydown）。 */
function fireDoc(targetDoc, type, event) {
  const payload = event !== null && typeof event === 'object' ? event : {};
  const listeners = targetDoc.listeners.filter((item) => item.type === type);
  for (const item of listeners) item.fn(payload);
  return listeners.length;
}

/** 清空折叠 / 顺序 / 高度 / 隐藏存储 + 模块状态；doc 可省略。 */
function resetPanelState(targetDoc) {
  storageData.delete(TEST.PANEL_COLLAPSED_STORAGE_KEY);
  storageData.delete(TEST.PANEL_ORDER_STORAGE_KEY);
  storageData.delete(TEST.PANEL_HEIGHT_STORAGE_KEY);
  storageData.delete(TEST.HIDE_NEW_SESSION_STORAGE_KEY);
  TEST.resetPanelNav(targetDoc === undefined ? null : targetDoc);
}

check('面板栏：nav 打标记，栏尾追加唯一的控制行与折叠按钮', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const nav = addPanelNav(doc4).nav;
  assert.equal(TEST.syncPanelNav(doc4), nav);
  assert.equal(nav.hasAttribute(TEST.PANEL_NAV_ATTR), true);
  assert.equal(nav.hasAttribute(TEST.PANEL_COLLAPSED_ATTR), false);
  const control = panelControlOf(nav);
  assert.ok(control !== null, '应有控制行');
  assert.equal(nav.children[nav.children.length - 1], control, '控制行必须在栏尾');
  assert.equal(control.children.length, 4, '拖动条 + 折叠按钮 + 排序按钮 + 「⋯」');
  assert.equal(control.children[0].hasAttribute(TEST.PANEL_HANDLE_ATTR), true, '拖动条必须是首个子节点');
  const toggle = panelToggleOf(nav);
  assert.ok(toggle !== null, '应有折叠按钮');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), '收起面板');
  assert.equal(toggle.children.length, 2, 'chevron + 文案');
  assert.ok(panelSortButtonOf(nav) !== null, '应有排序按钮');
});

check('面板栏：点击折叠同步属性 / 文案 / localStorage', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const nav = addPanelNav(doc4).nav;
  TEST.syncPanelNav(doc4);
  const toggle = panelToggleOf(nav);
  toggle.click();
  assert.equal(nav.hasAttribute(TEST.PANEL_COLLAPSED_ATTR), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), '展开面板');
  const raw = storageData.get(TEST.PANEL_COLLAPSED_STORAGE_KEY);
  assert.ok(typeof raw === 'string' && raw.includes('"collapsed":true'), '存储未写入：' + raw);
  toggle.click();
  assert.equal(nav.hasAttribute(TEST.PANEL_COLLAPSED_ATTR), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  resetPanelState(doc4);
});

check('面板栏：新挂载按 localStorage 恢复收起态', () => {
  resetPanelState();
  storageData.set(TEST.PANEL_COLLAPSED_STORAGE_KEY, JSON.stringify({ v: 1, collapsed: true }));
  TEST.resetPanelNav(null);
  const doc4 = new FakeDocument();
  const nav = addPanelNav(doc4).nav;
  TEST.syncPanelNav(doc4);
  assert.equal(nav.hasAttribute(TEST.PANEL_COLLAPSED_ATTR), true);
  assert.equal(panelToggleOf(nav).getAttribute('aria-label'), '展开面板');
  resetPanelState(doc4);
});

check('面板栏：连续 sync 只保留一个控制行（幂等）', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const nav = addPanelNav(doc4).nav;
  TEST.syncPanelNav(doc4);
  TEST.syncPanelNav(doc4);
  TEST.syncPanelNav(doc4);
  const controls = nav.children.filter((child) => child.hasAttribute(TEST.PANEL_CONTROL_ATTR));
  assert.equal(controls.length, 1);
  const bareToggles = nav.children.filter((child) => child.hasAttribute(TEST.PANEL_TOGGLE_ATTR));
  assert.equal(bareToggles.length, 0, '折叠按钮不应裸挂在 nav 下');
});

check('面板栏：不含工作区行的 nav 不被装饰', () => {
  resetPanelState();
  const doc5 = new FakeDocument();
  const nav = doc5.createElement('nav');
  nav.setAttribute('aria-label', '别的导航');
  doc5.body.appendChild(nav);
  assert.equal(TEST.syncPanelNav(doc5), null);
  assert.equal(nav.hasAttribute(TEST.PANEL_NAV_ATTR), false);
  assert.equal(panelToggleOf(nav), null);
});

check('面板栏：rail 窄栏不做装饰，保持宿主原样', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const nav = addPanelNav(doc4, { width: 40 }).nav;
  assert.equal(TEST.syncPanelNav(doc4), null);
  assert.equal(nav.hasAttribute(TEST.PANEL_NAV_ATTR), false);
  assert.equal(panelToggleOf(nav), null);
});

check('面板栏：移除装饰后 nav 恢复原样', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const nav = addPanelNav(doc4).nav;
  TEST.syncPanelNav(doc4);
  assert.equal(TEST.removePanelNavDecor(doc4), 1);
  assert.equal(nav.hasAttribute(TEST.PANEL_NAV_ATTR), false);
  assert.equal(nav.hasAttribute(TEST.PANEL_COLLAPSED_ATTR), false);
  assert.equal(panelToggleOf(nav), null);
});

check('面板栏：无 nav / 无 document 时静默返回', () => {
  resetPanelState();
  const doc6 = new FakeDocument();
  assert.equal(TEST.syncPanelNav(doc6), null);
  assert.equal(TEST.syncPanelNav(null), null);
  assert.equal(TEST.removePanelNavDecor(undefined), 0);
});

check('面板栏：收起时保留最上面两个入口', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const nav = addPanelNav(doc4, { panels: 5 }).nav;
  TEST.syncPanelNav(doc4);
  panelToggleOf(nav).click();
  const keep = nav.children.filter((child) => child.hasAttribute(TEST.PANEL_KEEP_ATTR));
  assert.equal(keep.length, TEST.PANEL_COLLAPSED_VISIBLE);
  assert.equal(keep[0], nav.children[0]);
  assert.equal(keep[1], nav.children[1]);
  assert.equal(nav.children[2].hasAttribute(TEST.PANEL_KEEP_ATTR), false);
  panelToggleOf(nav).click();
  assert.equal(nav.hasAttribute(TEST.PANEL_COLLAPSED_ATTR), false);
  resetPanelState(doc4);
});

check('面板栏：排序浮层上移入口，DOM 与存储同步', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const nav = addPanelNav(doc4, { panels: 3 }).nav;
  TEST.syncPanelNav(doc4);
  panelSortButtonOf(nav).click();
  const panel = doc4.body.children.find((child) => child.hasAttribute(TEST.PANEL_SORT_PANEL_ATTR));
  assert.ok(panel !== null, '应打开排序浮层');
  let rows = doc4.querySelectorAll(TEST.PANEL_SORT_ROW_SELECTOR);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].getAttribute('data-dsh-tishi-sort-key'), '面板0');
  const up = rows[1].children.find((child) => child.getAttribute('data-dsh-tishi-panel-sort-move') === 'up');
  assert.ok(up !== null && up !== undefined, '第二行应有上移按钮');
  up.click();
  const labels = nav.children
    .filter((child) => child.tagName === 'BUTTON')
    .map((child) => child.getAttribute('aria-label'));
  assert.deepEqual(labels, ['面板1', '面板0', '面板2']);
  const raw = storageData.get(TEST.PANEL_ORDER_STORAGE_KEY);
  assert.ok(typeof raw === 'string' && raw.includes('面板1'), '顺序未写入存储：' + raw);
  rows = doc4.querySelectorAll(TEST.PANEL_SORT_ROW_SELECTOR);
  assert.equal(rows[0].getAttribute('data-dsh-tishi-sort-key'), '面板1', '浮层应同步重排');
  assert.equal(TEST.closePanelSortPanel(), true);
  assert.equal(panel.parentNode, null);
  resetPanelState(doc4);
});

check('面板栏：顺序按存储恢复，新面板排在末尾', () => {
  resetPanelState();
  storageData.set(TEST.PANEL_ORDER_STORAGE_KEY, JSON.stringify({ v: 1, order: ['面板2', '面板0'] }));
  TEST.resetPanelNav(null);
  const doc4 = new FakeDocument();
  const nav = addPanelNav(doc4, { panels: 3 }).nav;
  TEST.syncPanelNav(doc4);
  const labels = nav.children
    .filter((child) => child.tagName === 'BUTTON')
    .map((child) => child.getAttribute('aria-label'));
  assert.deepEqual(labels, ['面板2', '面板0', '面板1']);
  resetPanelState(doc4);
});
// ------------------------------------------------- 侧栏显示：隐藏新会话 / 高度拖动

check('侧栏显示：默认隐藏顶部「＋ 新会话」按钮，且不写盘', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const { nav, newSession } = addPanelNav(doc4);
  assert.ok(newSession !== null, '夹具应渲染新会话按钮');
  TEST.syncPanelNav(doc4);
  assert.equal(TEST.getNewSessionHidden(), true);
  assert.equal(newSession.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), true, '默认应隐藏');
  assert.equal(storageData.has(TEST.HIDE_NEW_SESSION_STORAGE_KEY), false, '缺存储时不应写盘');
  assert.equal(TEST.findNewSessionButton(nav), newSession);
  TEST.syncPanelNav(doc4);
  assert.equal(newSession.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), true, '幂等');
  resetPanelState(doc4);
});

check('侧栏显示：「⋯」浮层能把新会话按钮找回来并记住选择', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const { nav, newSession } = addPanelNav(doc4);
  TEST.syncPanelNav(doc4);
  const menuButton = panelMenuButtonOf(nav);
  assert.ok(menuButton !== null, '控制行应有「⋯」');
  menuButton.click();
  assert.equal(TEST.isPanelMenuOpen(), true);
  const panel = doc4.querySelector('[' + TEST.PANEL_MENU_PANEL_ATTR + ']');
  assert.ok(panel !== null && panel.parentNode === doc4.body, '浮层应挂在 body 上');
  let item = panelMenuItemOf(doc4, 'new-session');
  assert.ok(item !== null, '应有「隐藏新会话」开关项');
  assert.equal(item.getAttribute('aria-pressed'), 'true', '初始应勾选');
  item.click();
  assert.equal(newSession.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), false, '应恢复按钮');
  const raw = storageData.get(TEST.HIDE_NEW_SESSION_STORAGE_KEY);
  assert.ok(typeof raw === 'string' && raw.includes('"hidden":false'), '应写入存储：' + raw);
  item = panelMenuItemOf(doc4, 'new-session');
  assert.equal(item.getAttribute('aria-pressed'), 'false', '勾选态应同步更新');
  item.click();
  assert.equal(newSession.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), true, '应重新隐藏');
  fireDoc(doc4, 'keydown', { key: 'Escape' });
  assert.equal(TEST.isPanelMenuOpen(), false, 'Esc 应关闭浮层');
  assert.equal(doc4.querySelector('[' + TEST.PANEL_MENU_PANEL_ATTR + ']'), null);
  resetPanelState(doc4);
});

check('侧栏显示：按钮被 Tooltip 包一层时仍能找到并藏容器', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const { nav, newSession, newSessionWrapper } = addPanelNav(doc4, { wrapNewSession: true, logoRow: true });
  TEST.syncPanelNav(doc4);
  assert.ok(newSessionWrapper !== null, '夹具应渲染容器');
  assert.equal(TEST.findNewSessionButton(nav), newSessionWrapper, '应返回包着按钮的容器');
  assert.equal(newSessionWrapper.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), true, '容器应被隐藏');
  assert.equal(newSession.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), false, '按钮本身不该被打标记');
  resetPanelState(doc4);
  assert.equal(newSessionWrapper.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), false, '卸载应摘标记');
});

check('侧栏显示：没有新会话按钮时碰到 logo 行必须停手（不误伤 logo / 折叠按钮）', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const { nav, logoRow } = addPanelNav(doc4, { newSession: false, logoRow: true });
  TEST.syncPanelNav(doc4);
  assert.ok(logoRow !== null, '夹具应有 logo 行');
  assert.equal(TEST.findNewSessionButton(nav), null, '向前找只应停在 logo 行');
  assert.equal(logoRow.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), false, 'logo 行不能被隐藏');
  assert.equal(logoRow.children[0].hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), false, '品牌按钮不能被隐藏');
  TEST.removePanelNavDecor(doc4);
});

check('侧栏显示：rail 窄栏不隐藏按钮，移除装饰时恢复原样', () => {
  resetPanelState();
  const wideDoc = new FakeDocument();
  const wide = addPanelNav(wideDoc);
  TEST.syncPanelNav(wideDoc);
  assert.equal(wide.newSession.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), true);
  // 宿主整栏收起：nav 不再布局（clientWidth = 0），fixed ⊕ 是唯一入口，必须还原。
  wide.nav.clientWidth = 0;
  TEST.syncPanelNav(wideDoc);
  assert.equal(wide.newSession.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), false, '收起成窄栏时必须还原按钮');
  wide.nav.clientWidth = 240;
  TEST.syncPanelNav(wideDoc);
  assert.equal(wide.newSession.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), true, '回到宽栏应重新隐藏');
  // 切到 rail：同一份 DOM 宽度变窄，装饰整体撤掉。
  wide.nav.clientWidth = 40;
  assert.equal(TEST.syncPanelNav(wideDoc), null);
  assert.equal(wide.newSession.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), false, 'rail 下必须还原按钮');
  assert.equal(wide.nav.hasAttribute(TEST.PANEL_NAV_ATTR), false);
  wide.nav.clientWidth = 240;
  TEST.syncPanelNav(wideDoc);
  assert.equal(wide.newSession.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), true, '回到宽栏应重新应用');
  TEST.removePanelNavDecor(wideDoc);
  assert.equal(wide.newSession.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), false, '卸载必须摘掉隐藏标记');
});

check('入口区高度：上限 = nav + region - 工作区保留高度', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const { nav } = addPanelNav(doc4, { navHeight: 280, regionHeight: 600 });
  assert.equal(TEST.panelHeightMax(nav), 280 + 600 - TEST.PANEL_WORKSPACE_MIN);
  assert.equal(TEST.clampPanelHeight(nav, 9999), 280 + 600 - TEST.PANEL_WORKSPACE_MIN);
  assert.equal(TEST.clampPanelHeight(nav, 1), TEST.PANEL_HEIGHT_MIN);
  // 没有 region 兄弟节点时退化为下限，不抛错。
  const lonelyDoc = new FakeDocument();
  const lonely = lonelyDoc.createElement('nav');
  lonelyDoc.body.appendChild(lonely);
  assert.equal(TEST.panelHeightMax(lonely), 0);
  assert.equal(TEST.clampPanelHeight(lonely, 200), 200);
  resetPanelState(doc4);
});

check('入口区高度：拖动改高度、松手写存储、双击复位', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const { nav } = addPanelNav(doc4, { navHeight: 280, regionHeight: 600 });
  TEST.syncPanelNav(doc4);
  const handle = panelHandleOf(nav);
  assert.ok(handle !== null, '控制行应有拖动条');
  assert.equal(handle.getAttribute('role'), 'separator');
  assert.equal(handle.getAttribute('aria-orientation'), 'horizontal');
  fireNode(handle, 'pointerdown', { clientY: 400, preventDefault() {}, stopPropagation() {} });
  assert.equal(TEST.isPanelResizing(), true, '按下后应进入拖动');
  fireDoc(doc4, 'pointermove', { clientY: 460 });
  assert.equal(nav.style.height, '340px', '应从 280 拖到 340');
  assert.equal(nav.hasAttribute(TEST.PANEL_HEIGHT_ATTR), true);
  fireDoc(doc4, 'pointerup', {});
  assert.equal(TEST.isPanelResizing(), false, '松手应结束拖动');
  const raw = storageData.get(TEST.PANEL_HEIGHT_STORAGE_KEY);
  assert.ok(typeof raw === 'string' && raw.includes('"px":340'), '松手应写存储：' + raw);
  fireNode(handle, 'dblclick', {});
  assert.equal(TEST.getPanelHeight(), null, '双击应复位');
  assert.equal(nav.style.height, '', '内联高度应清掉');
  assert.equal(nav.hasAttribute(TEST.PANEL_HEIGHT_ATTR), false);
  assert.equal(storageData.has(TEST.PANEL_HEIGHT_STORAGE_KEY), false, '复位应删键');
  resetPanelState(doc4);
});

check('入口区高度：拖动夹在 [最小, 上限] 之间，收起态不写内联高度', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const { nav } = addPanelNav(doc4, { navHeight: 280, regionHeight: 600 });
  TEST.syncPanelNav(doc4);
  const handle = panelHandleOf(nav);
  const max = 280 + 600 - TEST.PANEL_WORKSPACE_MIN;
  fireNode(handle, 'pointerdown', { clientY: 400, preventDefault() {}, stopPropagation() {} });
  fireDoc(doc4, 'pointermove', { clientY: 5000 });
  assert.equal(nav.style.height, max + 'px', '应夹在上限');
  fireDoc(doc4, 'pointermove', { clientY: -5000 });
  assert.equal(nav.style.height, TEST.PANEL_HEIGHT_MIN + 'px', '应夹在下限');
  fireDoc(doc4, 'pointerup', {});
  // 收起面板后高度让位给工作区；展开恢复。
  panelToggleOf(nav).click();
  assert.equal(nav.style.height, '', '收起态不应占高度');
  panelToggleOf(nav).click();
  assert.equal(nav.style.height, TEST.PANEL_HEIGHT_MIN + 'px', '展开应恢复自定义高度');
  resetPanelState(doc4);
});

check('入口区高度：键盘 ↑↓ / Shift / Home / End / Enter', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const { nav } = addPanelNav(doc4, { navHeight: 280, regionHeight: 600 });
  TEST.syncPanelNav(doc4);
  const handle = panelHandleOf(nav);
  const max = 280 + 600 - TEST.PANEL_WORKSPACE_MIN;
  const kd = (key, extra) =>
    fireNode(handle, 'keydown', Object.assign({ key, preventDefault() {} }, extra === undefined ? {} : extra));
  // 默认高度 = nav.clientHeight 280。
  kd('ArrowUp');
  assert.equal(nav.style.height, 280 - TEST.PANEL_HEIGHT_STEP + 'px');
  kd('ArrowDown', { shiftKey: true });
  assert.equal(nav.style.height, 280 - TEST.PANEL_HEIGHT_STEP + TEST.PANEL_HEIGHT_STEP * 3 + 'px');
  kd('Home');
  assert.equal(nav.style.height, TEST.PANEL_HEIGHT_MIN + 'px');
  kd('End');
  assert.equal(nav.style.height, max + 'px');
  kd('Enter');
  assert.equal(TEST.getPanelHeight(), null, 'Enter 应复位');
  assert.equal(nav.style.height, '');
  resetPanelState(doc4);
});

check('入口区高度：按存储恢复，非法存储忽略', () => {
  resetPanelState();
  storageData.set(TEST.PANEL_HEIGHT_STORAGE_KEY, JSON.stringify({ v: 1, px: 320 }));
  TEST.resetPanelNav(null);
  const doc4 = new FakeDocument();
  const { nav } = addPanelNav(doc4, { navHeight: 280, regionHeight: 600 });
  TEST.syncPanelNav(doc4);
  assert.equal(nav.style.height, '320px', '应恢复自定义高度');
  // 非法值：负数 / 字符串 / 坏 JSON 都退回默认上限。
  for (const bad of ['{"v":1,"px":-5}', '{"v":1,"px":"320"}', 'not json']) {
    storageData.set(TEST.PANEL_HEIGHT_STORAGE_KEY, bad);
    TEST.resetPanelNav(null);
    const fresh = new FakeDocument();
    const fixture = addPanelNav(fresh, { navHeight: 280, regionHeight: 600 });
    TEST.syncPanelNav(fresh);
    assert.equal(fixture.nav.style.height, '', '非法存储应退回默认：' + bad);
    TEST.removePanelNavDecor(fresh);
  }
  resetPanelState(doc4);
});

check('侧栏显示：有自定义高度时「恢复默认」可用并复位', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const { nav } = addPanelNav(doc4, { navHeight: 280, regionHeight: 600 });
  TEST.syncPanelNav(doc4);
  const handle = panelHandleOf(nav);
  fireNode(handle, 'pointerdown', { clientY: 400, preventDefault() {}, stopPropagation() {} });
  fireDoc(doc4, 'pointermove', { clientY: 440 });
  fireDoc(doc4, 'pointerup', {});
  assert.equal(TEST.getPanelHeight(), 320);
  panelMenuButtonOf(nav).click();
  const item = panelMenuItemOf(doc4, 'height');
  assert.ok(item !== null, '应有恢复默认高度项');
  assert.equal(item.hasAttribute('disabled'), false, '有自定义高度时应可用');
  item.click();
  assert.equal(TEST.getPanelHeight(), null);
  assert.equal(nav.style.height, '');
  assert.equal(storageData.has(TEST.PANEL_HEIGHT_STORAGE_KEY), false, '复位应删键');
  assert.equal(TEST.isPanelMenuOpen(), false, '复位后应关闭浮层');
  resetPanelState(doc4);
});

check('侧栏显示：排序浮层与「⋯」浮层互斥', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const { nav } = addPanelNav(doc4);
  TEST.syncPanelNav(doc4);
  panelSortButtonOf(nav).click();
  assert.ok(doc4.querySelector(TEST.PANEL_SORT_PANEL_SELECTOR) !== null, '排序浮层应打开');
  panelMenuButtonOf(nav).click();
  assert.equal(TEST.isPanelMenuOpen(), true);
  assert.equal(doc4.querySelector(TEST.PANEL_SORT_PANEL_SELECTOR), null, '排序浮层应被关掉');
  panelSortButtonOf(nav).click();
  assert.equal(TEST.isPanelMenuOpen(), false, '「⋯」浮层应被关掉');
  TEST.closePanelSortPanel();
  resetPanelState(doc4);
});

check('侧栏显示：卸载清掉高度内联样式 / 隐藏标记 / 浮层', () => {
  resetPanelState();
  const doc4 = new FakeDocument();
  const { nav, newSession } = addPanelNav(doc4, { navHeight: 280, regionHeight: 600 });
  TEST.syncPanelNav(doc4);
  const handle = panelHandleOf(nav);
  fireNode(handle, 'pointerdown', { clientY: 400, preventDefault() {}, stopPropagation() {} });
  fireDoc(doc4, 'pointermove', { clientY: 450 });
  fireDoc(doc4, 'pointerup', {});
  panelMenuButtonOf(nav).click();
  assert.equal(TEST.isPanelMenuOpen(), true);
  TEST.removePanelNavDecor(doc4);
  assert.equal(nav.style.height, '');
  assert.equal(nav.style.maxHeight, '');
  assert.equal(nav.hasAttribute(TEST.PANEL_HEIGHT_ATTR), false);
  assert.equal(newSession.hasAttribute(TEST.HIDE_NEW_SESSION_ATTR), false);
  assert.equal(TEST.isPanelMenuOpen(), false);
  assert.equal(doc4.querySelector('[' + TEST.PANEL_MENU_PANEL_ATTR + ']'), null);
  resetPanelState(doc4);
});


console.log(`\nSMOKE OK renders=${renderCount} checks=${checks}`);

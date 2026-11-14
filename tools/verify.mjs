/**
 * 离线验证：不启动浏览器、不连宿主，用桩件加载两个半边，验证
 *   ① loader id / 插件对象形状 / shell.overlay 槽位注册 / workspace 菜单注册；
 *   ② 纯函数 computeWorkspaceBadges：混跑、优先级、归档过滤、空数据、running 兜底；
 *   ③ 隐藏工作区：菜单动作、最后顶层工作区保护、localStorage 持久化、reconcile 兜底；
 *   ④ 控制器在「缺标准 props」与「没有 document」时静默降级；
 *   ⑤ 静态约束：只 require('react')、只用主题 token、DOM 契约选择器、降级守卫。
 *
 * 用法：node tools/verify.mjs（退出码 0 = 全过；失败打印 FAIL 并退出 1）
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

// ---------------------------------------------------------------- 环境桩

/** 故意不设 globalThis.document：验证模块加载与控制器降级都不碰 DOM。 */
let captured = null;
globalThis.__DSH_TISHI_TEST__ = {};
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

const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useRef(initial) {
    return { current: initial };
  },
  useEffect() {},
};

const moduleUrl = pathToFileURL(path.join(root, 'client.js')).href;
await import(moduleUrl);
const TEST = globalThis.__DSH_TISHI_TEST__;

const requiredSpecs = [];
const plugin = captured.factory((spec) => {
  requiredSpecs.push(spec);
  return reactStub;
});

// ---------------------------------------------------------------- 插件形状

check('loader id 是 dsh-tishi', () => {
  assert.equal(captured.id, 'dsh-tishi');
});

check("浏览器半边只 require('react')", () => {
  assert.deepEqual(requiredSpecs, ['react']);
});

check('插件对象形状 = {name, inject:[slots,contextMenus], apply}', () => {
  assert.equal(plugin.name, 'dsh-tishi');
  assert.deepEqual(plugin.inject, ['slots', 'contextMenus']);
  assert.equal(typeof plugin.apply, 'function');
});

check('apply 注册 shell.overlay 控制器', () => {
  const calls = [];
  const ctx = {
    effect(callback, label) {
      calls.push(['effect', label]);
      return callback();
    },
    slots: {
      inject(slot, callback) {
        calls.push(['inject', slot]);
        return callback();
      },
      register(options, component) {
        calls.push(['register', options, component]);
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], 'effect');
  assert.match(calls[0][1], /dsh-tishi/);
  assert.deepEqual(calls[1], ['inject', 'shell.overlay']);
  const options = calls[2][1];
  assert.equal(options.name, 'shell.overlay');
  assert.equal(options.id, 'dsh-tishi.status-badges');
  assert.equal(options.order, 900);
  assert.equal(calls[2][2], TEST.StatusBadgeController);
});

check('apply 注册 workspace 隐藏菜单（id/target/order/resolve）', () => {
  const registered = [];
  const effects = [];
  const ctx = {
    effect(callback, label) {
      effects.push(label);
      return callback();
    },
    slots: {
      inject(slot, callback) {
        return callback();
      },
      register() {
        return () => {};
      },
    },
    contextMenus: {
      register(input) {
        registered.push(input);
        return () => {};
      },
      notify() {},
    },
  };
  plugin.apply(ctx);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, TEST.MENU_ID);
  assert.equal(registered[0].target, 'workspace');
  assert.equal(registered[0].order, TEST.MENU_ORDER);
  assert.equal(typeof registered[0].resolve, 'function');
  // latest 还没有被控制器填充 → resolve 退化为 []，不抛错。
  assert.deepEqual(registered[0].resolve({ workspaceId: 'w1', displayTitle: 'w1' }), []);
  assert.ok(effects.some((label) => /hide workspace menu/.test(label)));
});

check('没有 ctx.effect 时仍能注册（兼容旧客户端）', () => {
  const registrations = [];
  plugin.apply({
    slots: {
      inject: (slot, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.name, 'shell.overlay');
});

check('没有 contextMenus 服务时仍注册角标、不抛错', () => {
  const registrations = [];
  const ctx = {
    slots: {
      inject: (slot, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  assert.doesNotThrow(() => plugin.apply(ctx));
  assert.equal(registrations.length, 1);
});

check('ctx 残缺时 apply 不抛错', () => {
  assert.equal(plugin.apply(null), undefined);
  assert.equal(plugin.apply(undefined), undefined);
  assert.equal(plugin.apply({}), undefined);
  assert.equal(plugin.apply({ slots: null }), undefined);
});

// ---------------------------------------------------------------- 数据聚合

const EMPTY = { pending: 0, running: 0, done: 0, total: 0 };
function counts(map, workspaceId) {
  return map.get(workspaceId) ?? EMPTY;
}

check('混跑：一个工作区可同时有待处理/运行中/未读完成', () => {
  const snapshot = { items: [{ workspaceId: 'w1', sessionIds: ['s1', 's2', 's3', 's4'] }], archivedSessionIds: [] };
  const statuses = new Map([
    ['s1', { pendingInteraction: { kind: 'approval' } }],
    ['s2', { running: true }],
    ['s3', { completionUnread: true }],
    ['s4', {}],
  ]);
  const result = TEST.computeWorkspaceBadges(snapshot, statuses, { ids: [], byId: {} });
  assert.deepEqual(counts(result, 'w1'), { pending: 1, running: 1, done: 1, total: 3 });
});

check('优先级：待处理 > 运行中 > 未读完成（同一会话只计一类）', () => {
  const snapshot = { items: [{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }] };
  const statuses = new Map([
    ['s1', { running: true, completionUnread: true, pendingInteraction: { kind: 'question' } }],
    ['s2', { running: true, completionUnread: true }],
  ]);
  const result = TEST.computeWorkspaceBadges(snapshot, statuses, { byId: {} });
  assert.deepEqual(counts(result, 'w1'), { pending: 1, running: 1, done: 0, total: 2 });
});

check('三种待处理 kind 都算 pending；未知 kind 不算', () => {
  const snapshot = { items: [{ workspaceId: 'w1', sessionIds: ['s1', 's2', 's3', 's4'] }] };
  const statuses = new Map([
    ['s1', { pendingInteraction: { kind: 'approval' } }],
    ['s2', { pendingInteraction: { kind: 'question' } }],
    ['s3', { pendingInteraction: { kind: 'plan-review' } }],
    ['s4', { pendingInteraction: { kind: 'other' }, running: true }],
  ]);
  const result = TEST.computeWorkspaceBadges(snapshot, statuses, { byId: {} });
  assert.deepEqual(counts(result, 'w1'), { pending: 3, running: 1, done: 0, total: 4 });
});

check('归档会话被排除（数组与 Set 两种形状）', () => {
  const statuses = new Map([['s1', { running: true }], ['s2', { running: true }]]);
  for (const archivedSessionIds of [['s2'], new Set(['s2'])]) {
    const snapshot = { items: [{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }], archivedSessionIds };
    const result = TEST.computeWorkspaceBadges(snapshot, statuses, { byId: {} });
    assert.deepEqual(counts(result, 'w1'), { pending: 0, running: 1, done: 0, total: 1 });
  }
});

check('子智能体会话（origin=subagent）不占工作区主状态', () => {
  const snapshot = { items: [{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }] };
  const statuses = new Map([['s1', { running: true }], ['s2', { running: true }]]);
  const list = { byId: { s1: { origin: 'subagent' }, s2: {} } };
  const result = TEST.computeWorkspaceBadges(snapshot, statuses, list);
  assert.deepEqual(counts(result, 'w1'), { pending: 0, running: 1, done: 0, total: 1 });
});

check('空 workspaceId / 非对象工作区被跳过', () => {
  const statuses = new Map([['s1', { running: true }]]);
  const snapshot = {
    items: [null, {}, { workspaceId: '', sessionIds: ['s1'] }, { workspaceId: 'w1', sessionIds: ['s1'] }],
  };
  const result = TEST.computeWorkspaceBadges(snapshot, statuses, { byId: {} });
  assert.equal(result.size, 1);
  assert.deepEqual(counts(result, 'w1'), { pending: 0, running: 1, done: 0, total: 1 });
});

check('空数据（无快照 / 空 Map）得到全 0 且工作区仍在表里', () => {
  for (const [snapshot, statuses] of [
    [null, null],
    [undefined, new Map()],
    [{ items: [{ workspaceId: 'w1', sessionIds: ['s1'] }], archivedSessionIds: [] }, new Map()],
  ]) {
    const result = TEST.computeWorkspaceBadges(snapshot, statuses, null);
    if (snapshot === null || snapshot === undefined) {
      assert.equal(result.size, 0);
    } else {
      assert.deepEqual(counts(result, 'w1'), EMPTY);
    }
  }
});

check('状态缺失时用 sessionList.byId[id].running 兜底', () => {
  const snapshot = { items: [{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }] };
  const list = { byId: { s1: { running: true }, s2: { running: false } } };
  const result = TEST.computeWorkspaceBadges(snapshot, new Map(), list);
  assert.deepEqual(counts(result, 'w1'), { pending: 0, running: 1, done: 0, total: 1 });
});

check('status.running=false 不落回 summary.running', () => {
  const snapshot = { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }] };
  const statuses = new Map([['s1', { running: false }]]);
  const list = { byId: { s1: { running: true } } };
  const result = TEST.computeWorkspaceBadges(snapshot, statuses, list);
  assert.deepEqual(counts(result, 'w1'), EMPTY);
});

check('completionUnread 只认 === true', () => {
  const snapshot = { items: [{ workspaceId: 'w1', sessionIds: ['s1', 's2', 's3'] }] };
  const statuses = new Map([
    ['s1', { completionUnread: false }],
    ['s2', { completionUnread: undefined }],
    ['s3', { completionUnread: true }],
  ]);
  const result = TEST.computeWorkspaceBadges(snapshot, statuses, { byId: {} });
  assert.deepEqual(counts(result, 'w1'), { pending: 0, running: 0, done: 1, total: 1 });
});

check('多个工作区各自独立计数', () => {
  const snapshot = {
    items: [
      { workspaceId: 'w1', sessionIds: ['s1'] },
      { workspaceId: 'w2', sessionIds: ['s2', 's3'] },
      { workspaceId: 'w3', sessionIds: [] },
    ],
  };
  const statuses = new Map([
    ['s1', { running: true }],
    ['s2', { pendingInteraction: { kind: 'approval' } }],
    ['s3', { completionUnread: true }],
  ]);
  const result = TEST.computeWorkspaceBadges(snapshot, statuses, { byId: {} });
  assert.deepEqual(counts(result, 'w1'), { pending: 0, running: 1, done: 0, total: 1 });
  assert.deepEqual(counts(result, 'w2'), { pending: 1, running: 0, done: 1, total: 2 });
  assert.deepEqual(counts(result, 'w3'), EMPTY);
});

check('非字符串 sessionId 被跳过', () => {
  const snapshot = { items: [{ workspaceId: 'w1', sessionIds: [null, 42, 's1'] }] };
  const statuses = new Map([['s1', { running: true }]]);
  const result = TEST.computeWorkspaceBadges(snapshot, statuses, { byId: {} });
  assert.deepEqual(counts(result, 'w1'), { pending: 0, running: 1, done: 0, total: 1 });
});

check('describeBadge 固定 pending→running→done 顺序，只列非 0', () => {
  assert.equal(TEST.describeBadge({ pending: 1, running: 2, done: 3, total: 6 }), '待处理 1 · 运行中 2 · 未读完成 3');
  assert.equal(TEST.describeBadge({ pending: 0, running: 2, done: 0, total: 2 }), '运行中 2');
  assert.equal(TEST.describeBadge(EMPTY), '');
  assert.equal(TEST.describeBadge(null), '');
});

check('workspaceParentMap：按路径最长前缀建父子边', () => {
  const items = [
    { workspaceId: 'root', path: 'D:/QAQ/dsh_plugins' },
    { workspaceId: 'child', path: 'D:/QAQ/dsh_plugins/dsh_tishi' },
    { workspaceId: 'grand', path: 'D:/QAQ/dsh_plugins/dsh_tishi/lab' },
    { workspaceId: 'sibling', path: 'D:/QAQ/dsh_plugins/other' },
    { workspaceId: 'lookalike', path: 'D:/QAQ2' },
    { workspaceId: 'caseMismatch', path: 'D:/QAQ/DSH_PLUGINS/child' },
    { workspaceId: 'trailing', path: 'D:/QAQ/dsh_plugins/trailing/' },
    { workspaceId: 'trailingChild', path: 'D:/QAQ/dsh_plugins/trailing/kid' },
    { workspaceId: 'noPath' },
    { workspaceId: '', path: 'D:/QAQ/dsh_plugins/empty' },
  ];
  const parents = TEST.workspaceParentMap(items);
  assert.equal(parents.get('child'), 'root');
  assert.equal(parents.get('grand'), 'child');
  assert.equal(parents.get('sibling'), 'root');
  assert.equal(parents.has('lookalike'), false);
  assert.equal(parents.has('caseMismatch'), false);
  assert.equal(parents.get('trailing'), 'root');
  assert.equal(parents.get('trailingChild'), 'trailing');
  assert.equal(parents.has('noPath'), false);
  assert.equal(parents.has(''), false);
  assert.equal(parents.size, 5);
});

check('嵌套工作区：父行聚合自身与全部后代，兄弟不串', () => {
  const snapshot = {
    items: [
      { workspaceId: 'root', path: 'D:/QAQ', sessionIds: ['r1'] },
      { workspaceId: 'child', path: 'D:/QAQ/child', sessionIds: ['c1'] },
      { workspaceId: 'grand', path: 'D:/QAQ/child/grand', sessionIds: ['g1'] },
      { workspaceId: 'sibling', path: 'D:/QAQ/sibling', sessionIds: ['s1'] },
    ],
  };
  const statuses = new Map([
    ['r1', { completionUnread: true }],
    ['c1', { running: true }],
    ['g1', { pendingInteraction: { kind: 'plan-review' } }],
    ['s1', { running: true }],
  ]);
  const result = TEST.computeWorkspaceBadges(snapshot, statuses, { byId: {} });
  assert.deepEqual(counts(result, 'root'), { pending: 1, running: 2, done: 1, total: 4 });
  assert.deepEqual(counts(result, 'child'), { pending: 1, running: 1, done: 0, total: 2 });
  assert.deepEqual(counts(result, 'grand'), { pending: 1, running: 0, done: 0, total: 1 });
  assert.deepEqual(counts(result, 'sibling'), { pending: 0, running: 1, done: 0, total: 1 });
});

check('父工作区自身无会话，仍显示后代活动（折叠场景）', () => {
  const snapshot = {
    items: [
      { workspaceId: 'parent', path: 'D:/QAQ/dsh_plugins', sessionIds: [] },
      { workspaceId: 'child', path: 'D:/QAQ/dsh_plugins/dsh_tishi', sessionIds: ['s1'] },
    ],
  };
  const result = TEST.computeWorkspaceBadges(snapshot, new Map([['s1', { running: true }]]), { byId: {} });
  assert.deepEqual(counts(result, 'parent'), { pending: 0, running: 1, done: 0, total: 1 });
  assert.deepEqual(counts(result, 'child'), { pending: 0, running: 1, done: 0, total: 1 });
});

// ------------------------------------------------------------ 隐藏工作区

const WORKSPACES = [
  { workspaceId: 'w1', title: 'A', path: 'D:\\A', sessionIds: [] },
  { workspaceId: 'w2', title: 'B', path: 'D:\\B', sessionIds: [] },
  { workspaceId: 'w2c', title: 'B 子', path: 'D:\\B\\child', sessionIds: [] },
];

check('workspaceLabel：title → 路径末段 → id', () => {
  assert.equal(TEST.workspaceLabel({ workspaceId: 'x', title: '名字', path: 'D:\\p' }), '名字');
  assert.equal(TEST.workspaceLabel({ workspaceId: 'x', path: 'D:\\dir\\last' }), 'last');
  assert.equal(TEST.workspaceLabel({ workspaceId: 'x', path: 'D:\\dir\\last\\' }), 'last');
  assert.equal(TEST.workspaceLabel({ workspaceId: 'x' }), 'x');
  assert.equal(TEST.workspaceLabel(null), '');
});

check('rootWorkspaceIds：嵌套目录只算父级为根', () => {
  assert.deepEqual(TEST.rootWorkspaceIds(WORKSPACES), ['w1', 'w2']);
  assert.deepEqual(TEST.rootWorkspaceIds([]), []);
  assert.deepEqual(TEST.rootWorkspaceIds([{ workspaceId: 'p', path: 'D:\\p' }]), ['p']);
});

check('canHideWorkspace：最后顶层工作区禁止隐藏，嵌套子工作区允许', () => {
  assert.equal(TEST.canHideWorkspace('w1', WORKSPACES, new Set()), true);
  assert.equal(TEST.canHideWorkspace('w1', WORKSPACES, new Set(['w2'])), false);
  assert.equal(TEST.canHideWorkspace('w2c', WORKSPACES, new Set(['w2'])), true);
  assert.equal(TEST.canHideWorkspace('w1', WORKSPACES, new Set(['w1'])), false);
  assert.equal(TEST.canHideWorkspace('missing', WORKSPACES, new Set()), false);
  assert.equal(TEST.canHideWorkspace('', WORKSPACES, new Set()), false);
});

check('默认菜单：只有「隐藏工作区」，没有管理子菜单', () => {
  const actions = TEST.buildWorkspaceMenuItems(
    { workspaceId: 'w1', displayTitle: 'A' },
    { items: WORKSPACES, badges: new Map(), hidden: new Set() },
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'hide');
  assert.equal(actions[0].label, '隐藏工作区');
  assert.equal(actions[0].disabled, undefined);
  assert.equal(typeof actions[0].run, 'function');
});

check('有隐藏工作区时追加管理子菜单（含活动角标文案）', () => {
  const badges = new Map([['w1', { pending: 1, running: 0, done: 0, total: 1 }]]);
  const actions = TEST.buildWorkspaceMenuItems(
    { workspaceId: 'w2', displayTitle: 'B' },
    { items: WORKSPACES, badges, hidden: new Set(['w1']) },
  );
  assert.equal(actions.length, 2);
  assert.equal(actions[0].id, 'hide');
  assert.equal(actions[1].id, 'manage');
  assert.equal(actions[1].label, '已隐藏的工作区 (1)');
  assert.equal(actions[1].separatorBefore, true);
  assert.equal(actions[1].children.length, 2);
  assert.equal(actions[1].children[0].label, 'A · 待处理 1');
  assert.equal(actions[1].children[1].id, 'show-all');
});

check('最后一个可见顶层工作区的隐藏项被禁用', () => {
  const actions = TEST.buildWorkspaceMenuItems(
    { workspaceId: 'w1', displayTitle: 'A' },
    { items: WORKSPACES, badges: new Map(), hidden: new Set(['w2']) },
  );
  assert.equal(actions[0].id, 'hide');
  assert.equal(actions[0].disabled, true);
  assert.match(actions[0].label, /至少保留一个/);
});

check('防御分支：目标已在隐藏集合时显示「显示此工作区」', () => {
  const actions = TEST.buildWorkspaceMenuItems(
    { workspaceId: 'w1', displayTitle: 'A' },
    { items: WORKSPACES, badges: new Map(), hidden: new Set(['w1']) },
  );
  assert.equal(actions[0].id, 'show');
  assert.equal(actions[0].label, '显示此工作区');
});

check('未知 / 空 workspace 目标返回空菜单', () => {
  assert.deepEqual(TEST.buildWorkspaceMenuItems(null, { items: WORKSPACES }), []);
  assert.deepEqual(TEST.buildWorkspaceMenuItems({ workspaceId: '' }, { items: WORKSPACES }), []);
  assert.deepEqual(TEST.buildWorkspaceMenuItems({ workspaceId: 'missing' }, { items: WORKSPACES }), []);
  assert.deepEqual(TEST.buildWorkspaceMenuItems({ workspaceId: 'w1' }, { items: [] }), []);
  assert.deepEqual(TEST.resolveWorkspaceMenu({ workspaceId: 'w1' }), []);
});

check('localStorage 持久化：round-trip / 坏 JSON / 旧数组格式', () => {
  TEST.setHiddenIds(new Set(['x1', 'x1', '', 7]));
  assert.deepEqual([...TEST.getHiddenIds()], ['x1']);
  const raw = globalThis.window.localStorage.getItem(TEST.HIDDEN_STORAGE_KEY);
  assert.deepEqual(JSON.parse(raw), { v: 1, ids: ['x1'] });
  assert.deepEqual([...TEST.loadHiddenIds()], ['x1']);

  globalThis.window.localStorage.setItem(TEST.HIDDEN_STORAGE_KEY, '{not json');
  assert.deepEqual([...TEST.loadHiddenIds()], []);
  globalThis.window.localStorage.setItem(TEST.HIDDEN_STORAGE_KEY, JSON.stringify({ v: 1, ids: 'nope' }));
  assert.deepEqual([...TEST.loadHiddenIds()], []);
  globalThis.window.localStorage.setItem(TEST.HIDDEN_STORAGE_KEY, JSON.stringify(['legacy']));
  assert.deepEqual([...TEST.loadHiddenIds()], ['legacy']);
  TEST.setHiddenIds(new Set());
});

check('hideWorkspace / showWorkspace / showAllWorkspaces 改内存 + 存储', () => {
  TEST.setHiddenIds(new Set());
  assert.equal(TEST.hideWorkspace('w1', 'A'), true);
  assert.equal(TEST.hideWorkspace('w1', 'A'), false);
  assert.deepEqual([...TEST.getHiddenIds()], ['w1']);
  assert.match(globalThis.window.localStorage.getItem(TEST.HIDDEN_STORAGE_KEY), /w1/);
  assert.equal(TEST.showWorkspace('w1'), true);
  assert.equal(TEST.showWorkspace('w1'), false);
  assert.equal(TEST.getHiddenIds().size, 0);
  TEST.setHiddenIds(new Set(['w1', 'w2']));
  assert.equal(TEST.showAllWorkspaces(), true);
  assert.equal(TEST.getHiddenIds().size, 0);
  TEST.setHiddenIds(new Set());
});

check('reconcileHidden：所有顶层工作区都被隐藏时恢复第一个', () => {
  TEST.setHiddenIds(new Set(['w1', 'w2']));
  const corrected = TEST.reconcileHidden(WORKSPACES);
  assert.equal(corrected.has('w1'), false);
  assert.equal(corrected.has('w2'), true);
  assert.equal(TEST.getHiddenIds().has('w1'), false);
  assert.match(globalThis.window.localStorage.getItem(TEST.HIDDEN_STORAGE_KEY), /w2/);
  TEST.setHiddenIds(new Set());
  // 仍有可见顶层 / 空列表 → 不动。
  TEST.setHiddenIds(new Set(['w2']));
  assert.equal(TEST.reconcileHidden(WORKSPACES).has('w2'), true);
  assert.equal(TEST.reconcileHidden([]).has('w2'), true);
  TEST.setHiddenIds(new Set());
});

// ---------------------------------------------------------------- 控制器降级

check('没有 document 时控制器渲染为 null、不抛错', () => {
  const snapshot = { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }], archivedSessionIds: [] };
  const props = {
    useWorkspaces: (selector) => selector(snapshot),
    useSessions: () => ({ ids: ['s1'], byId: {} }),
    useSessionStatus: () => new Map([['s1', { running: true }]]),
  };
  assert.equal(TEST.StatusBadgeController(props), null);
  assert.equal(TEST.StatusBadgeController(null), null);
  assert.equal(TEST.StatusBadgeController({}), null);
});

check('显示策略常量默认「有活动就显示」', () => {
  assert.equal(TEST.SHOW_WHEN_EXPANDED, true);
});

// ---------------------------------------------------------------- 静态约束

const clientSource = await readFile(path.join(root, 'client.js'), 'utf8');
const hostSource = await readFile(path.join(root, 'index.js'), 'utf8');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const patchSource = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8');

check("client.js 没有 import，require 只出现 react", () => {
  assert.doesNotMatch(clientSource, /^\s*import\s/m);
  const specs = [...clientSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(specs)], ['react']);
});

check('DOM 只在函数内取且有 typeof document 守卫', () => {
  assert.match(clientSource, /typeof document === 'undefined'/);
  assert.doesNotMatch(clientSource, /^\s*(?:const|let|var)\s+\w+\s*=\s*document\b/m);
});

check('工作区行选择器与标题契约正确', () => {
  assert.equal(TEST.ROW_SELECTOR, '[data-row-key^="workspace:"]');
  assert.ok(clientSource.includes("'workspace:'"));
  assert.ok(clientSource.includes("row.insertBefore(badge, row.firstChild === undefined ? null : row.firstChild)"));
});

check('隐藏工作区的选择器 / 属性 / 菜单契约正确', () => {
  assert.equal(TEST.HIDDEN_ATTR, 'data-dsh-tishi-hidden');
  assert.equal(TEST.HIDDEN_STORAGE_KEY, 'dsh-tishi.hiddenWorkspaces.v1');
  assert.equal(TEST.MENU_ID, 'dsh-tishi.workspace-menu');
  assert.equal(TEST.MENU_ORDER, 250);
  assert.equal(TEST.SESSION_ROW_SELECTOR, '[data-row-key^="session:"]');
  assert.equal(TEST.OVERFLOW_ROW_SELECTOR, '[data-row-key^="overflow:"]');
  assert.match(clientSource, /inject: \['slots', 'contextMenus'\]/);
  assert.match(clientSource, /ctx\.contextMenus/);
});

check('CSS 含隐藏标记规则', () => {
  assert.ok(TEST.CSS.includes('[data-dsh-tishi-hidden]'));
  assert.ok(TEST.CSS.includes('display:none !important'));
});

check('CSS 只用主题 token，且三种状态 token 都在', () => {
  for (const token of [
    'var(--dsw-alias-state-warn-primary)',
    'var(--dsw-alias-state-business-primary)',
    'var(--dsw-alias-state-done-primary)',
    'var(--dsw-alias-label-secondary)',
  ]) {
    assert.ok(TEST.CSS.includes(token), `missing ${token}`);
  }
  assert.doesNotMatch(TEST.CSS, /#[0-9a-fA-F]{3,8}\b/);
});

check('CSS 含不拦截点击 + 减弱动画支持', () => {
  assert.ok(TEST.CSS.includes('pointer-events:none'));
  assert.ok(TEST.CSS.includes('prefers-reduced-motion'));
  assert.ok(TEST.CSS.includes('@keyframes dsh-tishi-spin'));
});

check('CSS 含面板栏 7 行上限 / 栏内滚动 / 收起保留 / 排序浮层', () => {
  for (const fragment of [
    'max-height:min(calc(7 * 36px + 8 * 2px + 24px),50vh)',
    'overflow-y:auto',
    'overscroll-behavior:contain',
    'position:sticky',
    '--dsh-scrollbar-thumb',
    '[data-dsh-tishi-panel-control]{position:sticky',
    '[data-dsh-tishi-panel-sort-panel]',
    'nav[data-dsh-tishi-panels-collapsed]>*:not([data-dsh-tishi-panel-control]):not([data-dsh-tishi-panel-keep]){display:none !important}',
  ]) {
    assert.ok(TEST.CSS.includes(fragment), `missing ${fragment}`);
  }
});

check('CSS 含隐藏新会话 / 高度拖动 / 「⋯」浮层规则', () => {
  for (const fragment of [
    '[data-dsh-tishi-hide-new-session]{display:none !important}',
    'nav[data-dsh-tishi-panel-nav][data-dsh-tishi-panel-height]{max-height:none}',
    'nav[data-dsh-tishi-panel-height] [data-dsh-tishi-panel-control]{margin-top:auto}',
    '[data-dsh-tishi-panel-handle]{position:absolute',
    'cursor:ns-resize',
    'nav[data-dsh-tishi-panels-collapsed] [data-dsh-tishi-panel-handle]{display:none}',
    '[data-dsh-tishi-panel-menu-panel]{position:fixed',
    '[data-dsh-tishi-panel-menu-item][disabled]',
  ]) {
    assert.ok(TEST.CSS.includes(fragment), `missing ${fragment}`);
  }
});

check('侧栏显示契约：隐藏键 / 高度键 / 上下限 / 默认值', () => {
  assert.equal(TEST.HIDE_NEW_SESSION_ATTR, 'data-dsh-tishi-hide-new-session');
  assert.equal(TEST.HIDE_NEW_SESSION_STORAGE_KEY, 'dsh-tishi.hideNewSession.v1');
  assert.equal(TEST.HIDE_NEW_SESSION_FALLBACK, true);
  assert.equal(TEST.PANEL_HEIGHT_ATTR, 'data-dsh-tishi-panel-height');
  assert.equal(TEST.PANEL_HANDLE_ATTR, 'data-dsh-tishi-panel-handle');
  assert.equal(TEST.PANEL_HEIGHT_STORAGE_KEY, 'dsh-tishi.panelNavHeight.v1');
  assert.equal(TEST.PANEL_HEIGHT_MIN, 96);
  assert.equal(TEST.PANEL_WORKSPACE_MIN, 120);
  assert.equal(TEST.PANEL_HEIGHT_STEP, 16);
  assert.equal(TEST.PANEL_MENU_ATTR, 'data-dsh-tishi-panel-menu');
  assert.equal(TEST.PANEL_MENU_PANEL_ATTR, 'data-dsh-tishi-panel-menu-panel');
  // 没有存储 / 没有 document 时的降级。
  assert.equal(TEST.loadNewSessionHidden(), true);
  assert.equal(TEST.loadPanelHeight(), null);
  assert.equal(TEST.panelHeightMax(null), 0);
  assert.equal(TEST.clampPanelHeight(null, 200), 200);
  assert.equal(TEST.findNewSessionButton(null), null);
  assert.equal(TEST.setNewSessionHidden(null, false), false);
});

check('控制器接线：同步应用隐藏/高度，卸载收尾拖动与浮层', () => {
  assert.ok(clientSource.includes('applyNewSessionHidden(nav, newSessionHidden);'));
  assert.ok(clientSource.includes('applyPanelHeight(nav, panelCollapsed ? null : panelHeight);'));
  assert.ok(/function removePanelNavDecor\(doc\) \{\n\s*panelNavCache = null;\n\s*stopPanelResize\(\);\n\s*closePanelSortPanel\(\);\n\s*closePanelMenuPanel\(\);/.test(clientSource));
  assert.ok(clientSource.includes("doc.addEventListener('pointermove', onMove);"));
  assert.ok(clientSource.includes("doc.addEventListener('pointerup', onEnd);"));
  // 找按钮必须止步于 logo 行（data-window-drag），否则会连品牌 / 折叠按钮一起藏掉。
  assert.ok(clientSource.includes("node.hasAttribute('data-window-drag')"));
  assert.ok(clientSource.includes("node.querySelector('button')"));
});

check('面板栏契约：属性 / 存储键 / 行数上限 / rail 阈值', () => {
  assert.equal(TEST.PANEL_NAV_ATTR, 'data-dsh-tishi-panel-nav');
  assert.equal(TEST.PANEL_COLLAPSED_ATTR, 'data-dsh-tishi-panels-collapsed');
  assert.equal(TEST.PANEL_TOGGLE_ATTR, 'data-dsh-tishi-panel-toggle');
  assert.equal(TEST.PANEL_CONTROL_ATTR, 'data-dsh-tishi-panel-control');
  assert.equal(TEST.PANEL_KEEP_ATTR, 'data-dsh-tishi-panel-keep');
  assert.equal(TEST.PANEL_SORT_PANEL_ATTR, 'data-dsh-tishi-panel-sort-panel');
  assert.equal(TEST.PANEL_COLLAPSED_STORAGE_KEY, 'dsh-tishi.panelNavCollapsed.v1');
  assert.equal(TEST.PANEL_ORDER_STORAGE_KEY, 'dsh-tishi.panelNavOrder.v1');
  assert.equal(TEST.PANEL_VISIBLE_ROWS, 7);
  assert.equal(TEST.PANEL_COLLAPSED_VISIBLE, 2);
  assert.equal(TEST.PANEL_RAIL_MAX_WIDTH, 120);
  assert.equal(TEST.loadPanelCollapsed(), false);
  assert.deepEqual(TEST.loadPanelOrder(), []);
  assert.equal(TEST.findPanelNav(null), null);
  assert.equal(TEST.removePanelNavDecor(null), 0);
});

check('面板栏定位不依赖宿主哈希 class / 固定文案', () => {
  assert.doesNotMatch(clientSource, /_panelList|_panelRow|_regionArea/);
  assert.ok(clientSource.includes("doc.querySelectorAll('nav')"));
  assert.doesNotMatch(clientSource, /querySelector\\('nav'\\)/);
});

check('控制器接线：sync 调 syncPanelNav、卸载调 removePanelNavDecor', () => {
  assert.ok(clientSource.includes('syncHiddenRows(doc, hidden);'));
  assert.ok(clientSource.includes('syncPanelNav(doc);'));
  assert.ok(clientSource.includes('removeAllHidden(doc);'));
  assert.ok(clientSource.includes('removePanelNavDecor(doc);'));
});

check('面板栏测试钩子齐全', () => {
  for (const key of [
    'PANEL_NAV_ATTR',
    'PANEL_COLLAPSED_ATTR',
    'PANEL_TOGGLE_ATTR',
    'PANEL_TOGGLE_LABEL_ATTR',
    'PANEL_CHEVRON_ATTR',
    'PANEL_COLLAPSED_STORAGE_KEY',
    'PANEL_NAV_SELECTOR',
    'PANEL_VISIBLE_ROWS',
    'PANEL_COLLAPSED_VISIBLE',
    'PANEL_KEEP_ATTR',
    'PANEL_CONTROL_ATTR',
    'PANEL_SORT_ATTR',
    'PANEL_SORT_PANEL_ATTR',
    'PANEL_SORT_ROW_SELECTOR',
    'PANEL_SORT_MOVE_SELECTOR',
    'PANEL_SORT_CLOSE_SELECTOR',
    'PANEL_ORDER_STORAGE_KEY',
    'loadPanelCollapsed',
    'savePanelCollapsed',
    'loadPanelOrder',
    'savePanelOrder',
    'getPanelOrder',
    'setPanelOrder',
    'findPanelNav',
    'findPanelControl',
    'findPanelToggle',
    'panelNavIsRail',
    'panelHostChildren',
    'panelKey',
    'applyPanelOrder',
    'markCollapsedKeep',
    'shiftPanelOrder',
    'applyPanelCollapsed',
    'syncPanelNav',
    'removePanelNavDecor',
    'openPanelSortPanel',
    'closePanelSortPanel',
    'resetPanelNav',
    'PANEL_HEIGHT_ATTR',
    'PANEL_HANDLE_ATTR',
    'PANEL_HEIGHT_SELECTOR',
    'PANEL_MENU_ATTR',
    'PANEL_MENU_PANEL_ATTR',
    'PANEL_MENU_ITEM_ATTR',
    'PANEL_MENU_ITEM_SELECTOR',
    'HIDE_NEW_SESSION_ATTR',
    'HIDE_NEW_SESSION_STORAGE_KEY',
    'HIDE_NEW_SESSION_FALLBACK',
    'PANEL_HEIGHT_STORAGE_KEY',
    'PANEL_HEIGHT_MIN',
    'PANEL_WORKSPACE_MIN',
    'PANEL_HEIGHT_STEP',
    'PANEL_MENU_TEXT',
    'PANEL_HEIGHT_TEXT',
    'loadNewSessionHidden',
    'saveNewSessionHidden',
    'getNewSessionHidden',
    'findNewSessionButton',
    'applyNewSessionHidden',
    'setNewSessionHidden',
    'loadPanelHeight',
    'savePanelHeight',
    'getPanelHeight',
    'panelHeightMax',
    'clampPanelHeight',
    'applyPanelHeight',
    'resetPanelHeight',
    'findPanelHandle',
    'findPanelMenuButton',
    'openPanelMenuPanel',
    'closePanelMenuPanel',
    'isPanelMenuOpen',
    'isPanelResizing',
    'stopPanelResize',
  ]) {
    assert.ok(key in TEST, `missing hook ${key}`);
  }
});

check('package.json 声明完整', () => {
  assert.equal(packageJson.name, 'dsh-tishi');
  assert.equal(packageJson.version, '0.1.0');
  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.main, 'index.js');
  assert.equal(packageJson.exports['./client'], './client.js');
  assert.equal(packageJson.dsh.client.platform, 'web');
  assert.equal(packageJson.dsh.client.immediately, true);
});

check('Host 空壳形状正确且不碰 DOM', () => {
  assert.match(hostSource, /export const name = 'dsh-tishi'/);
  assert.match(hostSource, /export function apply\(\) \{\}/);
  assert.doesNotMatch(hostSource, /\b(document|window)\b/);
});

check('cordis.patch.yml 有 id 与 name', () => {
  assert.match(patchSource, /id: dsh-tishi/);
  assert.match(patchSource, /name: dsh-tishi/);
});

check('测试钩子齐全且注册号正确', () => {
  for (const key of [
    'computeWorkspaceBadges',
    'describeBadge',
    'syncBadges',
    'StatusBadgeController',
    'installStyle',
    'createBadge',
    'applyBadge',
    'ensureBadge',
    'findBadge',
    'removeAllBadges',
    'apply',
    'syncHiddenRows',
    'removeAllHidden',
    'nearestWorkspaceRow',
    'buildWorkspaceMenuItems',
    'resolveWorkspaceMenu',
    'canHideWorkspace',
    'rootWorkspaceIds',
    'workspaceParentMap',
    'workspaceLabel',
    'hideWorkspace',
    'showWorkspace',
    'showAllWorkspaces',
    'loadHiddenIds',
    'saveHiddenIds',
    'reconcileHidden',
  ]) {
    assert.ok(key in TEST, `missing hook ${key}`);
  }
  assert.equal(TEST.SLOT, 'shell.overlay');
  assert.equal(TEST.REGISTER_ID, 'dsh-tishi.status-badges');
  assert.equal(TEST.REGISTER_ORDER, 900);
});

const hostPlugin = await import(pathToFileURL(path.join(root, 'index.js')).href);
assert.equal(hostPlugin.name, 'dsh-tishi');
assert.equal(typeof hostPlugin.apply, 'function');
assert.equal(hostPlugin.apply(), undefined);
checks += 1;
console.log('PASS Host 半边可独立 import（name/apply 正确）');

console.log(`\nVERIFY OK checks=${checks}`);

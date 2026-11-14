/**
 * dsh-tishi —— 浏览器半边（侧栏「工作区」行状态角标）。
 *
 * 需求：侧栏「工作区」每一行的 folder 图标前，显示该工作区自身及其下全部后代工作区的聚合状态，
 * 且多个状态可以同时出现——待处理（橙点）/ 运行中（蓝圈）/ 未读完成（绿点），
 * 计数 > 1 才显示数字；工作区折叠、或会话被 watermark「收起」时也能看到。
 *
 * 附加需求（2026-11-06）：「隐藏工作区」——工作区右键菜单 /「…」菜单可把该工作区
 * 的标题行和它自己的会话行从侧栏藏起来，不删登记/会话/文件；任意可见工作区的菜单
 * 里提供「已隐藏的工作区 (N)」子菜单用于恢复。隐藏状态存 localStorage，刷新保持。
 *
 * 附加需求（2026-11-10）：侧栏「工作区」上方的全局面板栏（插件/…/更多）一次最多显示 7 个，
 * 超出部分在栏内滚动；栏尾自绘控制行（收起 / 展开 + 排序），收起时保留最上面 2 个入口，
 * 面板顺序可调；折叠与顺序状态存 localStorage，刷新保持。
 *
 * 官方契约（2026-11-06 版，证据见 HANDOFF §2）：
 *   - 工作区行是 `div[data-row-key="workspace:<workspaceId>"]`，首个子元素是 folder 图标；
 *   - 会话行 /「收起」按钮的 key 是 `session:<sessionId>` / `overflow:<workspaceId>`；
 *   - `shell.overlay` 是常驻 list slot，其标准 props 含
 *     `useWorkspaces / useSessions / useSessionStatus`；
 *   - 工作区右键菜单的目标是 `{ kind: 'workspace', value: { workspaceId, path, displayTitle } }`，
 *     扩展点 `ctx.contextMenus.register({ id, target, order, resolve })`；
 *   - 每个会话只计一个类别，优先级 = 待处理 > 运行中 > 未读完成 > idle。
 *
 * 实现原则：
 *   - 不注册可见 UI，控制器返回 null，只对侧栏 DOM 做装饰；
 *   - 只 require('react')，不引任何 Harness Client 包；
 *   - 数据只走标准 props 的 selector hooks（实时）；DOM 契约变化时静默降级；
 *   - 角标 pointer-events:none，绝不拦截行的点击 / 拖拽 / 右键。
 */

window.__ModuleLoader__.load({
  id: 'dsh-tishi',
  factory(require) {
    'use strict';

    const React = require('react');

    // ---------------------------------------------------------------- 常量

    const PLUGIN_ID = 'dsh-tishi';
    const SLOT = 'shell.overlay';
    const REGISTER_ID = 'dsh-tishi.status-badges';
    const REGISTER_ORDER = 900;

    /** 官方工作区行选择器；`data-row-key` 的后缀就是 workspaceId。 */
    const ROW_SELECTOR = '[data-row-key^="workspace:"]';
    const ROW_KEY_PREFIX = 'workspace:';

    const BADGE_ATTR = 'data-dsh-tishi-status';
    const BADGE_ORDER = ['pending', 'running', 'done'];
    const BADGE_LABELS = { pending: '待处理', running: '运行中', done: '未读完成' };
    const PENDING_KINDS = new Set(['approval', 'question', 'plan-review']);

    // ---- 隐藏工作区：右键菜单 + DOM display:none ----

    /** 菜单提供方 ID / 顺序（官方 workspace 菜单：rename=100、delete=300）。 */
    const MENU_ID = 'dsh-tishi.workspace-menu';
    const MENU_ORDER = 250;
    const WORKSPACE_MENU_TARGET = 'workspace';

    /** 隐藏标记属性；CSS 用 !important 压过官方行的 display:flex。 */
    const HIDDEN_ATTR = 'data-dsh-tishi-hidden';
    const HIDDEN_STORAGE_KEY = 'dsh-tishi.hiddenWorkspaces.v1';
    const HIDDEN_STORAGE_VERSION = 1;

    // ---- 全局面板栏：一次 7 行 + 栏内滚动 + 收起保留 2 个 + 排序 ----

    /** 装饰标记：PANEL_NAV_ATTR 在已装饰的 nav 上；PANEL_COLLAPSED_ATTR 存在即已收起。 */
    const PANEL_NAV_ATTR = 'data-dsh-tishi-panel-nav';
    const PANEL_COLLAPSED_ATTR = 'data-dsh-tishi-panels-collapsed';
    const PANEL_TOGGLE_ATTR = 'data-dsh-tishi-panel-toggle';
    const PANEL_TOGGLE_LABEL_ATTR = 'data-dsh-tishi-panel-toggle-label';
    const PANEL_CHEVRON_ATTR = 'data-dsh-tishi-panel-chevron';
    const PANEL_COLLAPSED_STORAGE_KEY = 'dsh-tishi.panelNavCollapsed.v1';
    const PANEL_COLLAPSED_STORAGE_VERSION = 1;
    /** 侧栏 rail（窄栏）宽度上限：窄于此值不做任何装饰，保持宿主原样。 */
    const PANEL_RAIL_MAX_WIDTH = 120;
    const PANEL_TOGGLE_TEXT = { expanded: '收起面板', collapsed: '展开面板' };

    /** 一次最多显示的面板行数：超出在栏内滚动；收起时保留最上面两行。 */
    const PANEL_VISIBLE_ROWS = 7;
    const PANEL_COLLAPSED_VISIBLE = 2;
    /** 收起态保留行的标记（由 sync 维护，CSS 只在收起态使用）。 */
    const PANEL_KEEP_ATTR = 'data-dsh-tishi-panel-keep';
    /** 控制行：sticky 吸底，内含「收起/展开」与「排序」两个按钮。 */
    const PANEL_CONTROL_ATTR = 'data-dsh-tishi-panel-control';
    const PANEL_SORT_ATTR = 'data-dsh-tishi-panel-sort';
    const PANEL_SORT_PANEL_ATTR = 'data-dsh-tishi-panel-sort-panel';
    const PANEL_SORT_HEAD_ATTR = 'data-dsh-tishi-panel-sort-head';
    const PANEL_SORT_LIST_ATTR = 'data-dsh-tishi-panel-sort-list';
    const PANEL_SORT_ROW_ATTR = 'data-dsh-tishi-panel-sort-row';
    const PANEL_SORT_NAME_ATTR = 'data-dsh-tishi-panel-sort-name';
    const PANEL_SORT_MOVE_ATTR = 'data-dsh-tishi-panel-sort-move';
    const PANEL_SORT_CLOSE_ATTR = 'data-dsh-tishi-panel-sort-close';
    /** 面板显示顺序：按 aria-label 记，宿主改语言时失配则回落宿主顺序。 */
    const PANEL_ORDER_STORAGE_KEY = 'dsh-tishi.panelNavOrder.v1';
    const PANEL_ORDER_STORAGE_VERSION = 1;
    const PANEL_SORT_TEXT = { title: '调整面板顺序', close: '关闭', up: '上移', down: '下移' };

    // ---- 侧栏显示：隐藏「＋ 新会话」按钮 / 入口区与工作区之间可拖动 ----

    /** 入口区自定义高度：给 nav 写内联 height（px），null = 回到 CSS 默认的 7 行上限。 */
    const PANEL_HEIGHT_ATTR = 'data-dsh-tishi-panel-height';
    const PANEL_HANDLE_ATTR = 'data-dsh-tishi-panel-handle';
    const PANEL_HEIGHT_STORAGE_KEY = 'dsh-tishi.panelNavHeight.v1';
    const PANEL_HEIGHT_STORAGE_VERSION = 1;
    /** 入口区最小高度 / 工作区至少保留的高度 / 键盘微调步长。 */
    const PANEL_HEIGHT_MIN = 96;
    const PANEL_WORKSPACE_MIN = 120;
    const PANEL_HEIGHT_STEP = 16;
    const PANEL_HEIGHT_TEXT = { label: '拖动调整入口区高度（双击恢复默认）', reset: '恢复默认高度' };

    /** 隐藏顶部「＋ 新会话」按钮（宽栏生效；rail 窄栏仍保留那颗固定定位的图标）。 */
    const HIDE_NEW_SESSION_ATTR = 'data-dsh-tishi-hide-new-session';
    const HIDE_NEW_SESSION_STORAGE_KEY = 'dsh-tishi.hideNewSession.v1';
    const HIDE_NEW_SESSION_STORAGE_VERSION = 1;
    /** 无存储值时的默认：隐藏（用户明确要求删掉这颗按钮）。 */
    const HIDE_NEW_SESSION_FALLBACK = true;

    /** 控制行第三个按钮「⋯」→「侧栏显示」浮层（隐藏开关 / 高度复位）。 */
    const PANEL_MENU_ATTR = 'data-dsh-tishi-panel-menu';
    const PANEL_MENU_PANEL_ATTR = 'data-dsh-tishi-panel-menu-panel';
    const PANEL_MENU_HEAD_ATTR = 'data-dsh-tishi-panel-menu-head';
    const PANEL_MENU_LIST_ATTR = 'data-dsh-tishi-panel-menu-list';
    const PANEL_MENU_ITEM_ATTR = 'data-dsh-tishi-panel-menu-item';
    const PANEL_MENU_CHECK_ATTR = 'data-dsh-tishi-panel-menu-check';
    const PANEL_MENU_CLOSE_ATTR = 'data-dsh-tishi-panel-menu-close';
    const PANEL_MENU_TEXT = {
      title: '侧栏显示',
      hide: '隐藏「＋ 新会话」按钮',
      reset: '恢复默认入口区高度',
      close: '关闭',
    };

    /** 会话行 /「收起」按钮的官方 data-row-key 前缀。 */
    const SESSION_ROW_SELECTOR = '[data-row-key^="session:"]';
    const SESSION_ROW_PREFIX = 'session:';
    const OVERFLOW_ROW_SELECTOR = '[data-row-key^="overflow:"]';
    const OVERFLOW_ROW_PREFIX = 'overflow:';

    /**
     * 有活动就显示，不限折叠态。
     * 改成 false = 只在折叠工作区上显示（检查 aria-expanded === 'false'）。
     */
    const SHOW_WHEN_EXPANDED = true;

    /** 兜底扫描间隔：处理行新增/删除、非点击方式触发的折叠/展开。 */
    const SYNC_INTERVAL_MS = 1000;

    const STYLE_ID = 'dsh-tishi-status-style';
    const STYLE_ATTR = 'data-plugin';
    const STYLE_CSS_ATTR = 'data-plugin-css';

    const ZERO_COUNTS = Object.freeze({ pending: 0, running: 0, done: 0, total: 0 });

    const CSS = [
      // 角标块：行内、紧贴 folder 图标左侧；不拦截任何指针事件。
      '[data-dsh-tishi-status]{display:inline-flex;align-items:center;gap:3px;flex:0 0 auto;margin-right:4px;pointer-events:none;user-select:none;line-height:1;font-size:10px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tishi-item{display:inline-flex;align-items:center;gap:1px}',
      '.dsh-tishi-item b{font-weight:650;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dsh-tishi-dot{display:block;width:6px;height:6px;border-radius:50%}',
      '.dsh-tishi-item.is-pending .dsh-tishi-dot{background:var(--dsw-alias-state-warn-primary)}',
      '.dsh-tishi-item.is-done .dsh-tishi-dot{background:var(--dsw-alias-state-done-primary)}',
      '.dsh-tishi-spin{display:block;width:7px;height:7px;border-radius:50%;box-sizing:border-box;border:1.5px solid var(--dsw-alias-state-business-primary);border-top-color:transparent;animation:dsh-tishi-spin .9s linear infinite}',
      '@keyframes dsh-tishi-spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion: reduce){.dsh-tishi-spin{animation:none}}',
      // 隐藏的工作区标题行 / 会话行 /「收起」按钮：不占布局、不进 tab 顺序。
      '[data-dsh-tishi-hidden]{display:none !important}',
      // 全局面板栏：最多 PANEL_VISIBLE_ROWS 行（+ 控制行），超出在栏内滚动；overscroll 不穿透。
      'nav[data-dsh-tishi-panel-nav]{max-height:min(calc(' + PANEL_VISIBLE_ROWS + ' * 36px + ' + (PANEL_VISIBLE_ROWS + 1) + ' * 2px + 24px),50vh);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsh-scrollbar-thumb,var(--dsw-alias-scrollbar-bg-l2)) transparent}',
      'nav[data-dsh-tishi-panel-nav]::-webkit-scrollbar{width:8px}',
      'nav[data-dsh-tishi-panel-nav]::-webkit-scrollbar-track{background:transparent}',
      'nav[data-dsh-tishi-panel-nav]::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb,var(--dsw-alias-scrollbar-bg-l2));border-radius:4px}',
      'nav[data-dsh-tishi-panel-nav]::-webkit-scrollbar-thumb:hover{background:var(--dsh-scrollbar-thumb-hover,var(--dsw-alias-scrollbar-hover-l2))}',
      // 栏尾控制行：sticky 吸底，滚到哪都能点；实色底遮住滚动内容。
      '[data-dsh-tishi-panel-control]{position:sticky;bottom:0;z-index:1;flex:0 0 auto;display:flex;align-items:center;gap:2px;margin-top:2px;padding:0 2px 0 calc(var(--dsh-sidebar-row-padding,12px) - var(--dsh-sidebar-paint-inset,3px));border-top:1px solid var(--dsw-alias-scrollbar-bg-l2);background:var(--dsw-specific-sidebar-fill)}',
      '[data-dsh-tishi-panel-toggle]{flex:1 1 auto;display:flex;align-items:center;gap:var(--dsh-sidebar-label-gap,6px);min-height:22px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer;appearance:none}',
      '[data-dsh-tishi-panel-toggle]:hover{color:var(--dsw-alias-label-primary)}',
      '[data-dsh-tishi-panel-toggle]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
      '[data-dsh-tishi-panel-sort]{flex:0 0 auto;min-height:22px;padding:0 6px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:18px;cursor:pointer;appearance:none}',
      '[data-dsh-tishi-panel-sort]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '[data-dsh-tishi-panel-sort]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
      '[data-dsh-tishi-panel-chevron]{width:7px;height:7px;flex:0 0 auto;border-left:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(1px) rotate(135deg)}',
      // 收起态：只留控制行 + 最上面两行；取消高度限制，把空间让给工作区。
      'nav[data-dsh-tishi-panels-collapsed]{max-height:none;overflow:visible}',
      'nav[data-dsh-tishi-panels-collapsed]>*:not([data-dsh-tishi-panel-control]):not([data-dsh-tishi-panel-keep]){display:none !important}',
      'nav[data-dsh-tishi-panels-collapsed] [data-dsh-tishi-panel-chevron]{transform:translateY(-1px) rotate(-45deg)}',
      // 排序浮层：挂 body、fixed 定位，不受侧栏 overflow 裁剪。
      '[data-dsh-tishi-panel-sort-panel]{position:fixed;z-index:9999;width:236px;max-height:min(60vh,420px);overflow:auto;padding:6px;border-radius:10px;border:1px solid var(--dsw-alias-scrollbar-bg-l2);background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px rgba(0,0,0,.35);backdrop-filter:blur(12px);font-size:12px;line-height:18px}',
      '[data-dsh-tishi-panel-sort-head]{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 4px 6px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '[data-dsh-tishi-panel-sort-close]{flex:0 0 auto;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer}',
      '[data-dsh-tishi-panel-sort-close]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '[data-dsh-tishi-panel-sort-row]{display:flex;align-items:center;gap:4px;padding:2px;border-radius:6px}',
      '[data-dsh-tishi-panel-sort-row]:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '[data-dsh-tishi-panel-sort-name]{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '[data-dsh-tishi-panel-sort-move]{flex:0 0 auto;width:22px;height:22px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '[data-dsh-tishi-panel-sort-move]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '[data-dsh-tishi-panel-sort-move][disabled]{opacity:.35;cursor:default}',
      // 隐藏「＋ 新会话」按钮（宽栏）：只留 logo 行，点 logo 仍能新建会话。
      '[data-dsh-tishi-hide-new-session]{display:none !important}',
      // 自定义入口区高度：控制行贴到 nav 底边，拖动手柄正好压在边界上。
      'nav[data-dsh-tishi-panel-nav][data-dsh-tishi-panel-height]{max-height:none}',
      'nav[data-dsh-tishi-panel-height] [data-dsh-tishi-panel-control]{margin-top:auto}',
      // 拖动手柄：压在控制行下沿（= nav 的底边 = 入口区/工作区分界）内侧，8px 热区；
      // 不能伸出 nav，否则会被 nav 的 overflow:auto 裁掉。hover / 聚焦才画出细线。
      '[data-dsh-tishi-panel-handle]{position:absolute;left:0;right:0;bottom:0;z-index:2;display:flex;height:8px;align-items:center;justify-content:center;touch-action:none;cursor:ns-resize;background:transparent}',
      '[data-dsh-tishi-panel-handle]>span{display:block;width:36px;height:2px;border-radius:1px;background:var(--dsw-alias-scrollbar-bg-l2);opacity:0;transition:opacity .15s}',
      '[data-dsh-tishi-panel-handle]:hover>span,[data-dsh-tishi-panel-handle]:focus-visible>span{opacity:1;background:var(--dsw-alias-state-business-primary)}',
      '[data-dsh-tishi-panel-handle]:focus-visible{outline:none}',
      'nav[data-dsh-tishi-panels-collapsed] [data-dsh-tishi-panel-handle]{display:none}',
      // 「侧栏显示」浮层：挂 body、fixed 定位，不受侧栏 overflow 裁剪。
      '[data-dsh-tishi-panel-menu-panel]{position:fixed;z-index:9999;width:236px;padding:6px;border-radius:10px;border:1px solid var(--dsw-alias-scrollbar-bg-l2);background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px rgba(0,0,0,.35);backdrop-filter:blur(12px);font-size:12px;line-height:18px}',
      '[data-dsh-tishi-panel-menu-head]{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 4px 6px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '[data-dsh-tishi-panel-menu-close]{flex:0 0 auto;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer}',
      '[data-dsh-tishi-panel-menu-close]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '[data-dsh-tishi-panel-menu-item]{display:flex;align-items:center;gap:6px;width:100%;padding:5px 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer;appearance:none}',
      '[data-dsh-tishi-panel-menu-item]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover)}',
      '[data-dsh-tishi-panel-menu-item][disabled]{opacity:.4;cursor:default}',
      '[data-dsh-tishi-panel-menu-check]{flex:0 0 auto;width:12px;color:var(--dsw-alias-state-business-primary);font-size:11px}',
    ].join('');

    // -------------------------------------------------------------- 小工具

    /** selector 的恒等投影：拿整个快照。 */
    function identity(value) {
      return value;
    }

    /** 缺标准 props 时的稳定空实现（hooks 顺序不变）。 */
    function noSnapshot() {
      return null;
    }

    /** 空操作：未安装 / 已卸载时的 sync 兜底。 */
    function noop() {}

    /** 只打一次降级日志，避免每秒刷屏。 */
    let warned = false;
    function warnOnce(error) {
      if (warned) return;
      warned = true;
      if (typeof console === 'object' && console !== null && typeof console.debug === 'function') {
        console.debug('[dsh-tishi] status badge sync skipped:', error);
      }
    }

    /** `document` 只在函数内取，且做存在性检测（离线测试环境没有 DOM）。 */
    function getDocument() {
      return typeof document === 'undefined' ? null : document;
    }

    /**
     * 把 archivedSessionIds 归一成 Set；只接受字符串 id。
     * @param {unknown} value - 快照字段。
     * @returns {Set<string>} id 集合。
     */
    function toIdSet(value) {
      if (value instanceof Set) return value;
      const ids = new Set();
      if (Array.isArray(value)) {
        for (const id of value) {
          if (typeof id === 'string' && id !== '') ids.add(id);
        }
      }
      return ids;
    }

    // -------------------------------------------------- 隐藏状态（持久化）

    /** `window` 只在函数内取；存储不可用（隐私模式/配额）时退化为纯内存。 */
    function getStorage() {
      if (typeof window === 'undefined' || window === null) return null;
      try {
        const storage = window.localStorage;
        return storage !== null && storage !== undefined && typeof storage.getItem === 'function' ? storage : null;
      } catch (error) {
        return null;
      }
    }

    /** 把任意输入归一成「非空字符串 id 的 Set」。 */
    function normalizeHidden(value) {
      const ids = new Set();
      const source = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
      for (const id of source) {
        if (typeof id === 'string' && id !== '') ids.add(id);
      }
      return ids;
    }

    /** 读 localStorage；缺存储 / 坏 JSON / 旧格式都退化为空 Set，不抛错。 */
    function loadHiddenIds() {
      const storage = getStorage();
      if (storage === null) return new Set();
      try {
        const raw = storage.getItem(HIDDEN_STORAGE_KEY);
        if (typeof raw !== 'string' || raw === '') return new Set();
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return normalizeHidden(parsed);
        if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.ids)) return normalizeHidden(parsed.ids);
        return new Set();
      } catch (error) {
        return new Set();
      }
    }

    /** 尽力写 localStorage；失败保持内存态（调用方不感知）。 */
    function saveHiddenIds(ids) {
      const storage = getStorage();
      if (storage === null || typeof storage.setItem !== 'function') return false;
      try {
        storage.setItem(
          HIDDEN_STORAGE_KEY,
          JSON.stringify({ v: HIDDEN_STORAGE_VERSION, ids: [...normalizeHidden(ids)] }),
        );
        return true;
      } catch (error) {
        return false;
      }
    }

    /** 当前被隐藏的 workspaceId 集合（模块级单例，localStorage 初始化）。 */
    let hiddenIds = loadHiddenIds();
    /** 菜单 resolve 用的最新工作区/角标快照；控制器每次渲染刷新。 */
    const latest = { items: [], badges: new Map() };
    /** 控制器挂载期间指向 sync；菜单动作改完状态后立即刷新 DOM。 */
    let requestSync = noop;
    /** contextMenus 服务（apply 时捕获），用于 toast；卸载置空。 */
    let menuApi = null;

    /** @returns {Set<string>} 当前隐藏集合。 */
    function getHiddenIds() {
      return hiddenIds;
    }

    /** 只改内存 + 存储，不触发 DOM（调用方决定何时 sync）。 */
    function setHiddenIds(value) {
      hiddenIds = normalizeHidden(value);
      saveHiddenIds(hiddenIds);
      return hiddenIds;
    }

    // -------------------------------------------------------- 数据聚合（纯）

    /**
     * 计算每个工作区的角标计数。
     *
     * 规则（与官方 sessionStatuses 的优先级一致）：
     *   pendingInteraction.kind ∈ {approval, question, plan-review} → pending；
     *   否则 running → running；否则 completionUnread === true → done；否则 idle 不计。
     * 归档会话跳过；workspaceId 为空（未归入桶）跳过；子智能体本期不计。
     *
     * 每个工作区的返回值 = 自身会话 + workspace.path 下全部后代工作区的会话；
     * 父工作区折叠、子工作区未渲染时也按数据汇总。
     *
     * @param {object|null|undefined} workspaceSnapshot - useWorkspaces 的快照。
     * @param {Map<string, object>|null|undefined} statuses - useSessionStatus 的 Map。
     * @param {object|null|undefined} sessionList - useSessions 的快照（running 兜底）。
     * @returns {Map<string, {pending:number,running:number,done:number,total:number}>} 每个工作区一项（无活动时全 0）。
     */
    function computeWorkspaceBadges(workspaceSnapshot, statuses, sessionList) {
      const ownBadges = new Map();
      const snapshot = workspaceSnapshot !== null && typeof workspaceSnapshot === 'object' ? workspaceSnapshot : null;
      const items = snapshot !== null && Array.isArray(snapshot.items) ? snapshot.items : [];
      const archived = toIdSet(snapshot !== null ? snapshot.archivedSessionIds : undefined);
      const statusOf =
        statuses !== null && typeof statuses === 'object' && typeof statuses.get === 'function'
          ? (id) => statuses.get(id)
          : () => undefined;
      const byId =
        sessionList !== null && typeof sessionList === 'object' && sessionList.byId !== null && typeof sessionList.byId === 'object'
          ? sessionList.byId
          : null;

      for (const workspace of items) {
        if (workspace === null || typeof workspace !== 'object') continue;
        const workspaceId = typeof workspace.workspaceId === 'string' ? workspace.workspaceId : '';
        if (workspaceId === '') continue;
        const counts = { pending: 0, running: 0, done: 0, total: 0 };
        const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
        for (const sessionId of sessionIds) {
          if (typeof sessionId !== 'string' || sessionId === '') continue;
          if (archived.has(sessionId)) continue;
          const status = statusOf(sessionId);
          const summaryCandidate = byId !== null ? byId[sessionId] : undefined;
          const summary = summaryCandidate !== null && typeof summaryCandidate === 'object' ? summaryCandidate : null;
          // 与官方 sessionVisible 对齐：子智能体会话不占工作区行的主状态（其运行数单独展示）。
          if (summary !== null && summary.origin === 'subagent') continue;
          const pendingInteraction = status !== null && status !== undefined && status.pendingInteraction !== null && typeof status.pendingInteraction === 'object' ? status.pendingInteraction : null;
          if (pendingInteraction !== null && PENDING_KINDS.has(pendingInteraction.kind)) {
            counts.pending += 1;
            continue;
          }
          // 官方取 status?.running ?? summary.running；显式区分 undefined 与 false。
          let running = false;
          if (status !== null && status !== undefined && status.running !== undefined) {
            running = status.running === true;
          } else if (summary !== null) {
            running = summary.running === true;
          }
          if (running) {
            counts.running += 1;
            continue;
          }
          if (status !== null && status !== undefined && status.completionUnread === true) {
            counts.done += 1;
          }
        }
        counts.total = counts.pending + counts.running + counts.done;
        ownBadges.set(workspaceId, counts);
      }

      // 先初始化每个工作区，再把各自的 own counts 沿父链加到每个祖先。
      // 必须读独立的 ownBadges：如果读 badges 里的对象，孙辈会被重复累计。
      const badges = new Map();
      for (const workspaceId of ownBadges.keys()) {
        badges.set(workspaceId, { pending: 0, running: 0, done: 0, total: 0 });
      }
      const parents = workspaceParentMap(items);
      for (const [workspaceId, own] of ownBadges) {
        let cursor = workspaceId;
        while (cursor !== undefined) {
          const aggregate = badges.get(cursor);
          if (aggregate !== undefined) {
            aggregate.pending += own.pending;
            aggregate.running += own.running;
            aggregate.done += own.done;
            aggregate.total += own.total;
          }
          cursor = parents.get(cursor);
        }
      }
      return badges;
    }

    /**
     * 生成读屏文案：固定 pending → running → done 顺序，只列非 0 项。
     * @param {object} counts - 计数。
     * @returns {string} 例如 "待处理 1 · 运行中 2"。
     */
    function describeBadge(counts) {
      const parts = [];
      for (const key of BADGE_ORDER) {
        const value = counts !== null && typeof counts === 'object' && typeof counts[key] === 'number' ? counts[key] : 0;
        if (value > 0) parts.push(BADGE_LABELS[key] + ' ' + value);
      }
      return parts.join(' · ');
    }

    // -------------------------------------------------- 隐藏工作区（纯逻辑）

    /** 与官方 owningParentFolder 一致：Windows 盘符/UNC 统一 `/`，去掉末尾斜杠。 */
    function folderPath(path) {
      if (typeof path !== 'string' || path === '') return '';
      return (/^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\') ? path.replaceAll('\\', '/') : path).replace(/\/+$/, '');
    }

    /** 已登记路径里「最长前缀」的父工作区路径；同路径不算父。 */
    function owningParentPath(path, paths) {
      const child = folderPath(path);
      if (child === '') return undefined;
      let owner;
      let length = -1;
      for (const parent of paths) {
        const root = folderPath(parent);
        if (root.length > length && child !== root && child.startsWith(root + '/')) {
          owner = parent;
          length = root.length;
        }
      }
      return owner;
    }

    /**
     * 工作区父子关系：childId → 直接父工作区 id。
     *
     * 与官方 workspace 包的 owningParentFolder 一致：按 workspace.path 的最长
     * 严格目录前缀判断，大小写敏感，同路径不算父子。没有 path、没有父路径或
     * 父工作区未登记时不建边。
     *
     * @param {Array<object>} items - useWorkspaces 快照的 items。
     * @returns {Map<string, string>} 子工作区 id → 父工作区 id。
     */
    function workspaceParentMap(items) {
      const list = Array.isArray(items) ? items : [];
      const keysByPath = new Map();
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue;
        const workspaceId = typeof item.workspaceId === 'string' ? item.workspaceId : '';
        const path = typeof item.path === 'string' ? item.path : '';
        if (workspaceId === '' || path === '') continue;
        keysByPath.set(path, workspaceId);
      }
      const paths = [...keysByPath.keys()];
      const parents = new Map();
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue;
        const workspaceId = typeof item.workspaceId === 'string' ? item.workspaceId : '';
        const path = typeof item.path === 'string' ? item.path : '';
        if (workspaceId === '' || path === '') continue;
        const parentPath = owningParentPath(path, paths);
        if (parentPath === undefined) continue;
        const parentId = keysByPath.get(parentPath);
        if (parentId !== undefined && parentId !== '' && parentId !== workspaceId) parents.set(workspaceId, parentId);
      }
      return parents;
    }

    /**
     * 顶层（没有已登记父工作区）的 workspaceId 列表。
     * 顶层工作区行总是渲染，是「至少保留一个可见入口」判定的基准。
     * @param {Array<object>} items - useWorkspaces 快照的 items。
     * @returns {string[]} 顶层 workspaceId（按原顺序）。
     */
    function rootWorkspaceIds(items) {
      const list = Array.isArray(items) ? items : [];
      const paths = [];
      for (const item of list) {
        if (item !== null && typeof item === 'object' && typeof item.path === 'string' && item.path !== '') paths.push(item.path);
      }
      const roots = [];
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue;
        const workspaceId = typeof item.workspaceId === 'string' ? item.workspaceId : '';
        if (workspaceId === '') continue;
        const parent = typeof item.path === 'string' && item.path !== '' ? owningParentPath(item.path, paths) : undefined;
        if (parent === undefined) roots.push(workspaceId);
      }
      return roots;
    }

    /** 菜单 / toast 用的工作区显示名：title → 路径末段 → id。 */
    function workspaceLabel(item) {
      if (item === null || item === undefined || typeof item !== 'object') return '';
      if (typeof item.title === 'string' && item.title !== '') return item.title;
      if (typeof item.path === 'string' && item.path !== '') {
        const trimmed = item.path.replace(/[\\/]+$/, '');
        const parts = trimmed.split(/[\\/]/);
        const last = parts.length > 0 ? parts[parts.length - 1] : '';
        if (last !== '') return last;
      }
      return typeof item.workspaceId === 'string' ? item.workspaceId : '';
    }

    /**
     * 是否允许隐藏这个工作区。
     * 顶层工作区不能全部隐藏（否则侧栏没有行可供右键恢复）。
     * @param {string} workspaceId - 目标。
     * @param {Array<object>} items - 当前工作区列表。
     * @param {Set<string>} hidden - 当前隐藏集合。
     * @returns {boolean} 允许隐藏。
     */
    function canHideWorkspace(workspaceId, items, hidden) {
      const set = hidden instanceof Set ? hidden : normalizeHidden(hidden);
      if (typeof workspaceId !== 'string' || workspaceId === '' || set.has(workspaceId)) return false;
      const list = Array.isArray(items) ? items : [];
      const found = list.some((item) => item !== null && typeof item === 'object' && item.workspaceId === workspaceId);
      if (!found) return false;
      const roots = rootWorkspaceIds(list);
      if (!roots.includes(workspaceId)) return true;
      // 目标是顶层：必须还有另一个未隐藏的顶层工作区。
      return roots.some((rootId) => rootId !== workspaceId && !set.has(rootId));
    }

    /**
     * 组装 workspace 右键菜单的动作（纯函数，可在无 DOM/无 React 环境单测）。
     * @param {{workspaceId?:string,displayTitle?:string}} target - 菜单捕获的 workspace 目标。
     * @param {{items?:Array<object>,badges?:Map<string,object>,hidden?:Set<string>}} state - 当前快照。
     * @returns {Array<object>} ctx.contextMenus 的 action 数组。
     */
    function buildWorkspaceMenuItems(target, state) {
      const workspaceId = target !== null && typeof target === 'object' && typeof target.workspaceId === 'string' ? target.workspaceId : '';
      if (workspaceId === '') return [];
      const config = state !== null && typeof state === 'object' ? state : {};
      const items = [];
      const source = Array.isArray(config.items) ? config.items : [];
      for (const item of source) {
        if (item !== null && typeof item === 'object' && typeof item.workspaceId === 'string' && item.workspaceId !== '') items.push(item);
      }
      if (items.length === 0) return [];
      const home = items.find((item) => item.workspaceId === workspaceId);
      if (home === undefined) return [];
      const hidden = config.hidden instanceof Set ? config.hidden : normalizeHidden(config.hidden);
      const badges = config.badges instanceof Map ? config.badges : new Map();
      const displayTitle =
        typeof target.displayTitle === 'string' && target.displayTitle !== '' ? target.displayTitle : workspaceLabel(home);

      const actions = [];
      if (hidden.has(workspaceId)) {
        // 防御分支：正常点不到隐藏行，但保留「显示」语义。
        actions.push({ id: 'show', label: '显示此工作区', run: () => showWorkspace(workspaceId) });
      } else {
        const allowed = canHideWorkspace(workspaceId, items, hidden);
        actions.push({
          id: 'hide',
          label: allowed ? '隐藏工作区' : '隐藏工作区（至少保留一个工作区可见）',
          ...(allowed ? {} : { disabled: true }),
          run: () => hideWorkspace(workspaceId, displayTitle),
        });
      }

      const hiddenItems = items.filter((item) => hidden.has(item.workspaceId));
      if (hiddenItems.length > 0) {
        const children = [];
        for (const item of hiddenItems) {
          const activity = describeBadge(badges.get(item.workspaceId));
          const label = workspaceLabel(item);
          children.push({
            id: 'show:' + item.workspaceId,
            label: activity === '' ? label : label + ' · ' + activity,
            run: () => showWorkspace(item.workspaceId),
          });
        }
        children.push({ id: 'show-all', label: '全部显示', separatorBefore: true, run: () => showAllWorkspaces() });
        actions.push({
          id: 'manage',
          label: '已隐藏的工作区 (' + hiddenItems.length + ')',
          separatorBefore: true,
          children,
        });
      }
      return actions;
    }

    /** 菜单 resolve 入口：读最新快照 + 隐藏集合，任何异常都退化为空菜单。 */
    function resolveWorkspaceMenu(target) {
      try {
        return buildWorkspaceMenuItems(target, { items: latest.items, badges: latest.badges, hidden: hiddenIds });
      } catch (error) {
        warnOnce(error);
        return [];
      }
    }

    /** 改隐藏集合 + 持久化 + 立即刷新 DOM。 */
    function commitHidden(next) {
      const set = setHiddenIds(next);
      if (typeof requestSync === 'function') requestSync();
      return set;
    }

    /** toast（contextMenus 服务可用时）；action 为空则只显示文本。 */
    function notifyHidden(text, action) {
      if (menuApi === null || typeof menuApi.notify !== 'function') return;
      try {
        menuApi.notify(text, false, action === null || action === undefined ? undefined : action);
      } catch (error) {
        warnOnce(error);
      }
    }

    /** 隐藏一个工作区；返回是否真的改动了状态。 */
    function hideWorkspace(workspaceId, displayTitle) {
      if (typeof workspaceId !== 'string' || workspaceId === '' || hiddenIds.has(workspaceId)) return false;
      // 工作区列表已知时再核对一次，避免对「菜单打开后被删除」的工作区落一条失效隐藏。
      if (latest.items.length > 0) {
        const known = latest.items.some((item) => item !== null && typeof item === 'object' && item.workspaceId === workspaceId);
        if (!known) return false;
      }
      const next = new Set(hiddenIds);
      next.add(workspaceId);
      commitHidden(next);
      const label = typeof displayTitle === 'string' && displayTitle !== '' ? displayTitle : workspaceId;
      notifyHidden('已隐藏「' + label + '」', {
        label: '撤销',
        run: () => showWorkspace(workspaceId),
        failureLabel: '恢复失败',
      });
      return true;
    }

    /** 恢复一个工作区；返回是否真的改动了状态。 */
    function showWorkspace(workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId === '' || !hiddenIds.has(workspaceId)) return false;
      const next = new Set(hiddenIds);
      next.delete(workspaceId);
      commitHidden(next);
      const item = latest.items.find((candidate) => candidate !== null && typeof candidate === 'object' && candidate.workspaceId === workspaceId);
      notifyHidden('已恢复「' + (item !== undefined ? workspaceLabel(item) : workspaceId) + '」', null);
      return true;
    }

    /** 恢复全部隐藏；返回是否真的改动了状态。 */
    function showAllWorkspaces() {
      if (hiddenIds.size === 0) return false;
      commitHidden(new Set());
      notifyHidden('已显示全部隐藏的工作区', null);
      return true;
    }

    /**
     * 安全网：工作区列表已知、但所有顶层工作区都被隐藏时（例如用户先隐藏 A，
     * 又删掉了唯一可见的 B），自动恢复第一个顶层工作区，避免侧栏没有任何行可右键。
     * @param {Array<object>} items - 当前工作区列表。
     * @returns {Set<string>} 校正后的隐藏集合。
     */
    function reconcileHidden(items) {
      if (hiddenIds.size === 0) return hiddenIds;
      const list = Array.isArray(items) ? items : [];
      if (list.length === 0) return hiddenIds;
      const roots = rootWorkspaceIds(list);
      if (roots.length === 0) return hiddenIds;
      if (roots.some((workspaceId) => !hiddenIds.has(workspaceId))) return hiddenIds;
      const next = new Set(hiddenIds);
      next.delete(roots[0]);
      hiddenIds = normalizeHidden(next);
      saveHiddenIds(hiddenIds);
      return hiddenIds;
    }

    // ------------------------------------------------------------ DOM 装饰

    /** row -> 角标节点；row 被 React 移除后随 GC 释放。 */
    const rowBadges = new WeakMap();
    /** badge -> { item, count } 引用，避免每次同步重新查询。 */
    const badgeParts = new WeakMap();

    /**
     * 注入样式表（幂等）。优先 data-plugin 标记，其次 id；没有 head 就放弃。
     * @param {Document} doc - 文档。
     * @returns {Element|null} style 元素。
     */
    function installStyle(doc) {
      if (doc === null || doc === undefined || typeof doc.createElement !== 'function') return null;
      let style = null;
      if (typeof doc.getElementById === 'function') style = doc.getElementById(STYLE_ID);
      if ((style === null || style === undefined) && typeof doc.querySelector === 'function') {
        style = doc.querySelector('style[' + STYLE_ATTR + '="' + PLUGIN_ID + '"]');
      }
      if (style !== null && style !== undefined) return style;
      style = doc.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute(STYLE_ATTR, PLUGIN_ID);
      style.setAttribute(STYLE_CSS_ATTR, PLUGIN_ID + '/status.css');
      style.textContent = CSS;
      const head = doc.head !== null && doc.head !== undefined ? doc.head : doc.documentElement;
      if (head === null || head === undefined || typeof head.appendChild !== 'function') return null;
      head.appendChild(style);
      return style;
    }

    /**
     * 创建角标节点（只创建一次，之后复用）。
     * @param {Document} doc - 文档。
     * @returns {Element} 角标节点。
     */
    function createBadge(doc) {
      const badge = doc.createElement('span');
      badge.setAttribute(BADGE_ATTR, '');
      badge.className = 'dsh-tishi-status';
      const parts = {};
      for (const key of BADGE_ORDER) {
        const item = doc.createElement('span');
        item.className = 'dsh-tishi-item is-' + key;
        const glyph = doc.createElement('i');
        glyph.className = key === 'running' ? 'dsh-tishi-spin' : 'dsh-tishi-dot';
        const count = doc.createElement('b');
        item.appendChild(glyph);
        item.appendChild(count);
        badge.appendChild(item);
        parts[key] = { item, count };
      }
      badgeParts.set(badge, parts);
      return badge;
    }

    /**
     * 把计数写进角标节点（原地更新，不重建 DOM）。
     * @param {Element} badge - 角标。
     * @param {object|undefined} counts - 计数；undefined 视为全 0。
     * @returns {void}
     */
    function applyBadge(badge, counts) {
      const parts = badgeParts.get(badge);
      const total = counts !== null && typeof counts === 'object' && typeof counts.total === 'number' ? counts.total : 0;
      if (typeof badge.setAttribute === 'function') {
        badge.setAttribute('aria-label', describeBadge(counts));
        badge.setAttribute('aria-hidden', total > 0 ? 'false' : 'true');
      }
      if (badge.style !== null && badge.style !== undefined) badge.style.display = total > 0 ? '' : 'none';
      if (parts === undefined) return;
      for (const key of BADGE_ORDER) {
        const part = parts[key];
        if (part === undefined) continue;
        const value = counts !== null && typeof counts === 'object' && typeof counts[key] === 'number' ? counts[key] : 0;
        if (part.item.style !== null && part.item.style !== undefined) part.item.style.display = value > 0 ? '' : 'none';
        part.count.textContent = value > 1 ? String(value) : '';
      }
    }

    /**
     * 找行内已有的角标：先查缓存，再查 DOM（兼容别的代码动过节点）。
     * @param {Element} row - 工作区行。
     * @returns {Element|null} 角标。
     */
    function findBadge(row) {
      const cached = rowBadges.get(row);
      if (cached !== undefined && cached !== null && cached.parentNode === row) return cached;
      if (typeof row.querySelector === 'function') {
        const found = row.querySelector('[' + BADGE_ATTR + ']');
        // 只认本行直属子节点：避免误把后代（嵌套行/其它插件）的角标搬进本行。
        if (found !== null && found !== undefined && found.parentNode === row) return found;
      }
      return null;
    }

    /**
     * 确保行里有一个角标，并放在首个子元素位置（folder 图标前）。
     * @param {Document} doc - 文档。
     * @param {Element} row - 工作区行。
     * @returns {Element} 角标。
     */
    function ensureBadge(doc, row) {
      let badge = findBadge(row);
      if (badge === null) badge = createBadge(doc);
      rowBadges.set(row, badge);
      if (badge.parentNode !== row) {
        if (typeof row.insertBefore === 'function') {
          row.insertBefore(badge, row.firstChild === undefined ? null : row.firstChild);
        } else if (typeof row.appendChild === 'function') {
          row.appendChild(badge);
        }
      }
      return badge;
    }

    /**
     * 移除一行的角标。
     * @param {Element} row - 工作区行。
     * @returns {boolean} 是否真的移除了。
     */
    function removeBadge(row) {
      const badge = findBadge(row);
      if (badge === null) return false;
      if (badge.parentNode !== null && badge.parentNode !== undefined && typeof badge.parentNode.removeChild === 'function') {
        badge.parentNode.removeChild(badge);
      }
      rowBadges.delete(row);
      return true;
    }

    /**
     * 移除文档里所有角标（卸载清理）。
     * @param {Document} doc - 文档。
     * @returns {number} 移除数量。
     */
    function removeAllBadges(doc) {
      if (doc === null || doc === undefined || typeof doc.querySelectorAll !== 'function') return 0;
      const badges = doc.querySelectorAll('[' + BADGE_ATTR + ']');
      let removed = 0;
      for (let index = 0; index < badges.length; index += 1) {
        const badge = badges[index];
        if (badge === null || badge === undefined) continue;
        if (badge.parentNode !== null && badge.parentNode !== undefined && typeof badge.parentNode.removeChild === 'function') {
          badge.parentNode.removeChild(badge);
          removed += 1;
        }
      }
      return removed;
    }

    /**
     * 同步一轮 DOM：给每个工作区行补/更新角标。
     *
     * 这是纯 DOM 操作，不持有数据；调用方负责传入最新 Map。
     * 缺 document / 缺 DOM 契约时静默返回（不抛错）。
     *
     * @param {Document} doc - 文档。
     * @param {Map<string, object>} badges - computeWorkspaceBadges 的结果。
     * @param {{showWhenExpanded?: boolean}} [options] - 显示策略覆盖（测试用）。
     * @returns {{rows:number, visible:number, hidden:number, removed:number}} 统计。
     */
    function syncBadges(doc, badges, options) {
      const result = { rows: 0, visible: 0, hidden: 0, removed: 0 };
      if (doc === null || doc === undefined || typeof doc.querySelectorAll !== 'function' || typeof doc.createElement !== 'function') {
        return result;
      }
      const settings = options !== null && typeof options === 'object' ? options : {};
      const showWhenExpanded = settings.showWhenExpanded === undefined ? SHOW_WHEN_EXPANDED : settings.showWhenExpanded === true;
      const map = badges instanceof Map ? badges : new Map();
      const rows = doc.querySelectorAll(ROW_SELECTOR);
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (row === null || row === undefined || typeof row.getAttribute !== 'function') continue;
        const rowKey = row.getAttribute('data-row-key');
        if (typeof rowKey !== 'string' || rowKey.slice(0, ROW_KEY_PREFIX.length) !== ROW_KEY_PREFIX) continue;
        const workspaceId = rowKey.slice(ROW_KEY_PREFIX.length);
        if (workspaceId === '') continue;
        result.rows += 1;
        const expanded = row.getAttribute('aria-expanded') !== 'false';
        if (showWhenExpanded === false && expanded) {
          if (removeBadge(row)) result.removed += 1;
          continue;
        }
        const counts = map.get(workspaceId);
        const badge = ensureBadge(doc, row);
        applyBadge(badge, counts);
        if (counts !== undefined && counts !== null && counts.total > 0) result.visible += 1;
        else result.hidden += 1;
      }
      return result;
    }

    // ------------------------------------------------------ 隐藏工作区（DOM）

    /**
     * 向上找最近的「包含 workspace 行」的祖先，即当前会话 / overflow 所属分组。
     * 平铺列表、搜索结果里没有 workspace 行 → 返回 null（这些视图不隐藏）。
     * @param {Element} node - session / overflow 行。
     * @returns {Element|null} 组内的 workspace 行。
     */
    function nearestWorkspaceRow(node) {
      let element = node !== null && node !== undefined ? node.parentNode : null;
      while (element !== null && element !== undefined) {
        // 走到文档根就停：避免把 body 里其它树（拖拽预览/门户）的 workspace 行误当所属分组。
        if (element.tagName === 'BODY' || element.tagName === 'HTML') break;
        if (typeof element.querySelector === 'function') {
          const row = element.querySelector(ROW_SELECTOR);
          if (row !== null && row !== undefined && typeof row.getAttribute === 'function') {
            const key = row.getAttribute('data-row-key');
            if (
              typeof key === 'string' &&
              key.slice(0, ROW_KEY_PREFIX.length) === ROW_KEY_PREFIX &&
              key.slice(ROW_KEY_PREFIX.length) !== ''
            ) {
              return row;
            }
          }
        }
        element = element.parentNode;
      }
      return null;
    }

    /** 给单行加/去隐藏标记（幂等）。 */
    function setRowHidden(row, hidden) {
      if (hidden) {
        if (typeof row.setAttribute === 'function') row.setAttribute(HIDDEN_ATTR, '');
      } else if (typeof row.removeAttribute === 'function') {
        row.removeAttribute(HIDDEN_ATTR);
      }
    }

    /**
     * 让 DOM 的隐藏标记与 hiddenIds 一致。纯 DOM 操作，不持有数据、不抛错。
     *  - workspace 行：按自己的 workspaceId 判断；
     *  - session / overflow 行：按所属分组判断（隐藏父工作区不会影响嵌套子工作区）；
     *  - 没有 workspace 行的视图（平铺 / 搜索）不隐藏。
     * @param {Document} doc - 文档。
     * @param {Set<string>} hiddenIdsValue - 隐藏集合。
     * @returns {{workspaces:number,sessions:number,overflow:number,hidden:number,shown:number}} 统计。
     */
    function syncHiddenRows(doc, hiddenIdsValue) {
      const result = { workspaces: 0, sessions: 0, overflow: 0, hidden: 0, shown: 0 };
      if (doc === null || doc === undefined || typeof doc.querySelectorAll !== 'function') return result;
      const hidden = hiddenIdsValue instanceof Set ? hiddenIdsValue : normalizeHidden(hiddenIdsValue);
      const mark = (row, isHidden, kind) => {
        const had = typeof row.hasAttribute === 'function' ? row.hasAttribute(HIDDEN_ATTR) : false;
        setRowHidden(row, isHidden);
        if (isHidden) {
          result.hidden += 1;
          if (!had) result[kind] += 1;
        } else if (had) {
          result.shown += 1;
        }
      };

      const workspaces = doc.querySelectorAll(ROW_SELECTOR);
      for (let index = 0; index < workspaces.length; index += 1) {
        const row = workspaces[index];
        if (row === null || row === undefined || typeof row.getAttribute !== 'function') continue;
        const key = row.getAttribute('data-row-key');
        if (typeof key !== 'string' || key.slice(0, ROW_KEY_PREFIX.length) !== ROW_KEY_PREFIX) continue;
        const workspaceId = key.slice(ROW_KEY_PREFIX.length);
        if (workspaceId === '') continue;
        mark(row, hidden.has(workspaceId), 'workspaces');
      }

      const groups = [
        [doc.querySelectorAll(SESSION_ROW_SELECTOR), SESSION_ROW_PREFIX, 'sessions'],
        [doc.querySelectorAll(OVERFLOW_ROW_SELECTOR), OVERFLOW_ROW_PREFIX, 'overflow'],
      ];
      for (const [rows, prefix, kind] of groups) {
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index];
          if (row === null || row === undefined || typeof row.getAttribute !== 'function') continue;
          const key = row.getAttribute('data-row-key');
          if (typeof key !== 'string' || key.slice(0, prefix.length) !== prefix) continue;
          const owner = nearestWorkspaceRow(row);
          if (owner === null) {
            setRowHidden(row, false);
            continue;
          }
          const ownerKey = owner.getAttribute('data-row-key');
          const ownerId = typeof ownerKey === 'string' ? ownerKey.slice(ROW_KEY_PREFIX.length) : '';
          mark(row, ownerId !== '' && hidden.has(ownerId), kind);
        }
      }
      return result;
    }

    /** 卸载时移除所有隐藏标记，让侧栏恢复完整（持久化状态保留，下次加载再隐藏）。 */
    function removeAllHidden(doc) {
      if (doc === null || doc === undefined || typeof doc.querySelectorAll !== 'function') return 0;
      const rows = doc.querySelectorAll('[' + HIDDEN_ATTR + ']');
      let removed = 0;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (
          row !== null &&
          row !== undefined &&
          typeof row.removeAttribute === 'function' &&
          typeof row.hasAttribute === 'function' &&
          row.hasAttribute(HIDDEN_ATTR)
        ) {
          row.removeAttribute(HIDDEN_ATTR);
          removed += 1;
        }
      }
      return removed;
    }

    // ---------------------------------------- 全局面板栏（7 行上限 + 收起 + 排序，纯 DOM）

    /** 折叠意愿（模块级单例，localStorage 初始化）；刷新后保持。 */
    let panelCollapsed = loadPanelCollapsed();
    /** 上次装饰成功的 nav；宿主重渲染后节点仍在就直接复用，避免每秒全文档扫描。 */
    let panelNavCache = null;

    /**
     * 读折叠状态；缺存储 / 坏 JSON / 旧格式都退化为「展开」，不抛错。
     * @returns {boolean} 是否已收起。
     */
    function loadPanelCollapsed() {
      const storage = getStorage();
      if (storage === null) return false;
      try {
        const raw = storage.getItem(PANEL_COLLAPSED_STORAGE_KEY);
        if (typeof raw !== 'string' || raw === '') return false;
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.collapsed === 'boolean') {
          return parsed.collapsed;
        }
        return parsed === true;
      } catch (error) {
        return false;
      }
    }

    /**
     * 尽力写折叠状态；失败保持内存态（调用方不感知）。
     * @param {boolean} collapsed - 是否收起。
     * @returns {boolean} 是否写入成功。
     */
    function savePanelCollapsed(collapsed) {
      const storage = getStorage();
      if (storage === null || typeof storage.setItem !== 'function') return false;
      try {
        storage.setItem(
          PANEL_COLLAPSED_STORAGE_KEY,
          JSON.stringify({ v: PANEL_COLLAPSED_STORAGE_VERSION, collapsed: collapsed === true }),
        );
        return true;
      } catch (error) {
        return false;
      }
    }

    /**
     * 找侧栏的「全局面板」nav。
     *
     * 判据：nav 的父节点里能查到工作区行——面板导航与工作区浏览器同属侧栏 root。
     * 全库还有别的 <nav>（聊天/设置等），所以不能只按标签抓。先查缓存，
     * 缓存断开（React 重建）后再全文档扫；找不到返回 null，调用方静默降级。
     *
     * @param {Document} doc - 文档。
     * @returns {Element|null} 面板 nav。
     */
    function findPanelNav(doc) {
      if (doc === null || doc === undefined) return null;
      const cached = panelNavCache;
      if (
        cached !== null &&
        cached !== undefined &&
        cached.ownerDocument === doc &&
        cached.parentNode !== null &&
        cached.parentNode !== undefined
      ) {
        return cached;
      }
      if (typeof doc.querySelectorAll !== 'function') return null;
      const navs = doc.querySelectorAll('nav');
      for (let index = 0; index < navs.length; index += 1) {
        const nav = navs[index];
        if (nav === null || nav === undefined) continue;
        const host =
          nav.parentElement !== null && nav.parentElement !== undefined ? nav.parentElement : nav.parentNode;
        if (host === null || host === undefined || typeof host.querySelector !== 'function') continue;
        if (host.querySelector(ROW_SELECTOR) !== null && host.querySelector(ROW_SELECTOR) !== undefined) {
          panelNavCache = nav;
          return nav;
        }
      }
      return null;
    }

    /**
     * rail（窄栏）判定：窄于阈值时宿主只画图标行，不做任何装饰。
     * @param {Element} nav - 面板 nav。
     * @returns {boolean} 是否 rail 态。
     */
    function panelNavIsRail(nav) {
      if (nav === null || nav === undefined || typeof nav.clientWidth !== 'number') return false;
      return nav.clientWidth > 0 && nav.clientWidth < PANEL_RAIL_MAX_WIDTH;
    }

    /**
     * 找 nav 直属的控制行（折叠/排序按钮的容器；只认直属子节点）。
     * @param {Element} nav - 面板 nav。
     * @returns {Element|null} 控制行。
     */
    function findPanelControl(nav) {
      if (nav === null || nav === undefined) return null;
      const children = nav.children;
      if (children === null || children === undefined) return null;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child !== null && child !== undefined && typeof child.getAttribute === 'function') {
          if (child.getAttribute(PANEL_CONTROL_ATTR) !== null) return child;
        }
      }
      return null;
    }

    /**
     * 找控制行里的「收起/展开」按钮。
     * @param {Element} nav - 面板 nav。
     * @returns {Element|null} 按钮。
     */
    function findPanelToggle(nav) {
      const control = findPanelControl(nav);
      if (control === null || control === undefined) return null;
      const children = control.children;
      if (children === null || children === undefined) return null;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child !== null && child !== undefined && typeof child.getAttribute === 'function') {
          if (child.getAttribute(PANEL_TOGGLE_ATTR) !== null) return child;
        }
      }
      return null;
    }

    /** 沿 parentNode 上溯：node 是否在 container 内（不依赖 Element.closest）。 */
    function isInsideNode(container, node) {
      let current = node;
      while (current !== null && current !== undefined) {
        if (current === container) return true;
        current = current.parentNode;
      }
      return false;
    }

    /** nav 里除控制行以外的直属子节点（宿主渲染的面板行 /「更多」锚）。 */
    function panelHostChildren(nav) {
      const result = [];
      if (nav === null || nav === undefined || nav.children === null || nav.children === undefined) return result;
      const children = nav.children;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child === null || child === undefined || typeof child.getAttribute !== 'function') continue;
        if (child.getAttribute(PANEL_CONTROL_ATTR) !== null) continue;
        result.push(child);
      }
      return result;
    }

    /**
     * 面板行的稳定键：宿主没有 data-key，用 aria-label（面板名；语言切换会失配）。
     * @param {Element} node - 面板行。
     * @returns {string} 键；拿不到返回空串。
     */
    function panelKey(node) {
      if (node === null || node === undefined || typeof node.getAttribute !== 'function') return '';
      const label = node.getAttribute('aria-label');
      if (typeof label === 'string' && label !== '') return label;
      const text = node.textContent;
      return typeof text === 'string' ? text.trim() : '';
    }

    /**
     * 按 panelOrder 重排 nav 里的面板行（未知键按宿主顺序排在已知键之后）。
     * 只有顺序真的不同才动 DOM，避免每秒制造无谓的节点移动。
     * @param {Element} nav - 面板 nav。
     * @returns {boolean} 是否发生了移动。
     */
    function applyPanelOrder(nav) {
      const nodes = panelHostChildren(nav);
      if (nodes.length === 0) return false;
      const byKey = new Map();
      for (const node of nodes) {
        const key = panelKey(node);
        if (key !== '' && !byKey.has(key)) byKey.set(key, node);
      }
      const ordered = [];
      const used = new Set();
      for (const key of panelOrder) {
        const node = byKey.get(key);
        if (node !== undefined && node !== null && !used.has(key)) {
          ordered.push(node);
          used.add(key);
        }
      }
      for (const node of nodes) {
        const key = panelKey(node);
        if (!used.has(key)) {
          ordered.push(node);
          used.add(key);
        }
      }
      let same = ordered.length === nodes.length;
      if (same) {
        for (let index = 0; index < ordered.length; index += 1) {
          if (ordered[index] !== nodes[index]) {
            same = false;
            break;
          }
        }
      }
      if (!same && typeof nav.appendChild === 'function') {
        for (const node of ordered) nav.appendChild(node);
      }
      const control = findPanelControl(nav);
      if (control !== null && control !== undefined && typeof nav.appendChild === 'function') {
        const children = nav.children;
        const last = children !== null && children !== undefined ? children[children.length - 1] : null;
        if (last !== control) nav.appendChild(control);
      }
      return !same;
    }

    /** 收起时给最上面 PANEL_COLLAPSED_VISIBLE 行打保留标记，其余清除。 */
    function markCollapsedKeep(nav) {
      const nodes = panelHostChildren(nav);
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node === null || node === undefined || typeof node.getAttribute !== 'function') continue;
        if (index < PANEL_COLLAPSED_VISIBLE) {
          if (node.getAttribute(PANEL_KEEP_ATTR) === null) node.setAttribute(PANEL_KEEP_ATTR, '');
        } else if (node.getAttribute(PANEL_KEEP_ATTR) !== null) {
          node.removeAttribute(PANEL_KEEP_ATTR);
        }
      }
    }

    /**
     * 创建控制行：「收起/展开」+「排序」。整行 sticky 吸底，两个按钮各自绑事件。
     * @param {Document} doc - 文档。
     * @returns {Element} 控制行。
     */
    function createPanelControl(doc) {
      const control = doc.createElement('div');
      control.setAttribute(PANEL_CONTROL_ATTR, '');
      const button = doc.createElement('button');
      button.setAttribute('type', 'button');
      button.setAttribute(PANEL_TOGGLE_ATTR, '');
      const chevron = doc.createElement('span');
      chevron.setAttribute(PANEL_CHEVRON_ATTR, '');
      chevron.setAttribute('aria-hidden', 'true');
      const label = doc.createElement('span');
      label.setAttribute(PANEL_TOGGLE_LABEL_ATTR, '');
      button.appendChild(chevron);
      button.appendChild(label);
      const onToggle = (event) => {
        if (event !== null && event !== undefined) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        const nav = control.parentNode;
        if (nav === null || nav === undefined) return;
        closePanelSortPanel();
        closePanelMenuPanel();
        panelCollapsed = !panelCollapsed;
        savePanelCollapsed(panelCollapsed);
        applyPanelCollapsed(nav, panelCollapsed);
        applyPanelHeight(nav, panelCollapsed ? null : panelHeight);
      };
      if (typeof button.addEventListener === 'function') button.addEventListener('click', onToggle);
      else button.onclick = onToggle;
      const sort = doc.createElement('button');
      sort.setAttribute('type', 'button');
      sort.setAttribute(PANEL_SORT_ATTR, '');
      sort.setAttribute('aria-label', PANEL_SORT_TEXT.title);
      sort.setAttribute('title', PANEL_SORT_TEXT.title);
      sort.textContent = '排序';
      const onSort = (event) => {
        if (event !== null && event !== undefined) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        const nav = control.parentNode;
        if (nav === null || nav === undefined) return;
        if (sortPanelState !== null && sortPanelState.nav === nav) {
          closePanelSortPanel();
          return;
        }
        openPanelSortPanel(doc, nav);
      };
      if (typeof sort.addEventListener === 'function') sort.addEventListener('click', onSort);
      else sort.onclick = onSort;
      const menu = doc.createElement('button');
      menu.setAttribute('type', 'button');
      menu.setAttribute(PANEL_MENU_ATTR, '');
      menu.setAttribute('aria-label', PANEL_MENU_TEXT.title);
      menu.setAttribute('title', PANEL_MENU_TEXT.title);
      menu.setAttribute('aria-haspopup', 'dialog');
      menu.textContent = '⋯';
      const onMenu = (event) => {
        if (event !== null && event !== undefined) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        const nav = control.parentNode;
        if (nav === null || nav === undefined) return;
        if (menuPanelState !== null && menuPanelState.nav === nav) {
          closePanelMenuPanel();
          return;
        }
        openPanelMenuPanel(doc, nav);
      };
      bindClick(menu, onMenu);
      control.appendChild(createPanelHandle(doc));
      control.appendChild(button);
      control.appendChild(sort);
      control.appendChild(menu);
      return control;
    }

    /**
     * 把折叠状态写到 nav 与按钮上（只改 DOM，不碰存储）。
     * @param {Element} nav - 面板 nav。
     * @param {boolean} collapsed - 是否收起。
     * @returns {void}
     */
    function applyPanelCollapsed(nav, collapsed) {
      if (nav === null || nav === undefined || typeof nav.setAttribute !== 'function') return;
      const text = collapsed ? PANEL_TOGGLE_TEXT.collapsed : PANEL_TOGGLE_TEXT.expanded;
      if (collapsed) nav.setAttribute(PANEL_COLLAPSED_ATTR, '1');
      else nav.removeAttribute(PANEL_COLLAPSED_ATTR);
      markCollapsedKeep(nav);
      const button = findPanelToggle(nav);
      if (button === null) return;
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      button.setAttribute('aria-label', text);
      button.setAttribute('title', text);
      const parts = button.children;
      if (parts === null || parts === undefined) return;
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part !== null && part !== undefined && typeof part.getAttribute === 'function') {
          if (part.getAttribute(PANEL_TOGGLE_LABEL_ATTR) !== null) part.textContent = text;
        }
      }
    }

    // ------------------------------- 侧栏显示：隐藏新会话按钮 / 入口区高度拖动

    /** 新会话按钮缓存：React 重渲染会换节点，缓存命中后省掉一次结构推断。 */
    let newSessionCache = null;
    /** 「＋ 新会话」按钮是否隐藏（模块级单例，默认隐藏）。 */
    let newSessionHidden = loadNewSessionHidden();
    /** 自定义入口区高度（px）；null = 用 CSS 默认的 7 行上限。 */
    let panelHeight = loadPanelHeight();
    /**「侧栏显示」浮层状态；同一时间只允许一个。 */
    let menuPanelState = null;
    /** 正在拖动的状态；拖动期间 pointermove/pointerup 绑在 document 上。 */
    let panelResizeState = null;

    /** 读一个 JSON 设置对象；缺存储 / 坏 JSON / 非对象都返回 null。 */
    function readSettingsJson(key) {
      const storage = getStorage();
      if (storage === null) return null;
      try {
        const raw = storage.getItem(key);
        if (typeof raw !== 'string' || raw === '') return null;
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' ? parsed : null;
      } catch (error) {
        return null;
      }
    }

    /** 统一的 click 绑定（假 DOM 里没有 addEventListener 时退回 onclick）。 */
    function bindClick(node, handler) {
      if (node === null || node === undefined) return;
      if (typeof node.addEventListener === 'function') node.addEventListener('click', handler);
      else node.onclick = handler;
    }

    /** 读「隐藏新会话」意愿；缺存储时用默认值。 */
    function loadNewSessionHidden() {
      const parsed = readSettingsJson(HIDE_NEW_SESSION_STORAGE_KEY);
      return parsed !== null && typeof parsed.hidden === 'boolean' ? parsed.hidden : HIDE_NEW_SESSION_FALLBACK;
    }

    /** 写「隐藏新会话」意愿；失败保持内存态。 */
    function saveNewSessionHidden(hidden) {
      const storage = getStorage();
      if (storage === null || typeof storage.setItem !== 'function') return false;
      try {
        storage.setItem(
          HIDE_NEW_SESSION_STORAGE_KEY,
          JSON.stringify({ v: HIDE_NEW_SESSION_STORAGE_VERSION, hidden: hidden === true }),
        );
        return true;
      } catch (error) {
        return false;
      }
    }

    /** 读自定义入口区高度；缺存储 / 非法值返回 null。 */
    function loadPanelHeight() {
      const parsed = readSettingsJson(PANEL_HEIGHT_STORAGE_KEY);
      if (parsed === null) return null;
      const px = typeof parsed.px === 'number' ? parsed.px : NaN;
      return Number.isFinite(px) && px > 0 ? Math.round(px) : null;
    }

    /** 写自定义入口区高度；px 为空删键（回到默认上限）。 */
    function savePanelHeight(px) {
      const storage = getStorage();
      if (storage === null) return false;
      try {
        if (px === null || px === undefined) {
          if (typeof storage.removeItem === 'function') storage.removeItem(PANEL_HEIGHT_STORAGE_KEY);
          return true;
        }
        if (typeof storage.setItem !== 'function') return false;
        storage.setItem(
          PANEL_HEIGHT_STORAGE_KEY,
          JSON.stringify({ v: PANEL_HEIGHT_STORAGE_VERSION, px: Math.round(px) }),
        );
        return true;
      } catch (error) {
        return false;
      }
    }

    /**
     * 定位顶部「＋ 新会话」按钮。
     * 宿主结构：logo 行（div[data-window-drag]，内含品牌按钮）→ 新会话按钮 → nav。
     * 按钮可能被 Tooltip 包一层，所以从 nav 往前最多看 3 个兄弟；遇到 logo 行立刻停，
     * 绝不把 logo 行（含折叠按钮）当成目标。找不到就返回 null，宁可不隐藏。
     * @param {Element} nav - 面板 nav。
     * @returns {Element|null} 按钮（或包着按钮的 Tooltip 容器）。
     */
    function findNewSessionButton(nav) {
      if (nav === null || nav === undefined || typeof nav.getAttribute !== 'function') return null;
      if (newSessionCache !== null && newSessionCache !== undefined) {
        const cached = newSessionCache.button;
        if (newSessionCache.nav === nav && cached !== null && cached !== undefined && cached.parentNode === nav.parentNode) {
          return cached;
        }
      }
      const parent = nav.parentNode;
      if (parent === null || parent === undefined) return null;
      let node = nav.previousElementSibling;
      for (let step = 0; step < 3 && node !== null && node !== undefined; step += 1) {
        if (typeof node.hasAttribute === 'function' && node.hasAttribute('data-window-drag')) break;
        if (node.tagName === 'BUTTON') return node;
        const inner = typeof node.querySelector === 'function' ? node.querySelector('button') : null;
        if (inner !== null && inner !== undefined) return node;
        node = node.previousElementSibling;
      }
      if (!Array.isArray(parent.children)) return null;
      for (let index = 0; index < parent.children.length; index += 1) {
        const child = parent.children[index];
        if (child === null || child === undefined || typeof child.getAttribute !== 'function') continue;
        if (child.getAttribute(HIDE_NEW_SESSION_ATTR) !== null) return child;
      }
      return null;
    }

    /** 只改 DOM：给新会话按钮打/摘隐藏标记（不碰存储）。 */
    function applyNewSessionHidden(nav, hidden) {
      const button = findNewSessionButton(nav);
      if (button === null || button === undefined) return false;
      newSessionCache = { nav, button };
      // 宿主收起成窄栏时 nav 不再布局 / 宽度不足，那颗 fixed ⊕ 是唯一入口，不能藏。
      const wide = typeof nav.clientWidth === 'number' && nav.clientWidth >= PANEL_RAIL_MAX_WIDTH;
      if (hidden === true && wide) button.setAttribute(HIDE_NEW_SESSION_ATTR, '');
      else button.removeAttribute(HIDE_NEW_SESSION_ATTR);
      return true;
    }

    /** 改隐藏意愿：写存储并立即应用；返回当前值。 */
    function setNewSessionHidden(nav, hidden) {
      newSessionHidden = hidden === true;
      saveNewSessionHidden(newSessionHidden);
      applyNewSessionHidden(nav, newSessionHidden);
      return newSessionHidden;
    }

    /**
     * 入口区高度上限：nav 当前高度 + 紧随其后的工作区容器高度 - 工作区保留高度。
     * region 是 flex:1，nav 变高它等量变矮，所以两者之和是稳定值；只用 clientHeight，
     * 不依赖 getBoundingClientRect（假 DOM 里没有）。
     * @param {Element} nav - 面板 nav。
     * @returns {number} 上限 px；拿不到尺寸返回 0。
     */
    function panelHeightMax(nav) {
      if (nav === null || nav === undefined || typeof nav.getAttribute !== 'function') return 0;
      const navHeight = typeof nav.clientHeight === 'number' && nav.clientHeight > 0 ? nav.clientHeight : 0;
      const region = nav.nextElementSibling;
      const regionHeight =
        region !== null && region !== undefined && typeof region.clientHeight === 'number' && region.clientHeight > 0
          ? region.clientHeight
          : 0;
      const total = navHeight + regionHeight;
      if (!(total > 0)) return 0;
      return Math.max(PANEL_HEIGHT_MIN, Math.round(total - PANEL_WORKSPACE_MIN));
    }

    /** 把目标高度夹进 [最小, 上限]。 */
    function clampPanelHeight(nav, px) {
      const value = Math.round(typeof px === 'number' && Number.isFinite(px) ? px : PANEL_HEIGHT_MIN);
      const max = panelHeightMax(nav);
      if (max <= 0) return Math.max(PANEL_HEIGHT_MIN, value);
      return Math.min(Math.max(PANEL_HEIGHT_MIN, value), max);
    }

    /**
     * 应用入口区高度：px 为空 = 清掉内联高度，回到 CSS 默认上限。
     * @param {Element} nav - 面板 nav。
     * @param {number|null} px - 目标高度。
     * @returns {number|null} 实际生效的高度。
     */
    function applyPanelHeight(nav, px) {
      if (nav === null || nav === undefined || typeof nav.setAttribute !== 'function') return null;
      const handle = findPanelHandle(nav);
      const style = nav.style;
      if (px === null || px === undefined) {
        if (style !== null && style !== undefined) {
          style.height = '';
          style.maxHeight = '';
        }
        nav.removeAttribute(PANEL_HEIGHT_ATTR);
        if (handle !== null) {
          handle.removeAttribute('aria-valuenow');
          handle.setAttribute('aria-valuemax', String(panelHeightMax(nav) || 0));
        }
        return null;
      }
      const next = clampPanelHeight(nav, px);
      if (style !== null && style !== undefined) {
        style.height = next + 'px';
        style.maxHeight = 'none';
      }
      nav.setAttribute(PANEL_HEIGHT_ATTR, '');
      if (handle !== null) {
        handle.setAttribute('aria-valuemin', String(PANEL_HEIGHT_MIN));
        handle.setAttribute('aria-valuemax', String(panelHeightMax(nav) || 0));
        handle.setAttribute('aria-valuenow', String(next));
      }
      return next;
    }

    /** 恢复默认高度：清状态、删存储、清内联样式。 */
    function resetPanelHeight(nav) {
      panelHeight = null;
      savePanelHeight(null);
      applyPanelHeight(nav, null);
      return null;
    }

    /** 在 nav 里找拖动条。 */
    function findPanelHandle(nav) {
      if (nav === null || nav === undefined || typeof nav.querySelector !== 'function') return null;
      const found = nav.querySelector('[' + PANEL_HANDLE_ATTR + ']');
      return found === null || found === undefined ? null : found;
    }

    /** 在 nav 里找「⋯」按钮。 */
    function findPanelMenuButton(nav) {
      if (nav === null || nav === undefined || typeof nav.querySelector !== 'function') return null;
      const found = nav.querySelector('[' + PANEL_MENU_ATTR + ']');
      return found === null || found === undefined ? null : found;
    }

    /**
     * 创建拖动条：控制行第一个子节点，绝对定位压在入口区/工作区边界上。
     * 拖动时改 nav 内联高度并把 pointermove 绑到 document；双击/Enter 复位。
     * @param {Document} doc - 文档。
     * @returns {Element} 拖动条。
     */
    function createPanelHandle(doc) {
      const handle = doc.createElement('div');
      handle.setAttribute(PANEL_HANDLE_ATTR, '');
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'horizontal');
      handle.setAttribute('aria-label', PANEL_HEIGHT_TEXT.label);
      handle.setAttribute('title', PANEL_HEIGHT_TEXT.label);
      handle.setAttribute('aria-valuemin', String(PANEL_HEIGHT_MIN));
      handle.setAttribute('tabindex', '0');
      const line = doc.createElement('span');
      line.setAttribute('aria-hidden', 'true');
      handle.appendChild(line);
      const navOf = () =>
        handle.parentNode !== null && handle.parentNode !== undefined ? handle.parentNode.parentNode : null;
      const onDown = (event) => {
        if (event !== null && event !== undefined) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        const nav = navOf();
        if (nav === null || nav === undefined) return;
        if (typeof handle.focus === 'function') handle.focus();
        startPanelResize(doc, nav, handle, event);
      };
      const onKeyDown = (event) => {
        const nav = navOf();
        if (nav === null || nav === undefined || event === null || event === undefined) return;
        const key = event.key;
        const current =
          panelHeight !== null
            ? panelHeight
            : clampPanelHeight(nav, typeof nav.clientHeight === 'number' ? nav.clientHeight : PANEL_HEIGHT_MIN);
        let next = null;
        if (key === 'ArrowUp' || key === 'ArrowDown') {
          const step = event.shiftKey === true ? PANEL_HEIGHT_STEP * 3 : PANEL_HEIGHT_STEP;
          next = current + (key === 'ArrowDown' ? step : -step);
        } else if (key === 'Home') {
          next = PANEL_HEIGHT_MIN;
        } else if (key === 'End') {
          next = panelHeightMax(nav) || current;
        } else if (key === 'Enter' || key === ' ') {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          resetPanelHeight(nav);
          return;
        } else {
          return;
        }
        if (typeof event.preventDefault === 'function') event.preventDefault();
        panelHeight = applyPanelHeight(nav, next);
        savePanelHeight(panelHeight);
      };
      const onDoubleClick = () => {
        const nav = navOf();
        if (nav !== null && nav !== undefined) resetPanelHeight(nav);
      };
      if (typeof handle.addEventListener === 'function') {
        handle.addEventListener('pointerdown', onDown);
        handle.addEventListener('keydown', onKeyDown);
        handle.addEventListener('dblclick', onDoubleClick);
      } else {
        handle.onpointerdown = onDown;
        handle.onkeydown = onKeyDown;
        handle.ondblclick = onDoubleClick;
      }
      return handle;
    }

    /**
     * 开始拖动：记录起点，把 pointermove/pointerup 绑到 document（侧栏之外的
     * pointerup 也要收尾；假 DOM 里 window 没有 addEventListener，所以用 document）。
     */
    function startPanelResize(doc, nav, handle, event) {
      if (panelResizeState !== null) return;
      if (doc === null || doc === undefined || nav === null || nav === undefined) return;
      const startY =
        event !== null && event !== undefined && typeof event.clientY === 'number' ? event.clientY : 0;
      const start =
        panelHeight !== null
          ? panelHeight
          : typeof nav.clientHeight === 'number' && nav.clientHeight > 0
            ? nav.clientHeight
            : PANEL_HEIGHT_MIN;
      const state = { doc, nav, handle, startY, start, onMove: null, onEnd: null };
      panelResizeState = state;
      if (
        typeof handle.setPointerCapture === 'function' &&
        event !== null &&
        event !== undefined &&
        typeof event.pointerId === 'number'
      ) {
        try {
          handle.setPointerCapture(event.pointerId);
        } catch (error) {
          /* 指针捕获失败不影响拖动 */
        }
      }
      const onMove = (moveEvent) => {
        const y =
          moveEvent !== null && moveEvent !== undefined && typeof moveEvent.clientY === 'number'
            ? moveEvent.clientY
            : state.startY;
        panelHeight = applyPanelHeight(state.nav, state.start + (y - state.startY));
      };
      const onEnd = () => {
        if (panelResizeState !== state) return;
        panelResizeState = null;
        if (typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('pointermove', onMove);
          doc.removeEventListener('pointerup', onEnd);
          doc.removeEventListener('pointercancel', onEnd);
        }
        savePanelHeight(panelHeight);
      };
      state.onMove = onMove;
      state.onEnd = onEnd;
      if (typeof doc.addEventListener === 'function') {
        doc.addEventListener('pointermove', onMove);
        doc.addEventListener('pointerup', onEnd);
        doc.addEventListener('pointercancel', onEnd);
      }
    }

    /** 收尾拖动（卸载 / 装饰移除）：摘监听并保存当前高度。 */
    function stopPanelResize() {
      const state = panelResizeState;
      if (state === null || state === undefined) return false;
      panelResizeState = null;
      const doc = state.doc;
      if (doc !== null && doc !== undefined && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('pointermove', state.onMove);
        doc.removeEventListener('pointerup', state.onEnd);
        doc.removeEventListener('pointercancel', state.onEnd);
      }
      savePanelHeight(panelHeight);
      return true;
    }

    /** 重建「侧栏显示」菜单项（勾选态 / 复位项可用态跟着模块状态走）。 */
    function renderMenuRows(doc, list, nav) {
      while (list.firstChild !== null && list.firstChild !== undefined) {
        if (typeof list.removeChild !== 'function') break;
        list.removeChild(list.firstChild);
      }
      const hide = doc.createElement('button');
      hide.setAttribute('type', 'button');
      hide.setAttribute(PANEL_MENU_ITEM_ATTR, 'new-session');
      hide.setAttribute('aria-pressed', newSessionHidden ? 'true' : 'false');
      const check = doc.createElement('span');
      check.setAttribute(PANEL_MENU_CHECK_ATTR, '');
      check.setAttribute('aria-hidden', 'true');
      check.textContent = newSessionHidden ? '✓' : ' ';
      const hideLabel = doc.createElement('span');
      hideLabel.textContent = PANEL_MENU_TEXT.hide;
      hide.appendChild(check);
      hide.appendChild(hideLabel);
      bindClick(hide, (event) => {
        if (event !== null && event !== undefined) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        setNewSessionHidden(nav, !newSessionHidden);
        renderMenuRows(doc, list, nav);
      });
      list.appendChild(hide);

      const reset = doc.createElement('button');
      reset.setAttribute('type', 'button');
      reset.setAttribute(PANEL_MENU_ITEM_ATTR, 'height');
      reset.textContent = PANEL_MENU_TEXT.reset;
      if (panelHeight === null) reset.setAttribute('disabled', '');
      bindClick(reset, (event) => {
        if (event !== null && event !== undefined) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        if (reset.hasAttribute('disabled')) return;
        resetPanelHeight(nav);
        closePanelMenuPanel();
      });
      list.appendChild(reset);
    }

    /**
     * 打开「侧栏显示」浮层：挂 body、fixed 定位，不受侧栏 overflow 裁剪。
     * @param {Document} doc - 文档。
     * @param {Element} nav - 面板 nav。
     * @returns {Element|null} 浮层节点；无法创建返回 null。
     */
    function openPanelMenuPanel(doc, nav) {
      if (doc === null || doc === undefined || nav === null || nav === undefined) return null;
      if (typeof doc.createElement !== 'function') return null;
      closePanelMenuPanel();
      closePanelSortPanel();
      const panel = doc.createElement('div');
      panel.setAttribute(PANEL_MENU_PANEL_ATTR, '');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', PANEL_MENU_TEXT.title);
      const head = doc.createElement('div');
      head.setAttribute(PANEL_MENU_HEAD_ATTR, '');
      const title = doc.createElement('span');
      title.textContent = PANEL_MENU_TEXT.title;
      const close = doc.createElement('button');
      close.setAttribute('type', 'button');
      close.setAttribute(PANEL_MENU_CLOSE_ATTR, '');
      close.setAttribute('aria-label', PANEL_MENU_TEXT.close);
      close.textContent = '×';
      head.appendChild(title);
      head.appendChild(close);
      const list = doc.createElement('div');
      list.setAttribute(PANEL_MENU_LIST_ATTR, '');
      panel.appendChild(head);
      panel.appendChild(list);
      bindClick(close, (event) => {
        if (event !== null && event !== undefined) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        closePanelMenuPanel();
      });
      renderMenuRows(doc, list, nav);
      const body = doc.body !== null && doc.body !== undefined ? doc.body : doc.documentElement;
      if (body === null || body === undefined || typeof body.appendChild !== 'function') return null;
      body.appendChild(panel);
      // 定位放在挂载之后：先量浮层自身高度，再决定落点，避免贴底时被视口裁掉。
      const anchor = findPanelMenuButton(nav);
      const anchorRect =
        anchor !== null && typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null;
      const panelRect = typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect() : null;
      const root = doc.documentElement;
      const viewWidth = root !== null && root !== undefined && typeof root.clientWidth === 'number' ? root.clientWidth : 0;
      const viewHeight =
        root !== null && root !== undefined && typeof root.clientHeight === 'number' ? root.clientHeight : 0;
      const boxHeight = panelRect !== null && panelRect !== undefined && panelRect.height > 0 ? panelRect.height : 168;
      const boxWidth = panelRect !== null && panelRect !== undefined && panelRect.width > 0 ? panelRect.width : 236;
      let left =
        anchorRect !== null && anchorRect !== undefined && typeof anchorRect.left === 'number' && anchorRect.left > 0
          ? anchorRect.left
          : 12;
      let top =
        anchorRect !== null && anchorRect !== undefined && typeof anchorRect.top === 'number' && anchorRect.top > 0
          ? anchorRect.top - boxHeight - 8
          : 120;
      if (viewHeight > 0 && top + boxHeight > viewHeight - 12) top = viewHeight - boxHeight - 12;
      if (viewWidth > 0 && left + boxWidth > viewWidth - 12) left = viewWidth - boxWidth - 12;
      if (top < 12) top = 12;
      if (left < 12) left = 12;
      if (panel.style !== null && panel.style !== undefined) {
        panel.style.left = Math.round(left) + 'px';
        panel.style.top = Math.round(top) + 'px';
      }
      const onDocClick = (event) => {
        const target = event !== null && event !== undefined ? event.target : null;
        if (target !== null && target !== undefined) {
          if (isInsideNode(panel, target) || isInsideNode(findPanelNav(doc), target)) return;
        }
        closePanelMenuPanel();
      };
      const onKeyDown = (event) => {
        if (event !== null && event !== undefined && event.key === 'Escape') closePanelMenuPanel();
      };
      if (typeof doc.addEventListener === 'function') {
        doc.addEventListener('click', onDocClick, true);
        doc.addEventListener('keydown', onKeyDown, true);
      }
      menuPanelState = { doc, panel, nav, onDocClick, onKeyDown };
      return panel;
    }

    /** 关闭「侧栏显示」浮层并摘掉文档监听。 */
    function closePanelMenuPanel() {
      const state = menuPanelState;
      if (state === null || state === undefined) return false;
      menuPanelState = null;
      const doc = state.doc;
      if (doc !== null && doc !== undefined && typeof doc.removeEventListener === 'function') {
        if (typeof state.onDocClick === 'function') doc.removeEventListener('click', state.onDocClick, true);
        if (typeof state.onKeyDown === 'function') doc.removeEventListener('keydown', state.onKeyDown, true);
      }
      const panel = state.panel;
      if (
        panel !== null &&
        panel !== undefined &&
        panel.parentNode !== null &&
        panel.parentNode !== undefined &&
        typeof panel.parentNode.removeChild === 'function'
      ) {
        panel.parentNode.removeChild(panel);
      }
      return true;
    }

    /**
     * 同步一轮面板栏装饰：定位 nav → 打标记 → 保证末尾恰有一个折叠按钮 → 套用状态。
     * 幂等；nav 缺失或处于 rail 态时移除装饰并保持宿主原样。
     * @param {Document} doc - 文档。
     * @returns {Element|null} 装饰后的 nav；未装饰返回 null。
     */
    function syncPanelNav(doc) {
      const nav = findPanelNav(doc);
      if (nav === null || panelNavIsRail(nav)) {
        removePanelNavDecor(doc);
        return null;
      }
      if (nav.getAttribute(PANEL_NAV_ATTR) === null) nav.setAttribute(PANEL_NAV_ATTR, '');
      let control = findPanelControl(nav);
      if (control === null) {
        control = createPanelControl(doc);
        if (typeof nav.appendChild === 'function') nav.appendChild(control);
      }
      applyPanelOrder(nav);
      applyPanelCollapsed(nav, panelCollapsed);
      applyNewSessionHidden(nav, newSessionHidden);
      applyPanelHeight(nav, panelCollapsed ? null : panelHeight);
      return nav;
    }

    /**
     * 移除全部面板栏装饰（rail 切换 / 卸载）。侧栏恢复宿主原样；折叠意愿仍留在存储里。
     * @param {Document} doc - 文档。
     * @returns {number} 移除的按钮数。
     */
    function removePanelNavDecor(doc) {
      panelNavCache = null;
      stopPanelResize();
      closePanelSortPanel();
      closePanelMenuPanel();
      if (doc === null || doc === undefined || typeof doc.querySelectorAll !== 'function') return 0;
      let removed = 0;
      const controls = doc.querySelectorAll('[' + PANEL_CONTROL_ATTR + ']');
      for (let index = 0; index < controls.length; index += 1) {
        const control = controls[index];
        if (control === null || control === undefined) continue;
        if (
          control.parentNode !== null &&
          control.parentNode !== undefined &&
          typeof control.parentNode.removeChild === 'function'
        ) {
          control.parentNode.removeChild(control);
          removed += 1;
        }
      }
      // 兜底：旧版本残留的裸折叠按钮。
      const buttons = doc.querySelectorAll('[' + PANEL_TOGGLE_ATTR + ']');
      for (let index = 0; index < buttons.length; index += 1) {
        const button = buttons[index];
        if (button === null || button === undefined) continue;
        if (
          button.parentNode !== null &&
          button.parentNode !== undefined &&
          typeof button.parentNode.removeChild === 'function'
        ) {
          button.parentNode.removeChild(button);
          removed += 1;
        }
      }
      const kept = doc.querySelectorAll('[' + PANEL_KEEP_ATTR + ']');
      for (let index = 0; index < kept.length; index += 1) {
        const node = kept[index];
        if (node !== null && node !== undefined && typeof node.removeAttribute === 'function') {
          node.removeAttribute(PANEL_KEEP_ATTR);
        }
      }
      const navs = doc.querySelectorAll('nav');
      for (let index = 0; index < navs.length; index += 1) {
        const nav = navs[index];
        if (nav === null || nav === undefined || typeof nav.removeAttribute !== 'function') continue;
        const decorated = nav.getAttribute(PANEL_NAV_ATTR) !== null || nav.getAttribute(PANEL_HEIGHT_ATTR) !== null;
        nav.removeAttribute(PANEL_NAV_ATTR);
        nav.removeAttribute(PANEL_COLLAPSED_ATTR);
        nav.removeAttribute(PANEL_HEIGHT_ATTR);
        // 只清理自己写过的内联高度，别碰宿主其它 nav。
        if (decorated && nav.style !== null && nav.style !== undefined) {
          nav.style.height = '';
          nav.style.maxHeight = '';
        }
      }
      // 隐藏标记留在按钮上会让侧栏永久少一个入口，卸载时必须摘干净。
      const hiddenButtons = doc.querySelectorAll('[' + HIDE_NEW_SESSION_ATTR + ']');
      for (let index = 0; index < hiddenButtons.length; index += 1) {
        const button = hiddenButtons[index];
        if (button !== null && button !== undefined && typeof button.removeAttribute === 'function') {
          button.removeAttribute(HIDE_NEW_SESSION_ATTR);
        }
      }
      newSessionCache = null;
      return removed;
    }

    // ------------------------------------------ 面板顺序（拖动排序 + 持久化）

    /** 上次成功打开的排序浮层状态；同一时间只允许一个。 */
    let sortPanelState = null;

    /** 面板名顺序（模块级单例，localStorage 初始化）。 */
    let panelOrder = loadPanelOrder();

    /** 归一化顺序数组：只留非空字符串、去重、保序。 */
    function normalizePanelOrder(value) {
      const result = [];
      if (!Array.isArray(value)) return result;
      for (const item of value) {
        if (typeof item === 'string' && item !== '' && result.indexOf(item) < 0) result.push(item);
      }
      return result;
    }

    /**
     * 读面板顺序；缺存储 / 坏 JSON / 旧格式都退化为空数组（= 宿主原顺序）。
     * @returns {string[]} 面板名数组。
     */
    function loadPanelOrder() {
      const storage = getStorage();
      if (storage === null) return [];
      try {
        const raw = storage.getItem(PANEL_ORDER_STORAGE_KEY);
        if (typeof raw !== 'string' || raw === '') return [];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return normalizePanelOrder(parsed);
        if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.order)) {
          return normalizePanelOrder(parsed.order);
        }
        return [];
      } catch (error) {
        return [];
      }
    }

    /**
     * 尽力写面板顺序；失败保持内存态（调用方不感知）。
     * @param {string[]} order - 面板名数组。
     * @returns {boolean} 是否写入成功。
     */
    function savePanelOrder(order) {
      const storage = getStorage();
      if (storage === null || typeof storage.setItem !== 'function') return false;
      try {
        storage.setItem(
          PANEL_ORDER_STORAGE_KEY,
          JSON.stringify({ v: PANEL_ORDER_STORAGE_VERSION, order: normalizePanelOrder(order) }),
        );
        return true;
      } catch (error) {
        return false;
      }
    }

    /**
     * 把某个面板上移/下移一格：以当前 DOM 顺序为基准，写回内存与存储并立即重排。
     * @param {Element} nav - 面板 nav。
     * @param {string} key - 面板名。
     * @param {number} delta - -1 上移 / +1 下移。
     * @returns {boolean} 是否移动成功。
     */
    function shiftPanelOrder(nav, key, delta) {
      const keys = panelHostChildren(nav).map(panelKey);
      const from = keys.indexOf(key);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= keys.length) return false;
      const next = keys.slice();
      const moved = next[from];
      next[from] = next[to];
      next[to] = moved;
      panelOrder = next;
      savePanelOrder(panelOrder);
      applyPanelOrder(nav);
      markCollapsedKeep(nav);
      return true;
    }

    /** 重建排序浮层的行（按当前 DOM 顺序；首尾行禁用对应方向）。 */
    function renderPanelSortRows(doc, list, nav) {
      while (list.firstChild !== null && list.firstChild !== undefined) {
        if (typeof list.removeChild !== 'function') break;
        list.removeChild(list.firstChild);
      }
      const nodes = panelHostChildren(nav);
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const key = panelKey(node);
        const row = doc.createElement('div');
        row.setAttribute(PANEL_SORT_ROW_ATTR, '');
        row.setAttribute('data-dsh-tishi-sort-key', key);
        const name = doc.createElement('span');
        name.setAttribute(PANEL_SORT_NAME_ATTR, '');
        name.textContent = key !== '' ? key : '面板 ' + (index + 1);
        const up = doc.createElement('button');
        up.setAttribute('type', 'button');
        up.setAttribute(PANEL_SORT_MOVE_ATTR, 'up');
        up.setAttribute('aria-label', PANEL_SORT_TEXT.up + ' ' + name.textContent);
        up.textContent = '↑';
        if (index === 0) up.setAttribute('disabled', '');
        const down = doc.createElement('button');
        down.setAttribute('type', 'button');
        down.setAttribute(PANEL_SORT_MOVE_ATTR, 'down');
        down.setAttribute('aria-label', PANEL_SORT_TEXT.down + ' ' + name.textContent);
        down.textContent = '↓';
        if (index === nodes.length - 1) down.setAttribute('disabled', '');
        const bind = (button, delta) => {
          const handler = (event) => {
            if (event !== null && event !== undefined) {
              if (typeof event.preventDefault === 'function') event.preventDefault();
              if (typeof event.stopPropagation === 'function') event.stopPropagation();
            }
            shiftPanelOrder(nav, key, delta);
            renderPanelSortRows(doc, list, nav);
          };
          if (typeof button.addEventListener === 'function') button.addEventListener('click', handler);
          else button.onclick = handler;
        };
        bind(up, -1);
        bind(down, 1);
        row.appendChild(name);
        row.appendChild(up);
        row.appendChild(down);
        list.appendChild(row);
      }
    }

    /**
     * 打开「调整面板顺序」浮层：挂 body、fixed 定位，不受侧栏 overflow 裁剪。
     * @param {Document} doc - 文档。
     * @param {Element} nav - 面板 nav。
     * @returns {Element|null} 浮层节点；无法创建返回 null。
     */
    function openPanelSortPanel(doc, nav) {
      if (doc === null || doc === undefined || nav === null || nav === undefined) return null;
      if (typeof doc.createElement !== 'function') return null;
      closePanelSortPanel();
      closePanelMenuPanel();
      const panel = doc.createElement('div');
      panel.setAttribute(PANEL_SORT_PANEL_ATTR, '');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', PANEL_SORT_TEXT.title);
      const head = doc.createElement('div');
      head.setAttribute(PANEL_SORT_HEAD_ATTR, '');
      const title = doc.createElement('span');
      title.textContent = PANEL_SORT_TEXT.title;
      const close = doc.createElement('button');
      close.setAttribute('type', 'button');
      close.setAttribute(PANEL_SORT_CLOSE_ATTR, '');
      close.setAttribute('aria-label', PANEL_SORT_TEXT.close);
      close.textContent = '×';
      head.appendChild(title);
      head.appendChild(close);
      const list = doc.createElement('div');
      list.setAttribute(PANEL_SORT_LIST_ATTR, '');
      panel.appendChild(head);
      panel.appendChild(list);
      const rect = typeof nav.getBoundingClientRect === 'function' ? nav.getBoundingClientRect() : null;
      const right = rect !== null && rect !== undefined && typeof rect.right === 'number' && rect.right > 0 ? rect.right : 0;
      const navTop = rect !== null && rect !== undefined && typeof rect.top === 'number' && rect.top >= 0 ? rect.top : 0;
      if (panel.style !== null && panel.style !== undefined) {
        panel.style.left = Math.round(right > 0 ? right + 8 : 300) + 'px';
        panel.style.top = Math.round(navTop > 0 ? Math.max(72, navTop) : 120) + 'px';
      }
      const onClose = (event) => {
        if (event !== null && event !== undefined) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        closePanelSortPanel();
      };
      if (typeof close.addEventListener === 'function') close.addEventListener('click', onClose);
      else close.onclick = onClose;
      renderPanelSortRows(doc, list, nav);
      const body = doc.body !== null && doc.body !== undefined ? doc.body : doc.documentElement;
      if (body === null || body === undefined || typeof body.appendChild !== 'function') return null;
      body.appendChild(panel);
      const onDocClick = (event) => {
        const target = event !== null && event !== undefined ? event.target : null;
        if (target !== null && target !== undefined) {
          if (isInsideNode(panel, target) || isInsideNode(findPanelNav(doc), target)) return;
        }
        closePanelSortPanel();
      };
      const onKeyDown = (event) => {
        if (event !== null && event !== undefined && event.key === 'Escape') closePanelSortPanel();
      };
      if (typeof doc.addEventListener === 'function') {
        doc.addEventListener('click', onDocClick, true);
        doc.addEventListener('keydown', onKeyDown, true);
      }
      sortPanelState = { doc, panel, nav, onDocClick, onKeyDown };
      return panel;
    }

    /**
     * 关闭排序浮层并摘掉文档监听。
     * @returns {boolean} 是否真的关掉了一个浮层。
     */
    function closePanelSortPanel() {
      const state = sortPanelState;
      if (state === null || state === undefined) return false;
      sortPanelState = null;
      const doc = state.doc;
      if (doc !== null && doc !== undefined && typeof doc.removeEventListener === 'function') {
        if (typeof state.onDocClick === 'function') doc.removeEventListener('click', state.onDocClick, true);
        if (typeof state.onKeyDown === 'function') doc.removeEventListener('keydown', state.onKeyDown, true);
      }
      const panel = state.panel;
      if (
        panel !== null &&
        panel !== undefined &&
        panel.parentNode !== null &&
        panel.parentNode !== undefined &&
        typeof panel.parentNode.removeChild === 'function'
      ) {
        panel.parentNode.removeChild(panel);
      }
      return true;
    }

    // ------------------------------------------------------------ 控制器

    /**
     * shell.overlay 控制器：只做数据订阅 + DOM 装饰，永远返回 null。
     *
     * 标准 props 的 hooks 必须无条件调用；缺失时用稳定空实现兜住，顺序不变。
     * 数据一变就重渲染 → 每次重渲染后同步一次；另外 click 捕获 + 1s 轮询兜底。
     *
     * @param {object} props - 槽位标准 props。
     * @returns {null} 不渲染任何东西。
     */
    function StatusBadgeController(props) {
      const P = props !== null && typeof props === 'object' ? props : {};
      const useWorkspaces = typeof P.useWorkspaces === 'function' ? P.useWorkspaces : noSnapshot;
      const useSessions = typeof P.useSessions === 'function' ? P.useSessions : noSnapshot;
      const useSessionStatus = typeof P.useSessionStatus === 'function' ? P.useSessionStatus : noSnapshot;
      const workspaceSnapshot = useWorkspaces(identity);
      const sessionList = useSessions(identity);
      const sessionStatuses = useSessionStatus(identity);
      const badges = computeWorkspaceBadges(workspaceSnapshot, sessionStatuses, sessionList);
      // 右键菜单的 resolve 在 React 之外执行，这里把最新快照挂到模块级。
      latest.items =
        workspaceSnapshot !== null && typeof workspaceSnapshot === 'object' && Array.isArray(workspaceSnapshot.items)
          ? workspaceSnapshot.items
          : [];
      latest.badges = badges;

      const dataRef = React.useRef(badges);
      dataRef.current = badges;
      const syncRef = React.useRef(noop);

      React.useEffect(() => {
        const doc = getDocument();
        if (doc === null) return undefined;
        const style = installStyle(doc);
        // 补同步 timer 的句柄全量记账（Set 自动去掉已触发的），卸载时全部 clear；
        // disposed 兜住「clearTimeout 前已经进入队列」的极窄竞态，避免卸载后角标复活。
        const pendingTimers = new Set();
        let disposed = false;
        const sync = () => {
          if (disposed) return;
          try {
            // 先校正「所有顶层工作区都被隐藏」的极端状态，再同步两类 DOM 标记。
            const hidden = reconcileHidden(latest.items);
            syncBadges(doc, dataRef.current, { showWhenExpanded: SHOW_WHEN_EXPANDED });
            syncHiddenRows(doc, hidden);
            syncPanelNav(doc);
          } catch (error) {
            // 官方 DOM 契约变化 / 扩展改 DOM 时不影响宿主，静默降级。
            warnOnce(error);
          }
        };
        requestSync = sync;
        syncRef.current = sync;
        sync();
        let timer = 0;
        if (typeof setInterval === 'function') timer = setInterval(sync, SYNC_INTERVAL_MS);
        const schedule = () => {
          if (typeof setTimeout !== 'function') {
            sync();
            return;
          }
          const handle = setTimeout(() => {
            pendingTimers.delete(handle);
            sync();
          }, 0);
          pendingTimers.add(handle);
        };
        if (typeof doc.addEventListener === 'function') doc.addEventListener('click', schedule, true);
        return () => {
          disposed = true;
          requestSync = noop;
          syncRef.current = noop;
          if (timer !== 0 && typeof clearInterval === 'function') clearInterval(timer);
          if (typeof doc.removeEventListener === 'function') doc.removeEventListener('click', schedule, true);
          if (typeof clearTimeout === 'function') {
            for (const handle of pendingTimers) clearTimeout(handle);
          }
          pendingTimers.clear();
          removeAllBadges(doc);
          // 卸载恢复完整侧栏；持久化的隐藏集合保留，重新启用后再次生效。
          removeAllHidden(doc);
          // 面板栏装饰同样撤掉（含收起态），恢复宿主原生的面板列表。
          removePanelNavDecor(doc);
          if (style !== null && style !== undefined && style.parentNode !== null && style.parentNode !== undefined && typeof style.parentNode.removeChild === 'function') {
            style.parentNode.removeChild(style);
          }
        };
      }, []);

      // 每次重渲染后同步一次（数据驱动的主路径）。
      React.useEffect(() => {
        syncRef.current();
      });

      return null;
    }

    // -------------------------------------------------------------- 接线

    /**
     * 客户端插件主体。
     * @param {object} ctx - 客户端根上下文。
     * @returns {void}
     */
    function apply(ctx) {
      if (ctx === null || ctx === undefined || ctx.slots === null || ctx.slots === undefined) return;
      const install = () =>
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            { name: SLOT, id: REGISTER_ID, order: REGISTER_ORDER },
            StatusBadgeController,
          ),
        );
      if (typeof ctx.effect === 'function') ctx.effect(install, 'dsh-tishi: workspace status badges');
      else install();

      // 工作区右键菜单：隐藏 / 恢复工作区。contextMenus 是官方客户端扩展服务
      // （ui-context-menu README 对外部客户端插件公开）；旧宿主没有该服务时静默跳过，
      // 角标功能不受影响。
      const menus = ctx.contextMenus;
      if (menus !== null && menus !== undefined && typeof menus.register === 'function') {
        const installMenu = () => {
          menuApi = menus;
          const dispose = menus.register({
            id: MENU_ID,
            target: WORKSPACE_MENU_TARGET,
            order: MENU_ORDER,
            resolve: resolveWorkspaceMenu,
          });
          return () => {
            menuApi = null;
            if (typeof dispose === 'function') dispose();
          };
        };
        if (typeof ctx.effect === 'function') ctx.effect(installMenu, 'dsh-tishi: hide workspace menu');
        else installMenu();
      }
    }

    // 离线测试钩子（生产环境 __DSH_TISHI_TEST__ 不存在，无副作用）
    const TEST =
      typeof globalThis === 'object' && globalThis.__DSH_TISHI_TEST__ !== null && typeof globalThis.__DSH_TISHI_TEST__ === 'object'
        ? globalThis.__DSH_TISHI_TEST__
        : null;
    if (TEST !== null) {
      TEST.PLUGIN_ID = PLUGIN_ID;
      TEST.SLOT = SLOT;
      TEST.REGISTER_ID = REGISTER_ID;
      TEST.REGISTER_ORDER = REGISTER_ORDER;
      TEST.ROW_SELECTOR = ROW_SELECTOR;
      TEST.BADGE_ATTR = BADGE_ATTR;
      TEST.BADGE_ORDER = BADGE_ORDER;
      TEST.SHOW_WHEN_EXPANDED = SHOW_WHEN_EXPANDED;
      TEST.CSS = CSS;
      TEST.MENU_ID = MENU_ID;
      TEST.MENU_ORDER = MENU_ORDER;
      TEST.HIDDEN_ATTR = HIDDEN_ATTR;
      TEST.HIDDEN_STORAGE_KEY = HIDDEN_STORAGE_KEY;
      TEST.SESSION_ROW_SELECTOR = SESSION_ROW_SELECTOR;
      TEST.OVERFLOW_ROW_SELECTOR = OVERFLOW_ROW_SELECTOR;
      TEST.computeWorkspaceBadges = computeWorkspaceBadges;
      TEST.describeBadge = describeBadge;
      TEST.getHiddenIds = getHiddenIds;
      TEST.setHiddenIds = setHiddenIds;
      TEST.hideWorkspace = hideWorkspace;
      TEST.showWorkspace = showWorkspace;
      TEST.showAllWorkspaces = showAllWorkspaces;
      TEST.loadHiddenIds = loadHiddenIds;
      TEST.saveHiddenIds = saveHiddenIds;
      TEST.canHideWorkspace = canHideWorkspace;
      TEST.buildWorkspaceMenuItems = buildWorkspaceMenuItems;
      TEST.resolveWorkspaceMenu = resolveWorkspaceMenu;
      TEST.syncHiddenRows = syncHiddenRows;
      TEST.removeAllHidden = removeAllHidden;
      TEST.reconcileHidden = reconcileHidden;
      TEST.nearestWorkspaceRow = nearestWorkspaceRow;
      TEST.rootWorkspaceIds = rootWorkspaceIds;
      TEST.workspaceParentMap = workspaceParentMap;
      TEST.workspaceLabel = workspaceLabel;
      TEST.syncBadges = syncBadges;
      TEST.StatusBadgeController = StatusBadgeController;
      TEST.installStyle = installStyle;
      TEST.PANEL_NAV_ATTR = PANEL_NAV_ATTR;
      TEST.PANEL_COLLAPSED_ATTR = PANEL_COLLAPSED_ATTR;
      TEST.PANEL_TOGGLE_ATTR = PANEL_TOGGLE_ATTR;
      TEST.PANEL_TOGGLE_LABEL_ATTR = PANEL_TOGGLE_LABEL_ATTR;
      TEST.PANEL_CHEVRON_ATTR = PANEL_CHEVRON_ATTR;
      TEST.PANEL_COLLAPSED_STORAGE_KEY = PANEL_COLLAPSED_STORAGE_KEY;
      TEST.PANEL_NAV_SELECTOR = 'nav[' + PANEL_NAV_ATTR + ']';
      TEST.PANEL_RAIL_MAX_WIDTH = PANEL_RAIL_MAX_WIDTH;
      TEST.PANEL_VISIBLE_ROWS = PANEL_VISIBLE_ROWS;
      TEST.PANEL_COLLAPSED_VISIBLE = PANEL_COLLAPSED_VISIBLE;
      TEST.PANEL_KEEP_ATTR = PANEL_KEEP_ATTR;
      TEST.PANEL_CONTROL_ATTR = PANEL_CONTROL_ATTR;
      TEST.PANEL_SORT_ATTR = PANEL_SORT_ATTR;
      TEST.PANEL_SORT_PANEL_ATTR = PANEL_SORT_PANEL_ATTR;
      TEST.PANEL_SORT_PANEL_SELECTOR = '[' + PANEL_SORT_PANEL_ATTR + ']';
      TEST.PANEL_SORT_ROW_SELECTOR = '[' + PANEL_SORT_ROW_ATTR + ']';
      TEST.PANEL_SORT_MOVE_SELECTOR = '[' + PANEL_SORT_MOVE_ATTR + ']';
      TEST.PANEL_SORT_CLOSE_SELECTOR = '[' + PANEL_SORT_CLOSE_ATTR + ']';
      TEST.PANEL_ORDER_STORAGE_KEY = PANEL_ORDER_STORAGE_KEY;
      TEST.PANEL_HEIGHT_ATTR = PANEL_HEIGHT_ATTR;
      TEST.PANEL_HANDLE_ATTR = PANEL_HANDLE_ATTR;
      TEST.PANEL_HEIGHT_SELECTOR = '[' + PANEL_HANDLE_ATTR + ']';
      TEST.PANEL_MENU_ATTR = PANEL_MENU_ATTR;
      TEST.PANEL_MENU_SELECTOR = '[' + PANEL_MENU_ATTR + ']';
      TEST.PANEL_MENU_PANEL_ATTR = PANEL_MENU_PANEL_ATTR;
      TEST.PANEL_MENU_ITEM_ATTR = PANEL_MENU_ITEM_ATTR;
      TEST.PANEL_MENU_PANEL_SELECTOR = '[' + PANEL_MENU_PANEL_ATTR + ']';
      TEST.PANEL_MENU_ITEM_SELECTOR = '[' + PANEL_MENU_ITEM_ATTR + ']';
      TEST.PANEL_MENU_CHECK_ATTR = PANEL_MENU_CHECK_ATTR;
      TEST.PANEL_MENU_CLOSE_SELECTOR = '[' + PANEL_MENU_CLOSE_ATTR + ']';
      TEST.HIDE_NEW_SESSION_ATTR = HIDE_NEW_SESSION_ATTR;
      TEST.HIDE_NEW_SESSION_SELECTOR = '[' + HIDE_NEW_SESSION_ATTR + ']';
      TEST.HIDE_NEW_SESSION_STORAGE_KEY = HIDE_NEW_SESSION_STORAGE_KEY;
      TEST.HIDE_NEW_SESSION_FALLBACK = HIDE_NEW_SESSION_FALLBACK;
      TEST.PANEL_HEIGHT_STORAGE_KEY = PANEL_HEIGHT_STORAGE_KEY;
      TEST.PANEL_HEIGHT_MIN = PANEL_HEIGHT_MIN;
      TEST.PANEL_WORKSPACE_MIN = PANEL_WORKSPACE_MIN;
      TEST.PANEL_HEIGHT_STEP = PANEL_HEIGHT_STEP;
      TEST.PANEL_MENU_TEXT = PANEL_MENU_TEXT;
      TEST.PANEL_HEIGHT_TEXT = PANEL_HEIGHT_TEXT;
      TEST.loadNewSessionHidden = loadNewSessionHidden;
      TEST.saveNewSessionHidden = saveNewSessionHidden;
      TEST.getNewSessionHidden = () => newSessionHidden;
      TEST.findNewSessionButton = findNewSessionButton;
      TEST.applyNewSessionHidden = applyNewSessionHidden;
      TEST.setNewSessionHidden = setNewSessionHidden;
      TEST.loadPanelHeight = loadPanelHeight;
      TEST.savePanelHeight = savePanelHeight;
      TEST.getPanelHeight = () => panelHeight;
      TEST.panelHeightMax = panelHeightMax;
      TEST.clampPanelHeight = clampPanelHeight;
      TEST.applyPanelHeight = applyPanelHeight;
      TEST.resetPanelHeight = resetPanelHeight;
      TEST.findPanelHandle = findPanelHandle;
      TEST.findPanelMenuButton = findPanelMenuButton;
      TEST.openPanelMenuPanel = openPanelMenuPanel;
      TEST.closePanelMenuPanel = closePanelMenuPanel;
      TEST.isPanelMenuOpen = () => menuPanelState !== null;
      TEST.isPanelResizing = () => panelResizeState !== null;
      TEST.stopPanelResize = stopPanelResize;
      TEST.loadPanelCollapsed = loadPanelCollapsed;
      TEST.savePanelCollapsed = savePanelCollapsed;
      TEST.loadPanelOrder = loadPanelOrder;
      TEST.savePanelOrder = savePanelOrder;
      TEST.getPanelOrder = () => panelOrder.slice();
      TEST.setPanelOrder = (value) => {
        panelOrder = normalizePanelOrder(Array.isArray(value) ? value : []);
        savePanelOrder(panelOrder);
        return panelOrder.slice();
      };
      TEST.findPanelNav = findPanelNav;
      TEST.findPanelControl = findPanelControl;
      TEST.findPanelToggle = findPanelToggle;
      TEST.panelNavIsRail = panelNavIsRail;
      TEST.panelHostChildren = panelHostChildren;
      TEST.panelKey = panelKey;
      TEST.applyPanelOrder = applyPanelOrder;
      TEST.markCollapsedKeep = markCollapsedKeep;
      TEST.shiftPanelOrder = shiftPanelOrder;
      TEST.applyPanelCollapsed = applyPanelCollapsed;
      TEST.syncPanelNav = syncPanelNav;
      TEST.removePanelNavDecor = removePanelNavDecor;
      TEST.openPanelSortPanel = openPanelSortPanel;
      TEST.closePanelSortPanel = closePanelSortPanel;
      TEST.resetPanelNav = (doc) => {
        panelCollapsed = loadPanelCollapsed();
        panelOrder = loadPanelOrder();
        panelHeight = loadPanelHeight();
        newSessionHidden = loadNewSessionHidden();
        stopPanelResize();
        closePanelMenuPanel();
        removePanelNavDecor(doc);
      };
      TEST.createBadge = createBadge;
      TEST.applyBadge = applyBadge;
      TEST.ensureBadge = ensureBadge;
      TEST.findBadge = findBadge;
      TEST.removeAllBadges = removeAllBadges;
      TEST.apply = apply;
    }

    return {
      name: PLUGIN_ID,
      inject: ['slots', 'contextMenus'],
      apply,
    };
  },
});

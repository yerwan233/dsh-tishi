# dsh-tishi

Sidebar workspace status badges for DeepSeek Harness (DSH): a compact badge sits in front of each
workspace folder icon and aggregates the session state of that workspace and all of its descendants.
It also carries two smaller sidebar refinements — hiding workspaces and keeping the panel rail in check.

> 侧栏工作区状态角标：在文件夹图标前聚合「待处理 / 运行中 / 未读完成」，折叠、子工作区未渲染、
> 会话被收起时也看得见。

## What it shows

| Category | Visual | Rule |
| --- | --- | --- |
| Pending | orange dot | `pendingInteraction.kind ∈ {approval, question, plan-review}` |
| Running | blue spinner | `status.running === true` (falls back to `sessionSummary.running`) |
| Unread done | green dot | `completionUnread === true` |

- Each session counts in exactly one category, priority pending > running > unread-done > idle.
- Archived sessions and sub-agent sessions (`summary.origin === 'subagent'`) are ignored, matching
  the official `sessionVisible()` rule; the "unfiled" bucket without a `workspaceId` is not decorated.
- A count is printed only when it is greater than 1; zero categories disappear; the whole badge
  disappears when the total is 0.

Parent/child workspace edges use longest-prefix matching over the registered workspace paths
(case-sensitive; an unregistered parent produces no edge).

## Hide workspaces

Right-click a workspace (or use its `…` menu) to hide its own title row and its own session rows
from the sidebar. Nothing is deleted — registrations, sessions and files are untouched. Any visible
workspace menu exposes **Hidden workspaces (N)** to restore them.

## Panel rail

The global panel rail above the workspace list is capped at 7 visible entries with its own scroll,
plus collapse/expand and reordering controls. Collapsed, the top 2 entries stay visible, so a large
number of panels can no longer push the workspace list out of the viewport. The boundary between the
rail and the workspace list is drag-resizable, and its height is persisted.

Two display tweaks come with it: the top **+ New session** button is hidden by default (recoverable
from the control row's `⋯` menu), and the panel rail / workspace boundary accepts a drag as described.

## Requirements

- DSH desktop app with a web client (`dsh.client.platform = "web"`), Node.js >= 22.
- No extra services, no host-side configuration.

## Install

```bash
npm install dsh-tishi
```

Then enable it in the DSH profile (the bundled `cordis.patch.yml` inserts the Host shell row), or add
`dsh-tishi` through **Plugins → Add plugin** in the desktop app and restart the tray app. Client-only
changes need a page refresh.

## Behaviour notes

- The Host half (`index.js`) is intentionally an empty shell: it exists so the loader finds the row
  and `@deepseek-ai/dsh-client-modules` picks up the `dsh.client` declaration from `package.json`.
- All UI work happens in `client.js`, which registers a resident `shell.overlay` controller
  (`id: 'dsh-tishi.status-badges', order: 900`) that returns `null` and paints no visible surface.
- Hidden-workspace names, panel order and rail height live in the browser's localStorage only.

## Known limitations

- The badge relies on sidebar row DOM details (`data-row-key`, the folder icon); a major UI redesign
  can invalidate the selectors.
- Parent/child edges are path-prefix based and case-sensitive; an unregistered parent is not linked.
- All UI state is local to one browser profile — it is not synced across machines.
- The Host half does nothing on its own; the plugin is client-only in practice.

## License

MIT — see [LICENSE](LICENSE).

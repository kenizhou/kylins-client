# Kylins Mail 前端 UI/UX 重设计规格文档

**日期：** 2026-07-17  
**状态：** 设计阶段 — 待用户评审后进入实施计划  
**范围：** `kylins.client.frontend` 视觉系统、布局架构、核心组件交互、主题配色、响应式与可访问性  
**目标读者：** 前端实现者、产品决策、后续维护者

---

## 1. 摘要与目标

本文档对 Kylins Mail 当前前端进行系统性的 UI/UX 评审，并提出重设计方案。目标是在保留现有技术栈（Tauri v2 + React 19 + Tailwind v4 + Zustand）和已实现能力（sync engine、插件槽位、安全渲染）的前提下，从“专业桌面邮件客户端”角度提升美观度、布局效率、可用性和可访问性。

设计方向继承并细化已有设计草图（`docs/superpowers/design/2026-06-22-mailclient-visual-design.md`、`docs/superpowers/design/2026-06-22-mailclient-main-page-design.md`），同时针对代码审计中发现的实际问题进行修正。

**核心目标：**

1. 建立一套可扩展、高对比、离线可用的视觉系统，提供多套预定义主题。
2. 优化三栏布局、Ribbon 工具栏、导航结构，使其在不同窗口尺寸下稳定可用。
3. 以 Outlook / Gmail / Thunderbird 的最佳实践为参照，改善邮件 triage、阅读、回复、搜索、状态反馈等主流程。
4. 统一图标、字体、动效语言，减少当前实现中的不一致和硬编码状态。
5. 给出分阶段、低风险的实施路线图，避免一次性大面积重构。

---

## 2. 设计原则

所有设计决策遵循以下 5 条原则，按优先级排序：

1. **肌肉记忆优先（Outlook-compatible）**
   用户从 Outlook / Thunderbird / Gmail 迁移时，核心快捷键、布局、右键菜单应尽量可预测。创新只应在不破坏肌肉记忆的细节上出现。

2. **triage 优先（Triage-first）**
   主视图的唯一工作是帮助用户快速判断“这封邮件是否需要处理”。视觉层级、颜色、动效应服务于“未读 / 标记 / 重要 / 安全”这几类状态，而不是装饰。

3. **工具而非仪表盘（Tool, not dashboard）**
   避免大图标、渐变卡片、英雄数据。界面密度应接近 IDE，信息优先于空白。

4. **可信与安全（Trust & safety）**
   安全状态（加密、签名、钓鱼风险、发件人可信度）必须可视且不易被忽略。AI 辅助入口必须明确标识，不可伪装成人工动作。

5. **渐进增强（Progressive enhancement）**
   基础体验在离线、窄屏、减少运动偏好下完全可用；主题、动效、AI 建议等作为增强层存在。

---

## 3. 竞品洞察

### 3.1 Outlook（主要参照）

- **Ribbon + 三栏**：Home / Send / View 等上下文 Ribbon 分组清晰；三栏可拖拽、可关闭阅读 pane。
- **Focused Inbox**：通过“Focused / Other”标签将重要邮件与其他邮件分离，减少 triage 噪音。
- **快速操作（Quick Actions）**：在列表行 hover 显示归档/删除/标记/已读/旗标，减少移动鼠标距离。
- **Sweep / Clean Up**：一键清理会话或发件人，适合批量处理。
- **状态栏**：同步状态、选中计数、缩放、离线状态均真实可用。

**可借鉴：** Ribbon 分组语义、Focused Inbox、快速操作、真实状态栏。

### 3.2 Gmail（网页版 / PWA）

- **标签与分类**：标签以 chip 形式展示，可多级；分类（推广/社交/更新/论坛）通过顶部 tab 切换。
- **智能回复（Smart Reply）**：在列表底部或阅读 pane 提供 3 个短回复建议。
- **搜索栏即入口**：搜索框常驻顶部，支持自然语言与操作符。
- **最小视觉噪音**：扁平、低饱和、无边框列表，row hover 才显示操作。

**可借鉴：** 标签 chip、搜索栏 prominence、row hover 操作、低噪音列表。

### 3.3 Thunderbird（本地参照 `D:\Projects\mailclient\opensource\thunderbird-desktop`）

- **Spaces + 工具栏**：左侧 Spaces 栏切换 Mail / Address Book / Calendar / Tasks / Chat，顶部工具栏可自定义。
- **文件夹 Pane 分组**：Unified Folders 将多个账号的 Inbox / Sent / Drafts 聚合。
- **标签（Tags）**：彩色标签可自定义，用于分类。
- **消息列表列**：发件人、主题、日期、大小等列可自定义显示/排序/宽度。
- **轻量主题**： persona / theme 通过 CSS 覆盖，社区可扩展。

**可借鉴：** Unified Folders、可配置列表列、彩色标签、Spaces 式应用切换。

### 3.4 竞品对比总结

| 维度 | Outlook | Gmail | Thunderbird | Kylins 当前 | 建议方向 |
|---|---|---|---|---|---|
| 布局 | Ribbon + 三栏 | 侧边栏 + 列表 | Spaces + 三栏 | ToolWindowBar + 三栏 | 保留三栏，优化 Ribbon 响应式 |
| 邮件分类 | Focused Inbox | 分类标签 | Tags | 无 | 引入 Focused / Other 与标签 |
| 列表操作 | hover 快速操作 | hover 快速操作 | 右键 + 工具栏 | 右键 + Ribbon | 增加 hover 快速操作 |
| 搜索 | 顶部操作符 | 顶部自然语言 | 快速过滤 | 标题栏绝对定位 | 独立搜索栏 + 操作符 |
| 状态栏 | 完整 | 无 | 完整 | 硬编码 | 接入真实状态 |
| 主题 | 多套内置 | 深色/浅色 | 社区主题 | 8 套强调色 | 扩展为完整主题包 |

---

## 4. 现状审计与关键问题

### 4.1 已具备的良好基础

- **自定义标题栏 + ToolWindowBar**：`TitleBar.tsx`、`ToolWindowBar.tsx` 已实现 Outlook/IntelliJ 风格的顶部和左侧 chrome。
- **三栏可拖拽布局**：`ReadingPaneLayout.tsx` 基于 `react-resizable-panels`，支持右/下/关闭阅读 pane。
- **主题骨架完整**：`theme.css`、`skins.css`、`themeManager.ts` 已支持 light/dark/system 和 8 套强调色皮肤。
- **虚拟化列表**：`MessageList.tsx` 使用 `@tanstack/react-virtual`，性能基础好。
- **安全渲染**：`SafeHtmlFrame.tsx` 使用 sandboxed iframe + DOMPurify。
- **插件槽位**：`InjectedComponent` / `InjectedComponentSet` 已存在，可扩展 UI。

### 4.2 必须修复的关键问题

| # | 问题 | 位置 | 影响 | 设计方案 |
|---|---|---|---|---|
| 1 | MessageList 列配置未真正生效 | `MessageList.tsx:221` 表头可配，`MessageRow` 固定布局 | 用户调整列后看不到变化 | 重写行渲染，按 `visibleColumnIds` 渲染真实列 |
| 2 | Ribbon 响应式不足 | `RibbonShell.tsx:17` 仅 `flex-wrap` | 窄窗口时 Ribbon 堆叠过高 | 引入 overflow menu + 分组折叠 |
| 3 | 搜索框定位脆弱 | `TitleBar.tsx` 依赖 `--message-list-left/width` | 某些布局下搜索悬空 | 将搜索栏移回 TitleBar 居中，取消绝对定位 |
| 4 | StatusBar 状态虚假 | `StatusBar.tsx:112` “1 selected” 为静态 | 用户无法信任状态栏 | 接入 `threadStore` 真实选中/同步/离线状态 |
| 5 | 多处 Reply/Forward 入口行为不一致 | `ReadRibbon.tsx` / 右键菜单 / `MessageHeader` / viewer 窗口 | 可能产生不同附件/收件人行为 | 统一为 `composerActions.ts` 中的单一入口 |
| 6 | 偏好设置存在 “coming soon” | `PreferencesDialog.tsx:46` | 显得未完成 | 移除占位标签页或标记为 experimental |
| 7 | 图标库混用 | `icons.tsx` Hugeicons + `ReadRibbon.tsx` Phosphor | stroke 权重不一致 | 统一为单一图标库（ Hugeicons 为主，补齐缺失图标） |
| 8 | Zoom 状态未消费 | `viewStore` 有 `readerZoom`，未看到 `ReadingPane` 使用 | 缩放控件无效 | 将 zoom 应用于 `EmailRenderer` 容器或 iframe 缩放 |
| 9 | 滚动条依赖 JS | `useAutoHideScrollbar` 监听 scroll 事件 | 可能出现 jank | 改为 CSS `scrollbar-color` / `scrollbar-gutter` |
| 10 | 联系人/日历/任务重复面板逻辑 | `ContactsPage` / `CalendarLayout` / `TasksPage` 各自处理 resize | 维护成本高 | 抽象共享 `ResizableThreePaneLayout` |

### 4.3 待保留的设计决策

- 中性灰阶 + 单一强调色的皮肤策略（`theme.css`）是正确方向，应保持。
- Thread Ribbon 作为状态信号的想法具有辨识度，但需增加图标/形状备份以满足可访问性。
- 自定义标题栏和 ToolWindowBar 是 Kylins 的标志性布局，不应回退到系统标题栏。
- Source Serif 4 用于主题和阅读 pane 标题可保留，但应通过主题系统可配置。

---

## 5. 视觉系统

### 5.1 色彩体系

#### 5.1.1 设计目标

- 保持当前“中性灰阶 + 可换强调色”的架构，避免全主题重写导致维护爆炸。
- 引入“主题包（Theme Pack）”概念：一套主题包 = light/dark/high-contrast 三个变体 + 强调色映射 + 字体偏好 + 间距缩放。
- 将 `assets/design-tokens.css` 与 `src/styles/theme.css` 对齐，使自动生成的 token 文件与运行时变量一致。

#### 5.1.2 Token 层级

```
Primitive（原始色板）
  └── 中性灰阶 50..950
  └── 品牌/状态原始色（blue, red, green, amber, purple…）
Semantic（语义变量）
  └── background, foreground, surface, chrome, card
  └── primary, secondary, accent, muted, border, ring
  └── success, warning, error, info
  └── link, link-hover
Component（组件变量）
  └── button-primary-bg, button-primary-fg, button-secondary-bg-hover
  └── input-bg, input-border, input-focus-ring
  └── list-row-selected-bg, list-row-hover-bg, list-row-unread-bg
  └── ribbon-bg, ribbon-group-border, statusbar-bg
```

#### 5.1.3 关键 Token 变更

| Token | 当前值 | 建议值/规则 | 说明 |
|---|---|---|---|
| `--background` | `#ffffff` | 保留 `#ffffff` | 应用底色 |
| `--surface` | `--series-100` | `#f9fafb`（light）/ `#1f2937`（dark） | pane、folder pane、status bar 背景 |
| `--chrome` | `--series-200` | `#f3f4f6`（light）/ `#111827`（dark） | 标题栏、工具栏、Ribbon 背景 |
| `--text` | `--series-900` | `#111827`（light）/ `#f9fafb`（dark） | 主要文字 |
| `--muted-text` | `--series-600` | `#4b5563`（light）/ `#9ca3af`（dark） | 次要文字、时间戳 |
| `--border` | `--series-200` | `#e5e7eb`（light）/ `#374151`（dark） | 分隔线 |
| `--ring` | accent 75% 透明 | accent 60% 透明 + 2px offset | 提高焦点可见性 |
| `--hover` | `--series-200` | `color-mix(surface 80%, foreground 5%)` | 更柔和的 hover |
| `--selected` | `--series-200` | `color-mix(accent 12%, surface)` | 选中态带品牌色 |
| `--link` | `#2563eb` | 固定为蓝色系，不受 skin 影响 | 链接始终可识别 |

> **注意：** 当前 `theme.css` 在 dark 模式下将 `--series-*` 整体反转，这是合理做法。建议保留该反转机制，但将 `--series-950` 用于最浅文字，避免在 dark 模式下出现语义混乱。

### 5.2 字体排版

#### 5.2.1 字体栈

| 用途 | 当前 | 建议 | 说明 |
|---|---|---|---|
| UI / 列表 / 按钮 | system stack | `Inter` 或 `Geist` + system fallback | 密集小字号更清晰 |
| Subject line / 阅读 pane 标题 | system serif / `Source Serif 4` | `Source Serif 4` + Georgia fallback | 保留“书信”质感 |
| 时间戳 / 元数据 | `ui-monospace` | `JetBrains Mono` + `Geist Mono` fallback | 数字对齐 |
| 邮件正文 | system sans | 跟随用户系统或主题设置 | 正文可读性优先 |

#### 5.2.2 Type Scale

| Token | 字号 | 行高 | 用途 |
|---|---|---|---|
| `--text-xs` | 11px | 14px | 状态栏、时间戳、badge |
| `--text-sm` | 13px | 16px | 文件夹名、列表行、按钮标签 |
| `--text-base` | 14px | 20px | 正文、阅读 pane 内容 |
| `--text-lg` | 16px | 22px | Pane header、Section labels |
| `--text-xl` | 20px | 26px | 列表中选中主题（serif） |
| `--text-2xl` | 24px | 30px | 阅读 pane 主题（serif） |

### 5.3 图标规范

#### 5.3.1 统一图标库

- **主图标库：** Hugeicons（已大量投入使用，stroke 一致、风格现代）。
- **替换所有 Phosphor 引用**：`ReadRibbon.tsx:57`、`RibbonPrimitives.tsx:1` 等位置应改用 Hugeicons 等价图标。
- **图标尺寸规范：**
  - ToolWindowBar：20px（当前良好）
  - Ribbon 按钮：18px
  - 列表行状态图标：14px
  - Badge / chip 图标：12px
  - 菜单项图标：16px
- **状态图标永远伴随颜色：** 未读用 `MailOpen` / 点；旗标用 `Flag`；VIP 用 `Shield` 或 `Star`。

### 5.4 阴影、圆角、边框

| Token | 建议值 | 用途 |
|---|---|---|
| `--radius-xs` | 2px | 小型 badge、分隔条 |
| `--radius-sm` | 4px | 按钮、输入框、菜单项 |
| `--radius` | 6px | Card、Popover、Dialog |
| `--radius-lg` | 8px | 大卡片、Composer |
| `--shadow-sm` | `0 1px 2px rgb(0 0 0 / 0.05)` | 按钮、输入框 |
| `--shadow` | `0 1px 3px rgb(0 0 0 / 0.1), 0 1px 2px rgb(0 0 0 / 0.06)` | Card、Dropdown |
| `--shadow-lg` | `0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)` | Modal、Composer pop-out |

**原则：** 桌面邮件客户端应减少阴影使用，依靠边框和背景色分层。阴影仅用于浮层（菜单、Dialog、Composer）。

### 5.5 动效与可访问性

| 场景 | 时长 | 缓动 | 备注 |
|---|---|---|---|
| Pane 折叠/展开 | 150ms | `ease-out` | 仅宽度变化 |
| 主题切换 | 100ms | `ease` | 所有 color token 过渡 |
| 菜单/Popover 出现 | 120ms | `cubic-bezier(0.16, 1, 0.3, 1)` | 从触发点轻微缩放 |
| 消息选择 | 0ms（instant） | — | 列表响应性优先 |
| 新邮件提示 | 300ms bounce | `ease-out` | 仅 Inbox 图标一次 |
| AI thinking | 2s pulse loop | `ease-in-out` | 遵循 `prefers-reduced-motion` |

**可访问性要求：**

- 所有交互元素焦点环可见（`--ring` + 2px offset）。
- 颜色编码状态必须有图标/文字备份。
- 支持 `prefers-reduced-motion`，禁用 pane 动画和 pulse。
- 所有图标按钮必须有 `aria-label`。
- 列表支持 `aria-rowcount`、`aria-selected`、`aria-busy`。

---

## 6. 布局架构

### 6.1 默认布局

保持 Outlook 式三栏布局，但细化尺寸与行为：

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ≡  Kylins Mail          [ 🔍 Search mail… ]      [New mail] [🔔] [⚙] [👤] │  TitleBar (48px)
├─────┬───────────────────────────────────────────────────────────────────┤
│     │  ┌─────────────────────────────────────────────────────────────┐  │
│     │  │ Ribbon Tabs: Home | View | [plugin tabs]                    │  │
│     │  │ [New] [Reply ▾] [Delete] [Archive] [Move ▾] [Flag] [More ▾] │  │  CommandRibbon (52px)
│     │  └─────────────────────────────────────────────────────────────┘  │
│     │                                                                   │
│ ✉   │  ┌───────────┐  ┌────────────────────┐  ┌─────────────────────┐ │
│ 📅  │  │ Folder    │  │ Message List       │  │ Reading Pane        │ │
│ 👤  │  │ Pane      │  │ (virtualized)      │  │                     │ │
│ 🤖  │  │ (240px)   │  │ (360px default)    │  │ (remaining)         │ │
│ ⚙   │  │           │  │                    │  │                     │ │
│     │  └───────────┘  └────────────────────┘  └─────────────────────┘ │
│     │                                                                   │
├─────┴───────────────────────────────────────────────────────────────────┤
│  Synced · 3 accounts · 127 unread        │  3 selected · 100% zoom     │  StatusBar (28px)
└─────────────────────────────────────────────────────────────────────────┘
```

### 6.2 各区域规格

| 区域 | 默认尺寸 | 最小尺寸 | 最大尺寸 | 可折叠 | 备注 |
|---|---|---|---|---|---|
| TitleBar | 48px 高 | — | — | 否 | 自定义 draggable chrome |
| ToolWindowBar | 44px 宽 | — | — | 否 | 左侧应用切换 |
| CommandRibbon | 52px 高 | 44px（折叠标签页） | — | 是 | 按 Tab 分组 |
| FolderPane | 240px 宽 | 180px | 320px | 是（至 44px mini） | 账号 + 文件夹树 |
| MessageList | 360px 宽 | 280px | 480px | 否 | 虚拟化列表 |
| ReadingPane | 剩余 | 320px | — | 是（可关闭） | 右/下/关闭三态 |
| StatusBar | 28px 高 | — | — | 是 | 真实状态 |

### 6.3 阅读 Pane 位置

`viewStore.readingPanePosition` 支持：

- `right`（默认）：FolderPane | MessageList | ReadingPane
- `bottom`：FolderPane | MessageList + ReadingPane 上下堆叠
- `off`：FolderPane | MessageList 全宽；双击/回车打开邮件在新窗口或覆盖层

**按阅读 pane 位置持久化尺寸**，避免切换 right / bottom / off 时尺寸归零。

### 6.4 窄屏 / 小窗口策略

基于 `useWindowSize` 断点：

| 断点 | 行为 |
|---|---|
| `< 768px` compact | FolderPane 变为抽屉；ReadingPane 关闭或全屏覆盖；Ribbon 仅显示图标 |
| `768px – 1024px` medium | FolderPane 可折叠为 mini-mode；MessageList 最小 280px；ReadingPane 可选 |
| `1024px – 1440px` default | 默认三栏 |
| `>= 1440px` wide | 可增加 ReadingPane 宽度，显示更多列 |

### 6.5 Ribbon 重设计

#### 6.5.1 结构

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Home  │  Send  │  View  │  [plugin tabs]                               │
├───────┴─────────────────────────────────────────────────────────────────┤
│ [New ▾] │ [Reply ▾] [Reply All] [Forward ▾] │ [Archive] [Delete] │ [Move ▾] │ [Categorize ▾] │ [Flag] [Mark Read] │ [More ▾] │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 6.5.2 分组语义

| 分组 | 操作 | 说明 |
|---|---|---|
| New | New Email、New Event、New Task | 根据 activeApp 变化 |
| Respond | Reply、Reply All、Forward、Meeting Response | 选中邮件时可用 |
| Manage | Archive、Delete、Junk、Move、Sweep | 影响邮件位置/状态 |
| Categorize | Categorize、Flag、Mark Read/Unread、Pin | 标记类操作 |
| Follow Up | Snooze、Reminder、Follow Up | 时间管理 |
| Security/AI | Encrypt、Sign、AI Summary、AI Draft | 安全与 AI 入口 |

#### 6.5.3 响应式策略

- 默认显示图标 + 标签。
- 宽度不足时，先隐藏标签保留图标；再收入 overflow menu（`⋯`）。
- 极少用操作（如 Sweep、Read Receipt）默认进 overflow。
- 分组之间用 1px 垂直分隔线（`--border`）。

### 6.6 标题栏搜索

- 将搜索框从绝对定位改为 TitleBar 内部的 flex 居中元素。
- 占位文案根据 activeApp 变化：
  - Mail: “Search mail…”
  - Calendar: “Search calendar…”
  - Contacts: “Search contacts…”
  - Tasks: “Search tasks…”
- 聚焦时展开并显示最近搜索/操作符提示。
- 搜索结果以 popover 形式展示，不跳离当前视图。

---

## 7. 导航与信息架构

### 7.1 ToolWindowBar

保留 44px 左侧图标栏，但做以下优化：

- **当前应用指示：** 活动图标左侧显示 3px accent 竖线（替代当前仅高亮背景）。
- **未读 badge：** Inbox 未读数量以小 badge 显示在图标右上角。
- **AI 助手入口：** 固定为 🤖 图标，thinking 状态时 pulse。
- **tooltip：** 延迟 400ms 显示，避免频繁弹出。
- **可扩展：** 插件可注册 `toolwindow:left` slot。

### 7.2 FolderPane

#### 7.2.1 结构

```
┌─────────────────┐
│ [+] New folder  │
├─────────────────┤
│ ★ Favorites     │
│   Inbox      12 │
│   Flagged    3  │
├─────────────────┤
│ ▼ Account A     │
│   Inbox       9 │
│   Drafts     2  │
│   Sent          │
│   ▶ Folder X    │
│   ▶ Folder Y    │
├─────────────────┤
│ ▶ Account B     │
├─────────────────┤
│ 📁 All accounts │
└─────────────────┘
```

#### 7.2.2 优化点

- **顶部操作：** 折叠/展开全部、新建文件夹、搜索文件夹。
- **收藏区：** 用户可拖拽文件夹到 Favorites，固定显示在顶部。
- **账号折叠：** 默认展开当前账号，其余折叠。
- **Unified Folders（可选）：** 多账号时显示“All accounts / Inbox / Sent / Drafts”，聚合各账号对应系统文件夹。
- **Mini-mode：** 折叠到 44px 时仅显示文件夹图标和未读 badge，hover 显示完整抽屉。
- **视觉：** 选中项使用 `--selected` 背景 + accent 左侧竖线；hover 使用 `--hover`。

### 7.3 全局搜索

#### 7.3.1 搜索栏入口

- 位于 TitleBar 中央，常驻可见。
- 支持快捷键 `Ctrl/Cmd + K` 聚焦。
- 支持 `Esc` 清空并失焦。

#### 7.3.2 操作符（参考 Gmail + Outlook）

| 操作符 | 含义 |
|---|---|
| `from:alice@example.com` | 来自某发件人 |
| `to:bob@example.com` | 发给某收件人 |
| `subject:invoice` | 主题包含 |
| `has:attachment` | 有附件 |
| `is:unread` / `is:flagged` / `is:draft` | 状态过滤 |
| `after:2026-01-01` / `before:2026-06-01` | 日期范围 |
| `in:sent` / `folder:project-x` | 文件夹范围 |

#### 7.3.3 搜索建议

- 输入时显示：最近搜索、常见操作符、联系人建议。
- 结果分类：邮件、联系人、事件、设置命令。

---

## 8. 核心组件设计

### 8.1 MessageList

#### 8.1.1 列模型

`DEFAULT_MESSAGE_LIST_COLUMNS` 中的列应真正可配置：

| 列 ID | 默认显示 | 可排序 | 可调整宽度 | 说明 |
|---|---|---|---|---|
| `threadRibbon` | 是 | 否 | 否 | 3px 状态竖线 |
| `importance` | 否 | 否 | 否 | 重要性图标 |
| `category` | 否 | 否 | 否 | 分类 chip |
| `from` | 是 | 是 | 是 | 发件人 |
| `subject` | 是 | 是 | 是 | 主题（serif） |
| `snippet` | 是 | 否 | 是 | 摘要 |
| `received` | 是 | 是 | 是 | 时间 |
| `size` | 否 | 是 | 是 | 大小 |
| `attachments` | 否 | 否 | 否 | 回形针图标 |
| `flag` | 否 | 否 | 否 | 旗标图标 |

#### 8.1.2 行布局

```
┌──┬──┬──────────────┬─────────────────────────────┬──────────┬────┬────┐
│  │★ │ Alice Smith  │ Project kickoff — Hey team… │ 10:30 AM │ 📎 │ 🚩 │
└──┴──┴──────────────┴─────────────────────────────┴──────────┴────┴────┘
```

#### 8.1.3 密度模式

| 模式 | 行高 | 字体 | 摘要 | 适用场景 |
|---|---|---|---|---|
| Compact | 32px | 12px | 单行截断 | 大屏、重度用户 |
| Normal（默认） | 40px | 13px | 单行截断 | 通用 |
| Comfortable | 52px | 14px | 两行摘要 | 笔记本、触控 |

#### 8.1.4 行状态

- **未读：** 发件人/主题加粗；Thread Ribbon 蓝色；左侧 8px 未读点。
- **已选中：** `--selected` 背景；focus 时加 `--ring`。
- **Hover：** 显示快速操作按钮（Archive、Delete、Flag、Mark Read）。
- **Flagged：** Thread Ribbon 琥珀色 + 旗标图标。
- **VIP / Safe sender：** Thread Ribbon 绿色 + Shield 图标。
- **Draft：** 主题前缀 “Draft:” 用斜体 + `--muted-text`。

#### 8.1.5 分组

保留按日分组（Today / Yesterday / Earlier this week / Month），但使用粘性表头（sticky group header）。

### 8.2 ReadingPane

#### 8.2.1 信息层次

```
┌─────────────────────────────────────────────────────────────────────┐
│ [Thread Ribbon] Subject in Source Serif 4                        🚩 │
│ From: Alice Smith <alice@example.com>        To: me, Bob           │
│ [Security badge] [SPF/DKIM/DMARC]       10:30 AM · 24 KB          │
├─────────────────────────────────────────────────────────────────────┤
│ [Classification banner — if any]                                    │
│ [Attachment list]                                                   │
│                                                                     │
│ [Email body — sandboxed iframe]                                     │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ [Reply] [Reply All] [Forward] [More ▾]                              │
└─────────────────────────────────────────────────────────────────────┘
```

#### 8.2.2 Header 优化

- **Subject：** `text-xl`（列表选中）/ `text-2xl`（阅读 pane），Source Serif 4。
- **From：** 发件人头像 + 名称 + 地址，地址可点击复制。
- **To/Cc：** 折叠为 “to me, Bob + 2”，hover/点击展开完整收件人列表。
- **时间：** 显示相对时间（10:30 AM）+ hover 显示完整日期。
- **安全徽章：** SPF/DKIM/DMARC 状态用 `ShieldCheck` / `ShieldAlert` / `ShieldX` 图标 + tooltip。
- **操作按钮：** Reply / Reply All / Forward 常驻；Archive / Delete / Move / More 可收入 overflow。

#### 8.2.3 附件

- 以 inline card 列表展示，支持预览、下载、保存到磁盘。
- 多附件时折叠为 “+3 more”。

#### 8.2.4 Inline Reply

- 点击 Reply 后，在阅读 pane 底部展开 Composer 编辑器，不弹窗。
- Inline Reply 激活时，主 Ribbon 切换到 Compose mode（当前已实现，保留）。

### 8.3 Composer

#### 8.3.1 简化目标

- 减少首次打开时的视觉噪音，聚焦 To / Subject / Body。
- Cc / Bcc / Reply-To 默认折叠，点击展开。
- 附件以 chip 列表展示，拖拽上传。

#### 8.3.2 Ribbon 上下文

Compose mode Ribbon 分组：

| 分组 | 操作 |
|---|---|
| Send | Send、Schedule Send、Undo Send |
| Format | Bold、Italic、Underline、List、Link |
| Insert | Attach、Signature、Template、Poll |
| Options | Importance、Read Receipt、Delivery Receipt |
| Security | Encrypt、Sign、Prevent Copy |
| AI | AI Draft、AI Polish、AI Summary of thread |

#### 8.3.3 AI 辅助入口

- 在 Composer 底部工具栏提供 “✨ AI Draft” 按钮。
- AI 生成内容以 ghost text 形式呈现，用户按 Tab 接受（参考 `docs/design/Composer_AI_Inline_Design.md`）。
- 所有 AI 生成内容在发送前需人工确认，不可静默发送。

### 8.4 CommandRibbon

#### 8.4.1 当前问题修复

- `ReadRibbon.tsx:421` 的 “Categorize” 和 `:450` 的 “Pin” 为 stub，应实现或移除。
- `ReadRibbon.tsx:382` 的 Archive 无 handler，应接入 `emailActions.archiveThread()`。
- 统一使用 `RibbonButton` / `RibbonSplitButton` / `RibbonToggle`，避免直接混用 Phosphor。

#### 8.4.2 分组折叠

每个分组可单独折叠为图标按钮；当空间不足时，整组移入 overflow menu。

### 8.5 StatusBar

#### 8.5.1 真实状态

| 区域 | 内容 |
|---|---|
| 左侧 | 同步状态（Syncing / Synced / Offline / Error）、账号数量、未读总数 |
| 中间 | 当前选中文件夹 / 视图名称 |
| 右侧 | 选中邮件数、缩放控制（75% / 100% / 125% / 150%）、离线指示 |

#### 8.5.2 交互

- 点击同步状态触发立即同步。
- 点击缩放打开下拉菜单，缩放应作用于 `EmailRenderer` 容器。
- 离线时右侧显示橙色离线图标。

### 8.6 PreferencesDialog

#### 8.6.1 标签页整理

当前 9 个标签页中 2 个为 “coming soon”。建议：

- 移除或合并未实现的标签页。
- 保留：General、Accounts、Appearance、Mail、Calendar & Contacts、Shortcuts、About。
- 将 Security 和 Rules 标记为 “Experimental” 并给出明确说明，而非 “coming soon”。

#### 8.6.2 Appearance 标签页增强

- Theme: Light / Dark / System
- Skin: 5+ 预定义强调色主题
- Density: Compact / Normal / Comfortable
- Reading pane: Right / Bottom / Off
- Font size: Small / Default / Large
- Serif subjects: On / Off
- Reduced motion: On / Off

---

## 9. 主题与预定义配色

### 9.1 主题包结构

一套主题包包含：

```
themes/kylins-default/
├── theme.json              # 元数据、名称、作者、依赖
├── light.css               # :root 变量
├── dark.css                # .dark 变量
├── high-contrast.css       # [data-contrast="high"] 变量
└── preview.png             # 缩略图
```

### 9.2 内置主题

| 主题 ID | 名称 | 强调色（Light） | 强调色（Dark） | 风格 |
|---|---|---|---|---|
| `kylins` | Kylins（默认） | `#2563eb` | `#60a5fa` | 经典商务蓝 |
| `slate` | Slate | `#64748b` | `#94a3b8` | 中性、低调 |
| `ocean` | Ocean | `#0ea5e9` | `#38bdf8` | 清爽天蓝 |
| `forest` | Forest | `#10b981` | `#34d399` | 自然绿 |
| `amber` | Amber | `#f59e0b` | `#fbbf24` | 温暖琥珀 |
| `berry` | Berry | `#d946ef` | `#e879f9` | 现代莓红 |
| `mono` | Mono | `#18181b` | `#f4f4f5` | 黑白高对比 |
| `sunset` | Sunset | `#f97316` | `#fb923c` | 活力橙 |

> 当前 `skins.ts` 中的 8 套皮肤可映射到上述主题，并补充 `light/dark/high-contrast` 三个变体。

### 9.3 高对比模式

- 新增 `[data-contrast="high"]` 属性。
- 使用纯黑/纯白背景，边框加粗到 2px，所有文字对比度 >= 7:1。
- 禁用半透明和细微 hover 色差。

### 9.4 主题切换

- `themeManager.applyTheme('light' | 'dark' | 'system')` 保持不变。
- 新增 `themeManager.applySkin(skinId)` 和 `themeManager.setContrast('default' | 'high')`。
- 主题切换时所有 CSS 变量在 100ms 内过渡，避免闪烁。

---

## 10. 响应式与可访问性

### 10.1 响应式策略

| 宽度 | 变化 |
|---|---|
| `< 640px` | 不支持正式桌面布局，显示“请调整窗口大小”提示或切换为全屏阅读模式 |
| `640px – 768px` | FolderPane 抽屉化；MessageList 全宽；ReadingPane 作为覆盖层 |
| `768px – 1024px` | FolderPane 可折叠为 mini-mode；MessageList 280px 起；ReadingPane 可选 |
| `1024px – 1440px` | 默认三栏，适合笔记本 |
| `>= 1440px` | 宽屏可增加 ReadingPane 宽度，显示完整列 |

### 10.2 容器查询

继续使用 `globals.css` 中的容器查询，但细化断点：

- MessageList 容器 `< 360px`：隐藏 snippet、size、attachment 列。
- MessageList 容器 `< 480px`：隐藏 received、flag 列。
- ReadingPane 容器 `< 480px`：header 操作按钮仅显示图标。
- ReadingPane 容器 `< 360px`：header 操作按钮移入 overflow menu。

### 10.3 可访问性清单

- [ ] 所有颜色状态有非颜色备份。
- [ ] 焦点环在所有主题下可见。
- [ ] 列表支持键盘导航（↑/↓、Space 选择、Enter 打开）。
- [ ] Ribbon 按钮支持 Alt 快捷键（如 Alt+H 打开 Home tab）。
- [ ] `prefers-reduced-motion` 禁用 pane 动画。
- [ ] 高对比模式通过系统设置自动触发或手动开启。
- [ ] 所有 Dialog 有 `aria-labelledby` 和 `aria-describedby`。
- [ ] 搜索框有 `role="search"` 和清晰的 label。

---

## 11. 实施路线图

### Phase 1：视觉系统与布局骨架（低风险、高可见）

**目标：** 建立可扩展主题系统，修复布局级问题。

- [ ] 对齐 `assets/design-tokens.css` 与 `src/styles/theme.css`。
- [ ] 扩展 `skins.ts` 为 ThemePack 模型，支持 light/dark/high-contrast。
- [ ] 实现 `themeManager.setContrast()`。
- [ ] 统一图标库，替换 Phosphor 引用。
- [ ] 重构 `TitleBar.tsx` 搜索框为 flex 居中，移除 CSS 变量绝对定位。
- [ ] 抽象 `ResizableThreePaneLayout`，替换 Contacts/Calendar/Tasks 中的重复逻辑。
- [ ] 修复 `StatusBar.tsx` 接入真实状态（选中、同步、离线、缩放）。

### Phase 2：MessageList / ReadingPane / Ribbon（核心体验）

**目标：** 改善邮件 triage 和阅读体验。

- [ ] 重写 `MessageList` 行渲染，使 `visibleColumnIds` 真正生效。
- [ ] 实现 hover 快速操作（Archive、Delete、Flag、Mark Read）。
- [ ] 实现 Focused Inbox 分类视图（顶层 tab：Focused / Other）。
- [ ] 优化 `ReadingPane` header 信息层次，接入真实安全徽章。
- [ ] 实现 `readerZoom` 在 `EmailRenderer` 上的消费。
- [ ] 重设计 `CommandRibbon` 响应式策略，实现 overflow menu。
- [ ] 修复 ReadRibbon stub 按钮（Categorize、Pin、Archive handler）。

### Phase 3：Composer / Preferences / 动效 polish（完善）

**目标：** 完成剩余交互细节和可访问性。

- [ ] 简化 Composer 默认视图，折叠 Cc/Bcc。
- [ ] 统一 Reply/Forward 入口，统一使用 `composerActions`。
- [ ] 整理 `PreferencesDialog` 标签页，移除 “coming soon”。
- [ ] 在 Appearance 中增加 Serif subjects、Font size、High contrast 选项。
- [ ] 用 CSS 替换 `useAutoHideScrollbar` 的 JS 滚动监听。
- [ ] 完成可访问性清单和高对比模式。
- [ ] 添加/更新 Vitest 测试覆盖新组件行为。

### Phase 4：未来可选（不在本次范围）

- 标签系统（彩色 tags，参考 Thunderbird）。
- Unified Folders 跨账号聚合。
- AI Summary / AI Draft 在阅读 pane 和 Composer 的完整集成。
- 插件主题包加载机制。

---

## 12. 附录

### 12.1 相关文件索引

- `kylins.client.frontend/src/components/layout/AppShell.tsx`
- `kylins.client.frontend/src/components/layout/TitleBar.tsx`
- `kylins.client.frontend/src/components/layout/ToolWindowBar.tsx`
- `kylins.client.frontend/src/components/layout/FolderPane.tsx`
- `kylins.client.frontend/src/components/layout/MessageList.tsx`
- `kylins.client.frontend/src/components/layout/ReadingPane.tsx`
- `kylins.client.frontend/src/components/layout/StatusBar.tsx`
- `kylins.client.frontend/src/components/layout/CommandRibbon.tsx`
- `kylins.client.frontend/src/components/layout/ribbon/ReadRibbon.tsx`
- `kylins.client.frontend/src/components/layout/ribbon/ComposeRibbon.tsx`
- `kylins.client.frontend/src/features/view/components/ReadingPaneLayout.tsx`
- `kylins.client.frontend/src/styles/theme.css`
- `kylins.client.frontend/src/styles/skins.css`
- `kylins.client.frontend/src/styles/skins.ts`
- `kylins.client.frontend/src/services/theme/themeManager.ts`
- `assets/design-tokens.css`

### 12.2 待确认问题

1. 是否需要保留 Source Serif 4 作为默认主题字体，还是作为可选主题设置？
2. Focused Inbox 的分类逻辑是本地规则驱动，还是依赖未来 AI 分类？
3. 高对比模式是否跟随系统 `prefers-contrast: more`，还是仅在应用内开关？
4. Ribbon 的 overflow menu 是否按分组整体折叠，还是按单个按钮折叠？
5. 是否需要将 `assets/design-tokens.css` 改为运行时自动生成，还是保持手动维护？

### 12.3 术语表

- **triage：** 快速浏览并决定邮件是否需要处理的动作。
- **Thread Ribbon：** 邮件行和阅读 pane 左侧的 3px 状态竖线。
- **Theme Pack：** 包含 light/dark/high-contrast 变体的完整主题包。
- **Focused Inbox：** 将重要邮件与其他邮件分离的收件箱视图。
- **Quick Actions：** 列表行 hover 时显示的快捷操作按钮。

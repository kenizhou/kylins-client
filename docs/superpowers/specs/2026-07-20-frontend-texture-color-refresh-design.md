# Kylins Mail Frontend — Texture & Color Harmony Refresh

**日期：** 2026-07-20  
**状态：** 设计阶段 — 待用户评审  
**范围：** `kylins.client.frontend` 视觉质感、色彩协调、统一性与用户体验提升  
**依赖：** 继承 `2026-07-17-frontend-redesign-design.md` 的总体架构与阶段划分

---

## 1. 目标

解决当前前端“色调过于单一、质感不够明显、页面不够鲜活协调”的问题。在不推翻现有布局和已实现功能的前提下，通过一套统一的 **Fluent Acrylic** 视觉语言，让整个客户端看起来更有层次、更专业、更协调。

核心目标：
1. 建立更强的表面质感（acrylic / glass / depth）。
2. 改善色彩搭配，让中性灰与强调色更协调，页面更鲜活。
3. 统一所有页面和组件的视觉语言（圆角、阴影、边框、hover/selected 状态）。
4. 增强微动效，让交互更自然。
5. 保持可访问性（高对比、减少动效）。

---

## 2. 设计方向：Fluent Acrylic

采用 Microsoft Fluent Design 风格的亚克力质感：
- **分层表面**：背景、表面、卡片、浮动层有明确的深度区分。
- **柔和光感**：从左上角入射的漫反射高光，给表面带来轻微的光泽。
- **半透明 + 模糊**：chrome 栏、菜单、浮层使用 backdrop-filter 模糊，露出背后的层次。
- **低饱和中性色 + 有节制的强调色**：避免花哨，但让关键操作和状态有色彩锚点。
- **一致的圆角和阴影语言**：每个 elevation 层级对应固定的圆角和阴影。

---

## 3. 视觉系统

### 3.1 色彩层级

保持“中性灰阶 + 单一强调色”的架构，但引入更丰富的语义色：

| Token | 用途 | 说明 |
|---|---|---|
| `--background` | 应用最底层背景 | 比当前略暖/略深，避免死白 |
| `--surface` | 主要工作区背景 | folder pane、message list 等 |
| `--surface-elevated` | 比 surface 高一层的背景 | card、popover |
| `--surface-floating` | 浮层背景 | menu、toast、dropdown |
| `--chrome` | chrome 栏背景 | titlebar、leftbar、statusbar、ribbon |
| `--chrome-tint` | chrome 强调色混合 | 让 chrome 随 skin 轻微染色 |
| `--card` | 卡片背景 | 阅读 pane、设置卡片 |
| `--foreground` | 主要文字 | 高对比但不过于刺眼 |
| `--muted-foreground` | 次要文字 | 时间戳、摘要、placeholder |
| `--primary` | 主要强调色 | 按钮、选中态、链接 |
| `--primary-subtle` | 强调色极淡混合 | hover、背景高亮 |
| `--primary-muted` | 强调色淡混合 | selected 背景 |
| `--border` | 主边框 | 清晰但不抢眼 |
| `--border-subtle` | 0.5px / 低透明度边框 | 用于细分表面 |
| `--ring` | 焦点环 | 2px，高可见 |

每个 skin 的强调色会流入 `--primary`、`--chrome-tint`、`--primary-subtle`、`--primary-muted`，使整套 UI 随主题协调变化。

### 3.2 深度 / Elevation 系统

定义 5 个 elevation 层级，每个层级对应固定的背景、边框、阴影、圆角：

| Level | 名称 | 背景 | 边框 | 阴影 | 圆角 | 用途 |
|---|---|---|---|---|---|---|
| 0 | Base | `--background` | 无 | 无 | 无 | 应用底色 |
| 1 | Surface | `--surface` | `--border-subtle` | 无 | `--radius-md` | pane、list 容器 |
| 2 | Card | `--card` / `--surface-elevated` | `--border` | `--shadow-sm` | `--radius-lg` | reading pane、settings card |
| 3 | Floating | `--surface-floating` | `--border` | `--shadow-md` | `--radius-lg` | popover、menu、dropdown |
| 4 | Modal | `--surface-floating` | `--border` | `--shadow-xl` | `--radius-xl` | modal、composer |

### 3.3 Chrome 玻璃系统

chrome 栏（titlebar / leftbar / statusbar）使用增强的 acrylic：

- `--chrome-glass`: `color-mix(in srgb, var(--chrome) 65%, transparent)`
- `--chrome-glass-start`: 外侧边缘带白色高光
- `--chrome-glass-end`: 内侧边缘更透明
- Backdrop blur: `blur(20px) saturate(200%)`
- 无 chrome 之间的边框，依靠阴影和背景差异区分
- 高对比模式下回退为不透明 solid chrome

### 3.4 圆角与间距

统一圆角阶梯：
- `--radius-xs: 2px` — badge、分隔条
- `--radius-sm: 4px` — 小按钮、输入框
- `--radius-md: 6px` — 按钮组、列表项
- `--radius-lg: 10px` — 卡片、panel
- `--radius-xl: 14px` — 大卡片、modal
- `--radius-2xl: 18px` — composer、大弹窗

间距保持紧凑但更有呼吸感：
- 主要 pane 内边距从 `p-2` 提升到 `p-3`
- 卡片内部使用 `gap-3` / `gap-4`
- 列表项高度：compact 32px / normal 40px / comfortable 52px

### 3.5 动效

建立标准动效 token：
- `--duration-instant: 0ms`
- `--duration-fast: 120ms`
- `--duration-normal: 200ms`
- `--duration-slow: 300ms`
- `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`
- `--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)`

微动效：
- 按钮 hover: 背景色 + 轻微 scale(1.02)
- 卡片 hover: 轻微 translateY(-1px) + shadow 加深
- 列表项 hover: 背景色过渡 120ms
- 选中态: 即时响应，无动画
- Popover/menu: 120ms scale + fade
- Toast: 200ms slide-up

---

## 4. 分页面设计要点

### 4.1 Chrome 栏

- **TitleBar**: true acrylic，左侧 menu + 搜索框居中 + 右侧操作图标。搜索框使用 `--surface-floating` 背景，聚焦时展开。
- **ToolWindowBar**: 垂直 acrylic，当前应用图标左侧 accent 竖线，hover 时图标背景带 `--primary-subtle`。
- **StatusBar**: 底部 acrylic，信息分组清晰，左侧同步状态可点击触发同步。

### 4.2 邮件主界面

- **FolderPane**: 作为 level-1 surface，文件夹树使用 level-1 背景；选中项使用 `--primary-muted` + accent 左侧竖线；hover 使用 `--primary-subtle`；账号头部分组清晰。
- **MessageList**: 列表容器 level-1 surface；行 hover 显示快速操作；未读行使用 bold + accent thread ribbon；选中行使用 `--primary-muted`；不同状态（flagged、important、draft）使用色彩图标/ribbon 区分。
- **ReadingPane**: level-2 card，header 使用 serif subject，发件人信息清晰分层，附件为 inline chips，操作按钮分组。
- **CommandRibbon**: level-1 chrome surface，分组之间有 subtle 分隔线，按钮 hover 有背景变化，active tab 底部 accent 线。

### 4.3 日历

- 月视图网格使用 subtle 边框，当前日期使用 accent 圆圈高亮。
- 事件 chips 使用分类颜色，hover 有轻微 lift。
- 工具栏使用 level-1 surface。

### 4.4 联系人

- 联系人列表项使用 avatar + 名称 + 邮箱，hover 使用 `--primary-subtle`。
- 详情卡片使用 level-2 card，分组标题使用 muted 文字。
- 分组标签使用 subtle chip。

### 4.5 任务

- 任务列表使用 checkbox + 标题 + due date，优先级使用颜色点/标签。
- 详情使用 level-2 card。

### 4.6  composer

- 头部使用 level-1 chrome，字段（To/Subject）清晰分层。
- 编辑器工具栏使用 level-1 surface。
- 附件 chips 使用 level-2 背景。

### 4.7 偏好设置 / 对话框

- 偏好设置使用 level-2 card 包裹每个 section。
- Modal 使用 level-4 elevation，带 backdrop blur。
- 空状态使用 subtle 图标 + 文字，避免大灰块。

---

## 5. 实施阶段

继承 `2026-07-17-frontend-redesign-design.md` 的阶段划分，但本次聚焦视觉质感，按以下顺序推进：

### Phase 1: Token & Utility 基础

- 扩展 `theme.css`：新增 `--surface-elevated`, `--surface-floating`, `--primary-subtle`, `--primary-muted`, `--chrome-tint`, `--border-subtle`, elevation shadows, radius tokens, duration/easing tokens。
- 更新 `globals.css`：将新 token 暴露为 Tailwind colors/utilities；创建 `@utility` 工具类（`.surface`, `.surface-elevated`, `.card`, `.floating`, `.modal`, `.glass`, `.glass-strong`）。
- 更新 `skins.css`：让强调色更协调地流入新 token。
- 确保高对比模式和深色模式正确映射新 token。

### Phase 2: Chrome 栏质感

- 增强 `TitleBar`, `ToolWindowBar`, `StatusBar` 的玻璃效果（更强 blur、白色高光、无分裂边框）。
- 让搜索框更融入 acrylic 风格。
- 调整 ToolWindowBar 激活态 indicator。

### Phase 3: 邮件主界面

- 重构 `FolderPane`, `MessageList`, `ReadingPane`, `CommandRibbon` 的表面样式，使用新的 elevation/token 系统。
- 统一 hover/selected 状态颜色。
- 增强 message row 的快速操作和状态表达。

### Phase 4: 二级页面统一

- 应用新视觉系统到 `CalendarPage`, `ContactsPage`, `TasksPage`, `Composer`, `PreferencesDialog`, `Modal`, `Toaster`, 空状态。
- 统一按钮、输入框、卡片、对话框样式。

### Phase 5: 动效 Polish

- 添加/统一微动效（button hover、card hover、popover、toast、list transitions）。
- 确保 `prefers-reduced-motion` 和 `[data-reduce-motion='true']` 生效。

---

## 6. 可访问性

- 高对比模式：所有玻璃效果回退为 solid，边框加粗，颜色对比度 >= 7:1。
- 减少动效：所有 transform/opacity 动画归零。
- 焦点环：在所有表面下清晰可见。
- 颜色不单独传递状态：重要状态必须伴随图标或文字。

---

## 7. 成功标准

1. 所有页面使用统一的 token，不再有硬编码色值或混合的 `bg-[var(--x)]` / `bg-x` 模式。
2. Chrome 栏有明显的 acrylic 质感，无分裂线。
3. 邮件主界面（folder/list/reader/ribbon）视觉层次清晰，hover/selected 状态协调。
4. 二级页面（calendar/contacts/tasks/composer/preferences）与主界面风格一致。
5. `npm run lint`, `npx tsc --noEmit`, `npx vitest run` 全部通过。

---

## 8. 相关文件

- `kylins.client.frontend/src/styles/theme.css`
- `kylins.client.frontend/src/styles/globals.css`
- `kylins.client.frontend/src/styles/skins.css`
- `kylins.client.frontend/src/components/layout/*.tsx`
- `kylins.client.frontend/src/components/calendar/*.tsx`
- `kylins.client.frontend/src/components/contacts/*.tsx`
- `kylins.client.frontend/src/components/tasks/*.tsx`
- `kylins.client.frontend/src/components/composer/*.tsx`
- `kylins.client.frontend/src/components/preferences/*.tsx`
- `kylins.client.frontend/src/components/ui/*.tsx`

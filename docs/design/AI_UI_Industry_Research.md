# AI Native Email Client — 业界实践与 UI 设计研究

> 研究日期: 2026-06-30
> 来源: Web 搜索 + CopilotKit 源码分析 + Shortwave/Superhuman 技术博客 + 学术研究

---

## 一、业界 AI Native 邮件架构最佳实践

### 1.1 核心趋势：从"AI 外挂"到"AI 原生"的架构转变

2025-2026 年的共识：**AI Native ≠ 在传统邮件客户端侧边栏加个 ChatGPT。**

| 传统邮件客户端 | AI Native 邮件客户端 |
|---|---|
| 人类驱动的 triage | Agent 驱动的处理 |
| 静态规则过滤 | 语义分类 + 意图提取 |
| 模板化回复 | RAG 驱动的个性化草稿 |
| 同步阻塞 I/O | 异步后台 Agent 编排 |
| 单一进程 | 多进程隔离 Agent 架构 |

**关键洞察（来自 Upstream 2026 技术博客）：** AI Agent 在独立子进程中运行，有 CPU/内存配额，永远不与 UI 线程竞争。编排器使用 DAG（有向无环图）工作流（LangGraph）根据分类结果路由邮件。

### 1.2 多 Agent 架构是主流

Coremail、Upstream、NeuroMail、Wizard Mail 的共识——**不是一个 LLM 调用来处理一切，而是专门的 Agent 分工：**

| Agent | 职责 |
|-------|------|
| **Triage/Classification Agent** | 语义收件箱排序、优先级评分、垃圾检测 |
| **Intent Extraction Agent** | NER 实体识别、提取截止日期/订单/联系人 |
| **Reply Drafting Agent** | RAG 上下文感知回复生成 |
| **Background Task Agent** | 低优先级自动化：归档、附件解析、清理 |
| **Orchestrator/Scheduler** | DAG 工作流路由、任务优先级、降级/重试 |

### 1.3 Shortwave 的架构（最值得学习）

Shortwave 是目前 AI 邮件领域最深入的产品。其架构有几个关键决策：

#### 核心押注：单次 LLM 推理而非链式调用

> "Long LLM call chains introduced data loss and errors at each stage."

Shortwave 发现链式 LLM 调用会在每一阶段引入数据丢失和错误。他们的方案是：**把所有上下文收集到一个大 Prompt 中，一次 GPT-4 调用完成**。

#### 四阶段流水线

```
Step 1: Tool Selection (GPT-4)
  → 判断需要哪些数据源 (Calendar? EmailHistory? Compose?)
  
Step 2: Tool Data Retrieval (并行)
  → 所有选中的 Tool 并行执行
  → 每个 Tool 内部是独立的 AI 子系统
  
Step 3: Question Answering (单次 GPT-4)
  → 所有上下文 + 原始问题 → 一次调用
  
Step 4: Post-Processing
  → 富文本转换 + 源引用 + UI action 建议
```

#### AI Search 五阶段检索流水线

这是业界最成熟的邮件 RAG 实现：

| 阶段 | 技术 | 目的 |
|------|------|------|
| 1. Query Reformulation | LLM 改写 | "What about Jonny?" → "When does Jonny land in Phoenix?" |
| 2. Feature Extraction | 并行快速 LLM | 提取日期范围、人名、关键词、标签（带置信度） |
| 3. Vector Search | Instructor Embedding + Pinecone | 语义搜索，用提取的特征限定范围 |
| 4. Heuristic Re-Ranking | 高斯日期过滤 + 联系人多重 boost + 类别降权 | 1000+ → dozens |
| 5. Cross-Encoder Re-Ranking | MS Marco MiniLM (自建 GPU) | 深度相关性评分 |

**端到端延迟: 3-5 秒**（通过大量并发 + streaming + pipelining）

#### Shortwave 的记忆哲学

**没有独立的"记忆存储"。** 向量数据库（Pinecone，per-user namespace）+ 邮件全文索引（ElasticSearch）就是"记忆"。每次查询都是 stateless 检索——"记忆"就是邮件语料库本身。

这与我在 Memory_System_Design.md 中的观点完全一致：**邮件本身就是天然的记忆系统，不需要单独建 Episodic Memory。**

### 1.4 Superhuman 的架构（对比参考）

Superhuman 走了不同路线——**并行多 Agent 认知架构：**

```
Query → 两条并行路径:
  
  Path A: Tool Classification
    → 分类意图: email search only / email+calendar / 
                availability / scheduling / direct LLM
                
  Path B: Metadata Extraction
    → 提取时间过滤、发件人、附件作为检索参数
    
  → Hybrid Search (语义 + 关键词 + 元数据)
  → 任务特定 Prompt 选择
  → LLM 合成最终答案
```

**关键数据：** 搜索时间减少 14%（每周节约 ~5 分钟），sub-2-second 响应。

### 1.5 混合分类：规则 + 语义

纯粹 LLM 分类每封邮件太慢太贵。最佳实践是双层混合：

| 层 | 技术 | 覆盖 | 延迟 |
|----|------|------|------|
| **Tier 1** | 确定性规则引擎 (O(1) hashing) | ~60% 邮件 | <1ms |
| **Tier 2** | LLM 语义推理 + JSON Schema 输出 | ~40% 复杂/模糊邮件 | API 依赖 |
| **Fallback** | 本地小模型 (Qwen-1.8B) | 云端 API 不可用时 | 本地 |

用户纠错反馈每 24 小时更新分类 Prompt——无需模型重训练。

### 1.6 Local-First RAG 是隐私标配

Canary Mail (2026) 和 Upstream 的技术方案汇聚于：

- **本地 HNSW 向量引擎** — 无云端依赖，百万级向量的亚毫秒检索
- **分层记忆架构：** Hot memory（10 轮对话，零 I/O）→ Warm vectors（历史线程，本地向量库）→ Cold storage（>90天，压缩到磁盘）
- **int8 量化** — 向量存储减少 75%，精度损失 <2%

### 1.7 开放标准 > 私有 SDK

Atomic Mail (2026) 确立了关键原则：**AI Agent 应通过开放 IETF 标准（JMAP）连接邮件，而非供应商特有 SDK。**

原因: LLM 已经理解 JSON over HTTPS，不需要"下载 SDK"。JMAP 被 Claude、Codex 等模型原生识别。

---

## 二、CopilotKit 评估：适合 Kylins 吗？

### 2.1 CopilotKit 是什么

CopilotKit 是一个**全栈 Agentic 应用框架**（33K+ GitHub stars），远超简单的 Chat UI 库。核心能力：

| 能力 | 说明 |
|------|------|
| **Generative UI** | Agent 渲染真实 React 组件（卡片、图表、表单），不仅仅是文本 |
| **双向共享状态** | Agent 和 UI 状态实时同步，Agent 可以读写应用状态 |
| **Human-in-the-Loop** | Agent 暂停执行，请求用户确认后才执行关键操作 |
| **持久化线程** | 完整的对话历史、状态、生成 UI 跨 session 保存 |
| **自学习 (CLHF)** | 上下文强化学习，无需模型微调即可按用户优化 |

### 2.2 AG-UI 协议 — CopilotKit 的核心贡献

CopilotKit 团队创建了 **AG-UI (Agent-User Interaction Protocol)**——一个开放的、轻量的、事件驱动的 Agent-UI 通信标准，已被 Google、Microsoft、AWS、LangChain、CrewAI 采用。

**16 种事件类型，分 5 类：**

```
🔵 Lifecycle:  RUN_STARTED, STEP_STARTED, STEP_FINISHED, RUN_FINISHED, RUN_ERROR
🟢 Text:       TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END  
🟣 Tool Call:  TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, TOOL_RESULT
🟡 State:      STATE_SNAPSHOT, STATE_DELTA
🔴 Special:    INTERRUPT (HITL), CUSTOM, RAW
```

**关键价值：** 前后端解耦——前端不关心后端是 LangGraph、CrewAI 还是 Mastra。换 Agent 框架不需要动 UI 代码。

### 2.3 三种 Generative UI 模式

| 模式 | 做法 | 适用场景 |
|------|------|---------|
| **Controlled** | 你写 React 组件，Agent 选择并填充 | 生产环境首选，可控 |
| **Declarative (A2UI)** | Agent 输出 JSON Schema，前端映射组件 | 长尾功能，与 Google A2UI 对齐 |
| **Open-ended** | Agent 生成原始 HTML/CSS | 最大灵活，最少控制 |

### 2.4 CopilotKit vs Vercel AI SDK

这两者**不是竞争对手——它们在不同的抽象层：**

| 维度 | CopilotKit | Vercel AI SDK |
|------|-----------|---------------|
| **定位** | 全栈 Agentic 应用框架 | 底层 streaming 工具包 + Provider 抽象 |
| **类比** | "预装好的精装房" | "原材料 + 电动工具" |
| **体积** | ~87 KB gzip | ~42 KB gzip |
| **架构耦合** | **重** — 你采纳了他们的 Agent 执行模型 | 轻 — 只是一个库 |
| **首次可聊** | 25 分钟 | 40 分钟 |
| **自定义 UI** | 容易（覆写默认） | 中等（从零构建） |
| **TypeScript** | Good | Excellent |
| **框架支持** | React/Angular 为主 | 框架无关 (React/Vue/Svelte) |

### 2.5 对 Kylins 的建议：分层采纳

**不建议全套引入 CopilotKit。** 原因：

1. **架构锁入太重。** CopilotKit 要求你按它的 Agent 执行模型、状态同步、Action 系统来组织代码。Kylins 已有 Tauri + Zustand + Plugin 系统的明确架构，引入 CopilotKit 会与现有架构冲突。

2. **我们的 Agent 逻辑在 Rust 侧。** CopilotKit 假设 Agent 在 Node.js/Python 后端，通过 `/api/copilotkit` endpoint 通信。但 Kylins 的 AI 数据处理在 Rust 侧，架构不匹配。

3. **Bundle size。** 87KB 对于一个桌面应用不是大问题，但 CopilotKit 的核心价值（Generative UI、Shared State、Agent Orchestration）我们大部分用不到——我们的 Agent 是 Rust 侧的，前端只需展示结果。

**但是，以下是值得采纳的部分：**

#### ✅ 采纳：AG-UI 协议的事件模型

不引入 CopilotKit 的代码，但采纳其事件模型设计：

```typescript
// 我们自建的轻量 AI 事件系统，借鉴 AG-UI 的事件分类
type AIEvent =
  // Lifecycle
  | { type: 'run:started', runId: string }
  | { type: 'run:finished', runId: string }
  | { type: 'run:error', runId: string, error: string }
  // Text streaming
  | { type: 'text:start', messageId: string }
  | { type: 'text:delta', messageId: string, content: string }
  | { type: 'text:end', messageId: string }
  // Tool calls (Agent → Tools)
  | { type: 'tool:start', toolName: string, args: unknown }
  | { type: 'tool:result', toolName: string, result: unknown }
  // State sync (for Daily Briefing, etc.)
  | { type: 'state:snapshot', data: unknown }
  | { type: 'state:delta', path: string, value: unknown };
```

Tauri 端通过 Event 推送这些事件，前端统一处理。

#### ✅ 采纳：Generative UI 的 Controlled Mode 思路

Agent 不生成 HTML，而是返回组件名 + props：

```typescript
// Rust 侧 Agent 返回的结构
struct AgentResponse {
    text: String,                    // 人类可读文本
    components: Vec<GeneratedUI>,   // UI 组件
    actions: Vec<SuggestedAction>,  // 建议操作
}

struct GeneratedUI {
    component: String,  // "EmailSummaryCard" | "CommitmentTracker" | "ContactProfile"
    props: serde_json::Value,
}
```

前端映射 component 名 → React 组件。这比 CopilotKit 的实现简单得多，但核心思路一致。

#### ❌ 不采纳：CopilotKit 的 Runtime、CoAgent、Shared State

这些与我们的 Tauri+Rust 架构不兼容，且我们不需要 Agent 在 React 组件树中"读/写"任意状态。

### 2.6 结论

| 部分 | 决策 |
|------|------|
| CopilotKit 全套框架 | ❌ 不适合 — 架构冲突，锁入太重 |
| AG-UI 协议事件模型 | ✅ 借鉴设计 — 自建轻量实现 |
| Generative UI (Controlled) | ✅ 借鉴思路 — Agent 返回组件名+props |
| CopilotKit Runtime/CoAgent | ❌ 不适合 — Rust 侧 Agent 架构不兼容 |
| Chat UI 组件 | ❌ 不适合 — 我们做的是邮件客户端，不是 chatbot 框架 |

---

## 三、Conversational UI 设计

### 3.1 业界现状：Chat 不是答案，嵌入式 AI 才是

2025 年的研究数据非常明确：
- **浮动 Chat Bubble** → 4% 用户参与率
- **嵌入式 Context Panel** → 28% 活跃用户，任务完成时间从 40 分钟降到 18-20 分钟

> "Sad Chat Bubble" — 浮动的聊天按钮没人点。把 AI 嵌入到用户实际工作的地方。

### 3.2 三种 Conversational UI 模式

| 模式 | 描述 | 适用场景 | Kylins 适用度 |
|------|------|---------|-------------|
| **Context Side Panel** | 可折叠面板，"看到"当前屏幕 | 复杂工具、IDE、Dashboard | ⭐⭐⭐⭐⭐ 最适合 |
| **Inline Assistant** | AI 图标/按钮直接嵌入操作对象旁 | 表单、文本块、表格 | ⭐⭐⭐⭐ Composer 中适用 |
| **Standalone Chat** | 独立的对话界面 | 客服、简单问答 | ⭐⭐ 辅助使用 |

### 3.3 对 Kylins 的建议

**主要交互：Context Side Panel（AI 助手侧面板）**

```
┌──────────────────┬───────────────────────┬──────────────────────┐
│ FolderPane       │ MessageList           │ ReadingPane          │
│                  │                       │                      │
│                  │                       │ [AI Summary Card]    │
│                  │                       │ "这封邮件是关于..."   │
│                  │                       │                      │
│                  │                       │ Email Body           │
│                  │                       │                      │
│                  │                       ├──────────────────────┤
│                  │                       │ AI Assistant Panel   │
│                  │                       │ (可折叠/展开)         │
│                  │                       │                      │
│                  │                       │ 💬 对这封邮件提问...  │
│                  │                       │                      │
│                  │                       │ 建议 actions:        │
│                  │                       │ • 总结此线程         │
│                  │                       │ • 生成回复草稿       │
│                  │                       │ • 提取待办事项       │
│                  │                       │ • 查找相关邮件       │
└──────────────────┴───────────────────────┴──────────────────────┘
```

**辅助交互：Natural Language Command Bar（Ctrl+K）**

```
┌─────────────────────────────────────────────────────┐
│ 🔍 "找一下和张三关于Q4预算的邮件，总结关键结论"        │
│                                                     │
│ [搜索邮件] [写邮件] [查看日程] [更多...]              │
└─────────────────────────────────────────────────────┘
```

类似 Superhuman 的 Command Bar，但支持自然语言。

**Composer 内嵌：Inline AI Assist**

在 Composer 中，AI 按钮嵌入工具栏，而非独立面板：
- "Generate draft from prompt"
- "Improve tone"（正式/友好/简洁）
- "Translate to English"

---

## 四、Ambient UI 设计

### 4.1 核心理念

Ambient UI 是 2025 年 AI 设计领域最重要的概念之一。它回答了 "AI 如何在不打扰用户的情况下主动提供价值"。

**定义：** Ambient Intelligence = 在后台安静运行的 AI，感知上下文，适时提供帮助，无需显式交互。

**关键数据（TELUS 2025 研究）：**
- 83% 用户想要跨设备的、ambient-first 的 AI 存在
- 89% 用户想要了解他们习惯、偏好和上下文的系统

### 4.2 五大设计原则

| 原则 | 说明 | 反模式 |
|------|------|--------|
| **1. Transparency** | 显示推理过程——用户需要知道 AI 为什么这么做 | 黑箱操作，用户不知道 AI 做了什么 |
| **2. Human-at-the-Lever** | 用户设上下文和护栏，AI 在范围内自主执行 | 每次都要确认（"Are you sure?"） |
| **3. Contextual Relevance** | 只在相关时出现，2 秒扫一眼就能理解 | 常驻占位，信息过载 |
| **4. Proactive ≠ Intrusive** | 识别合适时机才主动介入，知道何时保持沉默 | Clippy 综合症——过度打扰 |
| **5. Reversible** | 所有 AI 操作可撤销，一键回退 | 不可逆的自动操作 |

### 4.3 Ambient UI 的具体形态（邮件客户端场景）

#### Pattern 1: Daily Briefing（每日简报）

**这是邮件客户端 Ambient UI 最重要的形态。**

```
用户每天早上打开客户端时看到：

┌─────────────────────────────────────────┐
│ ☀️ Good morning, Keni                    │
│                                         │
│ 🔴 Needs Your Attention (3)             │
│  • 李总: Q4合作提案 — 需今天回复        │
│  • HR: 报销审批 — 截止今天               │
│  • 团队: Sprint Review @ 2PM            │
│                                         │
│ 📥 Since Last Night (12)                │
│  • 已为你归档 8 封通知类邮件             │
│  • 4 封值得一看: [展开]                  │
│                                         │
│ ⏳ Waiting On Others (5)                │
│  • 供应商报价 — 等了 3 天                │
│  • 客户确认 — 等了 1 周                  │
│                                         │
│ ✍️ Drafts Ready For Review (2)          │
│  • Reply to 张总: [预览] [发送]         │
│  • Follow-up to ABC Corp: [预览] [发送] │
│                                         │
│ 📊 Your Inbox Health                     │
│  本周收到 87 封 | 已处理 64 封           │
│  平均回复时间: 4.2 小时                  │
└─────────────────────────────────────────┘
```

**触发时机：** 每天早上第一次打开客户端（或可配置时间）
**来源数据：** 收件箱新邮件 → Entity Extraction → Commitment Tracking → LLM 生成
**关闭方式：** 一键关闭，不影响正常使用

#### Pattern 2: Proactive Cards（主动建议卡片）

在用户正在操作时，AI 主动提供上下文相关的建议——但不抢占主界面。

```
用户在 ReadingPane 查看邮件时：

┌─────────────────────────────────┐
│ From: 李总                       │
│ Subject: Q4合作提案              │
│                                 │
│ [邮件正文...]                    │
│                                 │
├─────────────────────────────────┤
│ 💡 AI 提醒:                      │
│ • 这封邮件 3 天前你答应"本周回复" │
│ • 你上次和李总讨论此事的邮件:     │
│   [查看相关线程]                 │
│ • 李总的公司近期有 2 封新邮件    │
└─────────────────────────────────┘
```

#### Pattern 3: Smart Notification（智能通知）

不是每封邮件都通知，只有 AI 判断"值得打扰"的才弹通知。

```
┌────────────────────────────┐
│ 📬 Kylins Mail             │
│                            │
│ 李总: "合同已确认，请查收"   │
│ 2分钟前                    │
│                            │
│ [标记已读] [快速回复]       │
└────────────────────────────┘
```

**通知分级：**
- 🔴 Critical: 来自 VIP 联系人 + 内容紧急 → 立即通知
- 🟡 Important: 普通联系人但内容需要回复 → 批量通知（每 30 分钟）
- 🟢 FYI: 订阅、通知、CC → 静默，仅在 Daily Briefing 中显示

#### Pattern 4: Status Bar AI Presence（状态栏 AI 存在）

底部状态栏显示 AI 正在做什么——默默工作，但让用户感知到：

```
[Status Bar]
✅ Connected | 📬 2,345 unread | 🤖 AI: 正在索引 1,234 封新邮件... (45%)
```

索引完成后：
```
🤖 AI: 就绪 — 已理解您的 45,678 封邮件 | 上次 Daily Briefing: 8:00 AM
```

### 4.4 业界 Ambient UI 设计检查清单

在实现前验证：

1. ✅ **痛点明确** — 用户在哪里花时间？什么信息他们需要记住？
2. ✅ **AI 角色清晰** — 是 suggest / explain / create / act？（从 suggest + explain 开始）
3. ✅ **可撤销** — 用户在哪里可以回退每个 AI 操作？
4. ✅ **透明** — 用户能看到 AI 的推理过程吗？
5. ✅ **错误处理** — AI 不确定时怎么做？用户如何修正？
6. ✅ **置信度展示** — 如何视觉区分"AI 很确定" vs "AI 不确定"？
7. ✅ **静默模式** — AI 是否知道何时保持安静？

### 4.5 反模式警示（Clippy 之死）

| 反模式 | 为什么失败 |
|--------|-----------|
| **过度自信** | 不解释为什么，难以关闭（Clippy 的死亡原因） |
| **太多提示** | 到处都是 AI 建议 → 认知过载 |
| **每 session 重置** | AI 不记住偏好和上下文 |
| **外挂式 AI** | AI 感觉像后来硬加上去的 |
| **"Are you sure?"** | 88% 用户见过 AI 犯错误；确认弹窗不提高准确率 |

---

## 五、综合建议：Kylins 的 AI UI 路线图

### Phase 1: Inline AI（现在就能做）

利用现有的 UI 基础设施，添加 AI 增强：

- **ReadingPane** → 邮件顶部显示 AI 摘要卡片（借鉴 Shortwave 的 "2-line summary"）
- **Composer** → 工具栏加 "AI Assist" 按钮（Inline Assistant 模式）
- **Search** → Ctrl+K 打开 Natural Language Command Bar
- **MessageList** → AI 优先级标签（🔴 需回复 / 🟡 重要 / 🟢 普通）

**不需要 Conversational UI 或 Ambient UI 框架。** 这些是组件级别的增强。

### Phase 2: AI Side Panel（4-6 周后）

添加 Context Side Panel：

- 在 ReadingPane 下方添加可折叠的 AI Assistant Panel
- 支持自然语言提问（上下文感知当前邮件/线程）
- 展示 AI 建议的 Actions
- 借鉴 AG-UI 的事件模型，但自建轻量实现

**使用 Vercel AI SDK**（不是 CopilotKit）处理 streaming 和 tool calling。

### Phase 3: Ambient UI（8-12 周后）

- **Daily Briefing** — 用户打开客户端时的第一个视图（或可跳过）
- **Smart Notifications** — VIP 分级 + 紧急检测
- **Proactive Cards** — 在 ReadingPane 和 Composer 中展示上下文建议
- **Status Bar AI** — 显示 AI 索引进度、就绪状态

### 不做的

- ❌ 独立 Chatbot 窗口 — 邮件客户端不需要"另一个聊天窗口"
- ❌ CopilotKit 框架 — 与 Tauri+Rust 架构冲突
- ❌ Agent 自动操作（发送邮件、删除等）— 政府场景不允许，To C 信任门槛太高
- ❌ 全屏 Conversational UI — 替代不了传统三面板布局，作为辅助即可

---

## 六、技术选型更新

基于以上研究，修正之前的技术选型建议：

| 层 | 之前建议 | 修正后建议 | 原因 |
|----|---------|-----------|------|
| **LLM 通信** | Rust async-openai | **Vercel AI SDK (TS)** + Rust Context 组装 | SDK 的 streaming/tool calling/provider 切换最成熟 |
| **Chat UI** | 自建 | 自建（轻量 Context Side Panel） | 不需要 CopilotKit 的重量级框架 |
| **Agent 编排** | Rust 侧 Tool Registry | **Rust 数据处理 + Vercel AI SDK tool() 定义** | Agent loop 在 TS 侧（更灵活），数据操作在 Rust 侧 |
| **Generative UI** | 未考虑 | **Controlled Mode（借鉴 CopilotKit）** | Agent 返回组件名+props，前端映射 |
| **Streaming** | Tauri Event | Vercel AI SDK `streamText` → React | 成熟度最高 |
| **事件协议** | 未定义 | **自建（借鉴 AG-UI 事件模型）** | 轻量且标准兼容 |
| **RAG** | LanceDB + fastembed-rs | **同前** + 借鉴 Shortwave 的 5 阶段流水线 | Hybrid Retrieval 是最佳实践 |
| **记忆系统** | 5 层模型 | **简化 3 层（Semantic Index + Knowledge Graph + User Model）** | 邮件本身就是 Episodic Memory |

---

## 参考文献

- [Shortwave AI Deep Dive](https://www.shortwave.com/blog/deep-dive-into-worlds-smartest-email-ai/)
- [Superhuman AI Search Architecture](https://www.langchain.com/breakoutagents/superhuman)
- [CopilotKit GitHub](https://github.com/copilotkit/copilotkit)
- [AG-UI Protocol Overview](https://docs.copilotkit.ai/langgraph-fastapi/ag-ui)
- [Atomic Mail — JMAP-based Agent Email](https://martechseries.com/content/email-mktg/atomic-mail-builds-agent-email-on-open-jmap-standard/)
- [Coremail AI-Native Secure Email](https://www.tmcnet.com/usubmit/-coremail-launches-ai-native-secure-email-system-the-/2026/05/10/10379865.htm)
- [Ambient Intelligence Design Patterns](https://www.aiuxdesign.guide/patterns/ambient-intelligence)
- [AI UX in 2025: Proactive AI Agents Design Principles](https://www.mixflow.ai/blog/ai-ux-in-2025-uiux-design-principles-for-proactive-ai-agents)
- [Canary Mail — Local AI vs Cloud AI](https://canarymail.io/blog/local-ai-vs-cloud-ai-in-email)
- [Vercel AI SDK vs CopilotKit Comparison](https://www.cnblogs.com/OfoxAI/p/20361282)

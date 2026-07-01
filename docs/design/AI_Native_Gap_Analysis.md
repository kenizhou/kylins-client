# Kylins AI Native Gap Analysis & Architecture Proposal

> 基于 AI_Native_design.md 对现有 codebase 的全面评估
> 评估日期: 2026-06-30

---

## 一、现有 Codebase 与 AI Native 的差距

### 1.1 分层差距总览

AI_Native_design.md 定义了 5 层 AI Native 架构。以下是各层现状：

| 架构层 | AI Native 要求 | 现有状态 | 差距等级 |
|--------|---------------|---------|---------|
| **Interaction Layer** | Traditional UI + Conversational UI + Ambient UI 三种范式共存 | 仅有 Traditional UI (AppShell, MessageList, ReadingPane, Composer) | 🔴 严重缺失 |
| **Agent / Orchestration Layer** | Intent Router, Tool Use, Multi-step Workflows | 完全不存在 | 🔴 完全缺失 |
| **Semantic Layer** ★核心★ | Entity Graph + Vector Index + Memory (Working/Episodic/Semantic/Procedural) | 完全不存在 — 无向量存储、无实体图、无记忆系统、无 embedding 管线 | 🔴 完全缺失 |
| **AI Service Layer** | LLM Router (L1/L2/L3 分层), Embedding Service, Streaming, Prompt Management | 仅有前端 stub (`aiService.ts` + 两个返回空字符串的 provider)，无 LLM 路由、无本地模型、无 embedding、无 streaming | 🔴 严重缺失 |
| **Mail Engine** | Sync Engine + Protocol Adapter + Local Store (local-first) | ✅ 已完整实现 — `MailSource` trait, IMAP/EAS provider, FTS5 搜索, offline queue, SQLite 存储 | 🟢 已就绪 |
| **Account / Identity** | OAuth, multi-account, OAuth2, IMAP/SMTP/EWS/Graph | ✅ 已实现 — OAuth flow, multi-account, IMAP/SMTP/EAS | 🟢 已就绪 |

### 1.2 关键差距详解

#### 差距 1: 语义层完全缺失 — 这是 AI Native 的灵魂

AI_Native_design.md 明确指出：
> "传统客户端的核心数据结构是邮件，AI Native 的核心数据结构是知识图谱 + 向量空间"

当前 codebase 的数据结构完全是"邮件中心"的：
- `messages` 表存储邮件原始数据
- `threads` 表存储会话聚合
- `contacts` 表存储联系人
- 没有任何实体提取、关系建模、语义向量化

**需要新建的能力：**

| 能力 | 当前状态 | 目标状态 | 实现方式 |
|------|---------|---------|---------|
| Entity Extraction | ❌ | 每封邮件进入时自动提取 People/Orgs/Projects/Commitments/Topics | LLM 异步提取 → 写入实体表 |
| Entity Graph | ❌ | 人-组织-项目-承诺之间的关系图，支持图查询 | CozoDB 或 KuzuDB |
| Vector Index | ❌ | 邮件/附件 → chunk → embedding → 向量库，支持语义搜索 | LanceDB + fastembed-rs |
| Working Memory | ❌ | 当前会话上下文，moka 内存缓存 | moka cache |
| Episodic Memory | ❌ | 邮件事件流 + 用户行为事件，时间线索引 | SQLite 扩展 |
| Semantic Memory | ❌ | 邮件/片段/摘要的向量化存储，Hybrid Retrieval | LanceDB |
| Procedural Memory | ❌ | 用户偏好、写作风格、行为模式、自定义规则 | SQLite JSONB |

#### 差距 2: AI 能力层是前端 stub，不是 Rust 原生

AI_Native_design.md 推荐的 AI 层在 Rust 侧实现：
- `async-openai` + 自建路由层
- Ollama HTTP API / mistral.rs 本地模型
- `fastembed-rs` 本地 embedding
- `tiktoken-rs` token 计数

**当前状态：**
- AI 逻辑全在前端 TypeScript (`services/ai/`)
- 两个 provider (OpenAI, Ollama) 都是 stub，返回空字符串
- 没有 Rust 侧的 AI 处理能力
- 没有 LLM 路由/分层机制
- 没有 streaming 支持
- 没有 token budget 管理

**为什么不应该是纯前端：**
1. 隐私 — 邮件数据不应经过前端 JS 再到云端，Rust 侧可以做到"本地预处理 → 最小化数据上云"
2. 性能 — embedding 生成、文档解析在 Rust 侧效率更高
3. 离线 — 本地小模型推理必须在 Rust/Native 侧
4. 安全 — 加密邮件解密后直接在 Rust 侧交给 AI，明文不经过前端 JS

#### 差距 3: 交互层缺失对话式和环境式 UI

AI_Native_design.md 定义了三种 UI 范式：
1. **Traditional UI** — 邮件列表、阅读窗格 ✅ 已实现
2. **Conversational UI** — 常驻对话框，自然语言操作邮件 ❌ 不存在
3. **Ambient UI** — Daily Briefing、智能通知卡片、主动建议 ❌ 不存在

#### 差距 4: Agent 层不存在

Tool Use 机制不存在 — LLM 无法调用客户端功能：
- `search_emails(query)` ❌
- `compose_email(to, subject, body)` ❌
- `get_thread_context(thread_id)` ❌
- `find_person(name)` ❌

---

## 二、技术栈 Match/Mismatch 分析

### 2.1 已匹配的技术选型

| 维度 | AI_Native_design.md 推荐 | Kylins 现有 | 匹配度 |
|------|--------------------------|-------------|--------|
| 桌面框架 | **Tauri 2.x** | Tauri 2.10 | ✅ 完全匹配 |
| 前端框架 | **React 18 + TypeScript** | React 19 + TypeScript 5.9 | ✅ 完全匹配 |
| 状态管理 | **Zustand** | Zustand 5 | ✅ 完全匹配 |
| 富文本编辑器 | **Tiptap** | Tiptap 3.27 | ✅ 完全匹配 |
| 样式 | **Tailwind CSS** | Tailwind CSS 4 | ✅ 完全匹配 |
| 异步运行时 | **Tokio** | Tokio | ✅ 完全匹配 |
| IMAP | **async-imap** | async-imap | ✅ 完全匹配 |
| SMTP | **lettre** | lettre | ✅ 完全匹配 |
| MIME 解析 | **mail-parser** (Stalwart) | mail-parser | ✅ 完全匹配 |
| OAuth2 | **oauth2** crate | 自建 oauth.rs | ⚠️ 功能等价 |
| 序列化 | **serde + serde_json** | serde + serde_json | ✅ 完全匹配 |
| 错误处理 | **thiserror + anyhow** | thiserror | ⚠️ 缺少 anyhow |
| 加密 | **ring / rustls** | aes-gcm + native-tls | ⚠️ 不同但够用 |

### 2.2 不匹配的技术选型

| 维度 | AI_Native_design.md 推荐 | Kylins 现有 | 差异分析 | 影响等级 |
|------|--------------------------|-------------|---------|---------|
| **UI 组件库** | shadcn/ui + Radix UI | React Aria Components | 两者都是 headless/unstyled 方案，React Aria 更偏无障碍，Radix 更偏组合。**不需要切换** — React Aria 在 Outlook-style 桌面应用中表现更好 | 🟡 低 |
| **路由** | TanStack Router | TanStack Router | 已匹配 | 🟢 无 |
| **异步数据** | TanStack Query | 无 | **应该添加** — 管理服务端状态、缓存、重试 | 🟡 中 |
| **全文搜索** | **Tantivy** (Rust) | SQLite FTS5 | FTS5 够用但功能有限。Tantivy 支持模糊搜索、Faceted search、自定义评分，更适合语义+全文混合搜索。**后期迁移** | 🟡 中 |
| **向量存储** | **LanceDB** | ❌ 不存在 | **核心缺失** — 没有向量存储就无法做语义搜索和 RAG | 🔴 高 |
| **图存储** | **CozoDB / KuzuDB** | ❌ 不存在 | **核心缺失** — 没有图数据库就无法做 Entity Graph | 🔴 高 |
| **LLM 统一接入** | async-openai + 自建路由层 | ❌ 不存在 (前端 stub) | **核心缺失** | 🔴 高 |
| **本地模型运行时** | Ollama HTTP API | ❌ 不存在 (前端 stub) | **核心缺失** | 🔴 高 |
| **嵌入模型** | fastembed-rs (Rust 原生) | ❌ 不存在 | **核心缺失** | 🔴 高 |
| **Prompt 管理** | minijinja 模板引擎 | ❌ 不存在 | 需要添加 | 🟡 中 |
| **Token 计数** | tiktoken-rs | ❌ 不存在 | 需要添加 | 🟡 中 |
| **文档解析** | pdf-extract + docx-rs + calamine | ❌ 不存在 | 附件 AI 理解需要 | 🟡 中 |
| **HTML 清洗** | ammonia + html2text | DOMPurify (前端) | 前端已有 DOMPurify，Rust 侧需要 ammonia 用于 AI 处理前清洗 | 🟡 中 |
| **日志** | tracing + tracing-subscriber | log (Tauri plugin) | tracing 是结构化日志的事实标准，建议切换 | 🟡 低 |
| **缓存** | moka | ❌ 不存在 | Working Memory 需要内存缓存 | 🟡 中 |
| **图数据库** | CozoDB | ❌ 不存在 | Entity Graph 核心依赖 | 🔴 高 |

### 2.3 架构模式差异

| 方面 | AI_Native_design.md 推荐 | Kylins 现状 |
|------|--------------------------|-------------|
| **AI 执行位置** | Rust 后端为主 + 前端 UI | 仅前端 (且为 stub) |
| **数据处理模型** | 邮件 → Entity + Vector + Memory | 邮件 → SQLite 关系表 |
| **搜索模式** | Hybrid (全文 + 语义 + 图遍历) | 全文 only (FTS5) |
| **Provider 模式** | 统一 MailProvider trait (Rust) | 前端 EmailProvider interface (TS) + Rust MailSource trait |
| **同步策略** | local-first | local-first (已实现) |

---

## 三、目标系统架构设计

基于 AI_Native_design.md 的蓝图，结合 Kylins 现有架构，以下是具体可落地的系统架构。

### 3.1 总体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Interaction Layer 交互层                          │
│  ┌──────────────────┐ ┌──────────────────┐ ┌─────────────────────┐ │
│  │ Traditional UI   │ │ Conversational UI│ │ Ambient UI          │ │
│  │ (现有，增强)      │ │ (NEW)            │ │ (NEW)               │ │
│  │ AppShell          │ │ AI Chat Panel    │ │ Daily Briefing       │ │
│  │ MessageList       │ │ Inline AI Cmd    │ │ Smart Notifications  │ │
│  │ ReadingPane       │ │ Natural Lang Qry │ │ Proactive Cards      │ │
│  │ Composer (+AI)    │ │                  │ │                      │ │
│  └──────────────────┘ └──────────────────┘ └─────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│                    Tauri IPC Bridge                                  │
│  Commands: search_emails | ask_assistant | get_briefing             │
│  Events:  email:new | sync:progress | ai:streaming | memory:updated │
├─────────────────────────────────────────────────────────────────────┤
│                    Rust Backend                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Agent / Orchestration Layer (NEW)                │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │   │
│  │  │ Intent Router│ │ Tool Registry│ │ Workflow Engine      │ │   │
│  │  │ classify→    │ │ search_emails│ │ multi-step planning  │ │   │
│  │  │ route→execute│ │ compose_email│ │ execute→feedback loop│ │   │
│  │  └──────────────┘ └──────────────┘ └──────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Semantic Layer (NEW) ★核心★                      │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │   │
│  │  │ Entity Graph │ │ Vector Index │ │ Memory System         │ │   │
│  │  │ CozoDB       │ │ LanceDB      │ │ Working | Episodic    │ │   │
│  │  │ Person/Org   │ │ emails/docs  │ │ Semantic | Procedural │ │   │
│  │  │ Project/Comm │ │ chunks       │ │ Memory Orchestrator   │ │   │
│  │  └──────────────┘ └──────────────┘ └──────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              AI Service Layer (NEW)                           │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │   │
│  │  │ LLM Router   │ │ Embedding Svc│ │ Prompt Manager        │ │   │
│  │  │ L1: Ollama   │ │ fastembed-rs │ │ minijinja templates   │ │   │
│  │  │ L2: Haiku    │ │ or OpenAI    │ │ versioned + testable  │ │   │
│  │  │ L3: Sonnet   │ │              │ │                      │ │   │
│  │  └──────────────┘ └──────────────┘ └──────────────────────┘ │   │
│  │  + Document Parser (pdf-extract, docx-rs, calamine)          │   │
│  │  + HTML Cleaner (ammonia, html2text)                         │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Mail Engine (现有，增强)                          │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │   │
│  │  │ Sync Engine  │ │ Provider Mgr │ │ Post-Sync Pipeline    │ │   │
│  │  │ (现有)       │ │ (现有)       │ │ (NEW) FTS→Embed→     │ │   │
│  │  │              │ │              │ │ Entity Extraction→    │ │   │
│  │  │              │ │              │ │ AI Enrichment         │ │   │
│  │  └──────────────┘ └──────────────┘ └──────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Storage Layer (扩展)                              │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │   │
│  │  │ SQLite+Cipher│ │ LanceDB      │ │ CozoDB               │ │   │
│  │  │ (现有, 主库) │ │ (NEW, 向量)  │ │ (NEW, 实体图)        │ │   │
│  │  └──────────────┘ └──────────────┘ └──────────────────────┘ │   │
│  │  ┌──────────────┐ ┌──────────────────────────────────────┐   │   │
│  │  │ moka Cache   │ │ Encrypted File Store (附件加密)      │   │   │
│  │  │ (NEW, 内存)  │ │ (NEW, age 加密)                      │   │   │
│  │  └──────────────┘ └──────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Crypto Layer (NEW — 邮件加密)                     │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │   │
│  │  │ CryptoProvider│ │ S/MIME      │ │ PGP (Phase 2)        │ │   │
│  │  │ trait (抽象) │ │ CMS + PKCS11│ │ rpgp                  │ │   │
│  │  └──────────────┘ └──────────────┘ └──────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│                    Account / Identity (现有，增强)                    │
│  OAuth (Gmail/Outlook) · IMAP/SMTP · EAS · Coremail                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Semantic Layer 详细设计

这是整个架构的灵魂，单独展开：

```
                          Memory Orchestrator
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
   Memory Input          Memory Router          Memory Output
   ┌──────────┐         ┌──────────┐          ┌──────────────┐
   │新邮件到达│         │路由到正确 │          │LLM Context   │
   │用户操作  │────────▶│的 Memory  │─────────▶│搜索建议      │
   │用户对话  │         │Store     │          │Daily Briefing│
   │AI 分析   │         └──────────┘          │主动提醒      │
   └──────────┘                               └──────────────┘
```

#### 记忆系统五层模型

```
Layer 0: Working Memory (工作记忆 — 秒/分钟级)
  └── moka 内存缓存
  └── 当前会话上下文、活跃线程、最近的 LLM 交互
  └── TTL: 30min idle

Layer 1: Episodic Memory (情景记忆 — 事件级)
  └── SQLite 扩展表
  └── 表: memory_events (event_type, entity_id, timestamp, payload_json)
  └── 邮件到达事件、用户操作事件、AI 分析事件
  └── 永久保留，时间线索引

Layer 2: Semantic Memory (语义记忆 — 向量级)
  └── LanceDB
  └── 表: email_vectors, chunk_vectors, summary_vectors
  └── 每封邮件生成 3 级 embedding:
  │   ├── email-level (整封邮件，用于相似邮件推荐)
  │   ├── chunk-level (段落级，用于精确 RAG)
  │   └── summary-level (AI 摘要，用于快速语义匹配)
  └── 模型: fastembed-rs (BGE-small) 本地 / text-embedding-3-small 云端

Layer 3: Entity Graph (实体图 — 结构化关系)
  └── CozoDB
  └── 节点类型: Person, Organization, Project, Commitment, Topic, Email
  └── 边类型: works_at, involved_in, mentioned_in, related_to, has_commitment
  └── 所有实体关联回源邮件 ID → 可溯源

Layer 4: Procedural Memory (程序记忆 — 规则/偏好)
  └── SQLite JSONB 表
  └── 用户偏好: 语气、回复时间习惯、语言偏好
  └── 行为模式: 常用收件人、常用标签、归档习惯
  └── 自定义规则: "标记为重要的条件"、"自动归档的规则"
```

#### Hybrid Retrieval 流程

当用户问 "Q4 项目的进展如何"：

```
1. Query → Embedding (fastembed-rs / OpenAI)
2. 语义搜索 LanceDB → top-50 相关 chunks
3. Query → Entity Extraction (LLM L2) → "Q4项目" 实体
4. CozoDB 图查询 → 关联的人、子项目、承诺
5. Episodic Memory 时间过滤 → 最近 30 天的事件
6. Procedural Memory → 用户偏好 (关注什么维度)
7. Cross-encoder Rerank → 精排 top-10
8. 组装 LLM Context → 注意 token budget → 返回答案
```

### 3.3 AI Service Layer 详细设计

#### LLM Router (三层模型架构)

```rust
enum ModelTier {
    L1,  // 本地小模型 — 实时、简单、隐私敏感
    L2,  // 云端中等模型 — 常规、中等复杂度
    L3,  // 云端旗舰模型 — 复杂推理、Agent 多步
}

enum TaskType {
    // L1 任务 (本地)
    SensitivityCheck,     // 敏感信息检测
    Classification,       // 邮件分类
    SimpleExtraction,     // 简单实体提取 (日期、金额等)

    // L2 任务 (云端中等)
    EntityExtraction,     // 完整实体提取 (Person/Org/Commitment)
    Summary,              // 邮件摘要
    DraftGeneration,      // 回复草稿
    Translation,          // 翻译

    // L3 任务 (云端旗舰)
    AgentMultiStep,       // Agent 多步操作
    DailyBriefing,        // Daily Briefing 生成
    ComplexReasoning,     // 复杂推理分析
}

struct LlmRouter {
    local_model: LocalModelConfig,     // Ollama endpoint
    mid_tier: CloudModelConfig,        // GPT-4o-mini / Claude Haiku / Gemini Flash
    top_tier: CloudModelConfig,        // GPT-4o / Claude Sonnet / Gemini Pro
    fallback_chain: Vec<ModelTier>,    // 降级链: L3→L2→L1
    privacy_mode: PrivacyMode,         // LocalOnly / Balanced / Performance
}

impl LlmRouter {
    fn route(&self, task: TaskType, ctx: &Context) -> ModelChoice {
        if self.privacy_mode == PrivacyMode::LocalOnly {
            return ModelChoice::Local(self.local_model.clone());
        }
        match task {
            // 隐私敏感 → 永远本地
            TaskType::SensitivityCheck |
            TaskType::Classification |
            TaskType::SimpleExtraction => ModelChoice::Local(self.local_model.clone()),

            // 常规 → 中等模型
            TaskType::EntityExtraction |
            TaskType::Summary |
            TaskType::DraftGeneration |
            TaskType::Translation => ModelChoice::Cloud(self.mid_tier.clone()),

            // 复杂 → 旗舰模型
            TaskType::AgentMultiStep |
            TaskType::DailyBriefing |
            TaskType::ComplexReasoning => ModelChoice::Cloud(self.top_tier.clone()),
        }
    }
}
```

#### 关键约束

- **每个 LLM 调用必须有**: timeout (30s), 重试 (指数退避), fallback (降级到本地模型), 用户可见的错误处理
- **Streaming 必须**: 通过 Tauri Event `ai:streaming` 推送前端实时渲染
- **Token Budget**: 用 `tiktoken-rs` 计数，超出时触发 memory compression (LLM 压缩旧内容)
- **Backpressure**: 新邮件到达触发 AI pipeline，用 `tokio::sync::Semaphore` 限制并发

### 3.4 Agent / Tool Use Layer

```rust
// Tool 定义
#[async_trait]
trait AgentTool: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn parameters(&self) -> serde_json::Value;  // JSON Schema
    async fn execute(&self, args: serde_json::Value) -> Result<ToolResult>;
}

// 内置 Tools
struct SearchEmailsTool { /* 搜索邮件 */ }
struct ComposeEmailTool { /* 撰写邮件 */ }
struct GetThreadContextTool { /* 获取邮件线程上下文 */ }
struct FindPersonTool { /* 查找联系人 */ }
struct ScheduleFollowupTool { /* 安排跟进 */ }
struct SummarizeThreadTool { /* 总结线程 */ }

// Agent 执行
struct AgentExecutor {
    tools: HashMap<String, Box<dyn AgentTool>>,
    llm: Arc<LlmRouter>,
    max_steps: usize,  // 防止无限循环
}

impl AgentExecutor {
    async fn execute(&self, user_intent: &str, context: AgentContext)
        -> Result<AgentResult>
    {
        let mut steps = 0;
        let mut messages = vec![system_prompt(&self.tools), user_message(user_intent)];

        while steps < self.max_steps {
            let response = self.llm.chat(&messages, ModelTier::L3).await?;
            match response {
                LlmResponse::FinalAnswer(text) => return Ok(AgentResult { text, steps }),
                LlmResponse::ToolCall { name, args } => {
                    let tool = self.tools.get(&name).ok_or(...)?;
                    let result = tool.execute(args).await?;
                    messages.push(tool_result_message(name, result));
                    steps += 1;
                }
            }
        }
        Err(AgentError::MaxStepsExceeded)
    }
}
```

### 3.5 与加密架构的集成

加密架构与 AI Native 架构的关键集成点：

```
┌─────────────────────────────────────────────────────┐
│ 加密介入点                                           │
│                                                     │
│ 发送路径:                                            │
│   Composer → buildRawEmail()                        │
│     → [AI 敏感信息检测] ← L1 本地模型                │
│     → [AI 密级建议] ← L1 本地模型                    │
│     → crypto_sign() → crypto_encrypt()              │
│     → SMTP 发送                                     │
│                                                     │
│ 接收路径:                                            │
│   IMAP 拉取 → 检测加密类型                           │
│     → crypto_decrypt() → crypto_verify()            │
│     → [解密后 AI 处理] ← 明文仅在 Rust 侧处理       │
│       ├── Entity Extraction (入 Entity Graph)       │
│       ├── Embedding Generation (入 LanceDB)         │
│       ├── Classification & Summarization            │
│       └── Commitment/Task Extraction                │
│     → 渲染到 SafeHtmlFrame                          │
│                                                     │
│ 关键安全原则:                                        │
│   1. AI 处理解密后的明文在 Rust 侧完成               │
│   2. 明文不经过 Tauri IPC (不在 invoke() payload 中)│
│   3. AI 提取的实体/向量不包含原始明文                │
│   4. 加密邮件在 AI pipeline 中的处理可独立关闭       │
│   5. Memory System 不存储解密后的原始邮件内容        │
└─────────────────────────────────────────────────────┘
```

---

## 四、实施路线图

### Phase 0: 基础设施 (4-6 周)
**目标**: 搭建 AI Native 所需的基础存储和计算能力

- [ ] 添加 Rust 依赖: `async-openai`, `fastembed-rs`, `tiktoken-rs`, `minijinja`, `ammonia`, `moka`
- [ ] 集成 LanceDB (嵌入式向量数据库)
- [ ] 集成 CozoDB (嵌入式图数据库)
- [ ] 实现 Embedding Service (`fastembed-rs` BGE-small 本地 + OpenAI 云端)
- [ ] 实现 LLM Router (L1/L2/L3 分层 + fallback)
- [ ] 实现 Prompt Manager (minijinja 模板 + 版本管理)
- [ ] 添加 `tracing` 替代 `log`

### Phase 1: AI Pipeline 基础 (4-6 周)
**目标**: 每封邮件进入系统时自动被 AI 理解和索引

- [ ] Post-Sync Pipeline: 新邮件 → MIME Parse → HTML Clean → Embedding → Entity Extraction → AI Enrichment
- [ ] Entity Extraction: 从邮件自动提取 People/Orgs/Projects/Commitments/Topics
- [ ] Entity Graph: CozoDB schema + 写入 + 查询 API
- [ ] Semantic Memory: LanceDB 邮件/片段向量化 + 语义搜索
- [ ] Episodic Memory: 事件流表 + 时间线查询
- [ ] AI 能力的前端 Tauri Commands (search_semantic, ask_assistant, get_entity_info)

### Phase 2: 交互层升级 (4-6 周)
**目标**: 用户能通过自然语言和 AI 与邮件交互

- [ ] Conversational UI: AI Chat Panel (常驻侧边栏/弹出)
- [ ] Natural Language Search: "上个月和ABC公司关于Q4预算的邮件"
- [ ] AI Compose: 基于上下文生成邮件草稿
- [ ] Smart Reply: 内联建议回复 (像 Gmail Smart Reply)
- [ ] Agent Tool Use: 第一批 Tools (search, compose, summarize)
- [ ] Streaming 支持: Tauri Event `ai:streaming` → 前端实时渲染

### Phase 3: Memory & Ambient (4-6 周)
**目标**: AI 从"被调用"升级为"主动服务"

- [ ] Procedural Memory: 用户偏好学习 + 行为模式识别
- [ ] Memory Compression: 长期记忆压缩策略
- [ ] Hybrid Retrieval: 语义 + 图 + 时间 + 偏好 混合召回
- [ ] Daily Briefing: 每天早上 AI 生成的多模态简报
- [ ] Proactive Suggestions: AI 主动提醒未回复邮件、过期承诺
- [ ] Working Memory: moka 缓存 + 会话上下文管理

### Phase 4: Agent & 加密集成 (4-6 周)
**目标**: Agent 能力和端到端加密并存

- [ ] Multi-step Agent: 规划+执行+反馈循环
- [ ] S/MIME 加密集成 (Phase 1 of crypto system design)
- [ ] 加密邮件与 AI 的安全集成 (明文保护边界)
- [ ] Privacy Mode: LocalOnly / Balanced / Performance 三级
- [ ] AI 缓存过期策略优化
- [ ] 性能优化: 后台 backpressure、并发控制、token budget 管理

---

## 五、新 Crate 结构

```
kylins.client.backend/
├── Cargo.toml          # 新增 ~15 个依赖
├── migrations/
│   └── 20260630000001_ai_native.sql  # NEW: 记忆系统表
└── src/
    ├── ai/                          # NEW — AI 能力层
    │   ├── mod.rs
    │   ├── router.rs                # LLM Router (L1/L2/L3)
    │   ├── embedding.rs             # Embedding Service
    │   ├── prompt_manager.rs        # minijinja 模板管理
    │   ├── document_parser.rs       # PDF/Word/Excel 解析
    │   ├── html_cleaner.rs          # ammonia + html2text
    │   └── providers/
    │       ├── mod.rs               # AIProvider trait
    │       ├── openai.rs            # async-openai
    │       ├── anthropic.rs         # Anthropic API
    │       ├── ollama.rs            # Ollama HTTP API
    │       └── gemini.rs            # Google Gemini
    │
    ├── memory/                      # NEW — 记忆系统
    │   ├── mod.rs
    │   ├── orchestrator.rs          # Memory Orchestrator
    │   ├── working.rs               # Working Memory (moka)
    │   ├── episodic.rs              # Episodic Memory (SQLite)
    │   ├── semantic.rs              # Semantic Memory (LanceDB)
    │   ├── entity_graph.rs          # Entity Graph (CozoDB)
    │   ├── procedural.rs            # Procedural Memory (SQLite JSONB)
    │   ├── retrieval.rs             # Hybrid Retrieval
    │   └── compression.rs           # Memory Compression
    │
    ├── agent/                       # NEW — Agent 层
    │   ├── mod.rs
    │   ├── executor.rs              # Agent Executor (tool use loop)
    │   ├── tool_registry.rs         # Tool 注册表
    │   └── tools/
    │       ├── mod.rs               # AgentTool trait
    │       ├── search_emails.rs
    │       ├── compose_email.rs
    │       ├── get_thread.rs
    │       ├── find_person.rs
    │       ├── schedule_followup.rs
    │       └── summarize.rs
    │
    ├── pipeline/                    # NEW — 后处理管线
    │   ├── mod.rs
    │   ├── post_sync.rs             # 新邮件 → AI 处理
    │   └── backpressure.rs          # 并发控制
    │
    ├── crypto/                      # NEW (Phase 4) — 邮件加密
    │   ├── mod.rs
    │   ├── provider.rs              # CryptoProvider trait
    │   ├── encryptor.rs
    │   ├── decryptor.rs
    │   ├── signer.rs
    │   ├── verifier.rs
    │   ├── types.rs
    │   ├── key_store.rs
    │   ├── smime/                   # S/MIME (Phase 1)
    │   ├── pgp/                     # PGP (Phase 2)
    │   └── sm/                      # 国密 (Phase 3)
    │
    └── commands/
        ├── ai_commands.rs           # NEW — AI IPC 命令
        ├── memory_commands.rs       # NEW — Memory IPC 命令
        ├── agent_commands.rs        # NEW — Agent IPC 命令
        └── crypto_commands.rs       # NEW (Phase 4) — Crypto IPC 命令
```

---

## 六、关键风险与缓解

| 风险 | 影响 | 概率 | 缓解 |
|------|------|------|------|
| LanceDB/CozoDB 与 Tauri 交叉编译困难 | 高 | 中 | 先在 pure Rust 验证，LanceDB 有 Rust 原生 binding；CozoDB 也是 Rust 原生 |
| LLM API 成本爆炸 (大量邮件 × 每封调用) | 高 | 高 | L1 本地模型预处理 → 过滤 → 仅关键邮件上云；AI cache 复用 |
| 初次同步触发海量 AI 处理 | 中 | 高 | Semaphore 并发限制 + 分批 + 低优先级后台处理 |
| 加密明文与 AI 处理的隐私冲突 | 高 | 中 | Privacy Mode 分级；Rust 侧明文处理后即丢弃；Memory 不存原文 |
| 记忆系统复杂度失控 | 中 | 中 | MVP 用 SQLite 做 Entity Graph (不用 CozoDB)，后期再迁 |
| Agent 自动操作发错邮件 | 高 | 低 | MVP 不做自动发送；Agent 操作始终需要用户确认 |
| 搜索 "Q4 项目" → 扫描 10 万封邮件 → 性能崩溃 | 中 | 中 | Hybrid Retrieval 先用向量过滤 → 小结果集 → 精排 |

---

## 七、总结

### 现有 codebase 的优势 (可以在此基础上构建)
1. ✅ **Mail Engine** — 已经是一个成熟的 local-first 同步引擎，AI pipeline 可以直接挂载
2. ✅ **Tauri 2.x** — 桌面框架正确，Rust 原生能力可充分利用
3. ✅ **SQLite 基础设施** — 37 张表、FTS5、迁移系统都就绪
4. ✅ **Plugin 系统** — 已支持 slot-based UI 注入，加密和 AI UI 可以通过 plugin 扩展
5. ✅ **数据库 Schema** — 已有 `ai_cache`, `thread_categories`, `writing_style_profiles`, `classification_id` 等 AI 预留字段

### 需要新建的核心能力 (按优先级)
1. 🔴 **Embedding Service** (fastembed-rs + LanceDB) — 语义搜索和 RAG 的前提
2. 🔴 **LLM Router** (async-openai + Ollama) — 替代前端 stub
3. 🔴 **Entity Extraction Pipeline** — 从邮件提取结构化知识
4. 🔴 **Hybrid Retrieval** — 语义 + 全文 + 图的混合搜索
5. 🟡 **Agent Tool Use** — LLM 调用客户端功能
6. 🟡 **Memory System** — Working/Episodic/Semantic/Procedural
7. 🟡 **Conversational UI + Daily Briefing** — 新交互范式
8. 🟢 **CryptoProvider trait + S/MIME** — 邮件加密 (已有完整设计)

### 最关键的技术决策
1. **AI 处理必须在 Rust 侧** — 隐私、性能、离线能力的硬要求
2. **先从 Embedding + Entity Extraction 开始** — 这是 AI Native 的数据基础
3. **MVP 不要碰 Agent 自动操作** — 信任门槛太高，先从"AI 辅助决策"开始
4. **Privacy Mode 是架构级概念** — 从第一天就要贯穿整个系统

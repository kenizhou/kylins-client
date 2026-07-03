# Memory System Design — 务实方案

> 回应 AI_Native_design.md 的记忆系统建议 + Rust AI 生态评估 + 前后端分工
> 日期: 2026-06-30

---

## 一、记忆系统：从 5 层减到 3 层

### 为什么 AI_Native_design.md 的 5 层模型过度设计

AI_Native_design.md 提出的模型：
```
Working Memory → Episodic Memory → Semantic Memory → Entity Graph → Procedural Memory
```

这个模型借鉴了认知科学，带来了三个问题：

**1. Episodic Memory 是多余的。** 邮件客户端不需要单独的事件流存储——`messages` 表 + `threads` 表本身就是完整的 Episodic Memory。每封邮件自带时间戳、参与者、内容。再建一个 `memory_events` 表只是把同样的信息存了两遍。

**2. Working Memory 不需要持久化框架。** 用户的"当前上下文"就是：正在看的线程 + 最近的搜索 + 活跃的 compose 会话。这些是 UI 状态，应该由 Zustand 管理，不需要 moka cache。

**3. Procedural Memory 早期不需要专门建模。** "用户偏好什么语气"、"习惯什么时候回邮件"这些信息在前 6 个月的用户量下，直接塞进 LLM system prompt 就够用了，不需要专门的数据库表和学习算法。

### 务实的三层记忆模型

```
┌─────────────────────────────────────────────────────┐
│ Layer 1: 语义索引 (Semantic Index)                    │
│ 核心能力: 找到"语义上相关"的邮件                       │
│ 存储: LanceDB (向量)                                  │
│ 内容: 邮件的 embedding + 附件片段的 embedding          │
│ 这是最有价值的层 — 让用户能"搜索概念"而不只是关键词     │
├─────────────────────────────────────────────────────┤
│ Layer 2: 知识图谱 (Knowledge Graph)                   │
│ 核心能力: 理解"谁是谁、在做什么、答应了什么"           │
│ 存储: SQLite (先用关系表，后期再考虑图数据库)          │
│ 内容: 人物/组织/项目/承诺 及其关系                     │
│ 这是差异化的层 — 让 AI 能回答跨邮件的上下文问题         │
├─────────────────────────────────────────────────────┤
│ Layer 3: 用户模型 (User Model)                        │
│ 核心能力: 记住用户的偏好和习惯                         │
│ 存储: SQLite settings 表 (已有的 settings 基础设施)    │
│ 内容: 语气偏好、语言偏好、常用联系人、归档习惯         │
│ 这是锦上添花的层 — 让 AI 输出更个性化                  │
└─────────────────────────────────────────────────────┘
```

### 为什么不推荐 CozoDB

AI_Native_design.md 建议用 CozoDB 做 Entity Graph。我的判断是**先用 SQLite，后期再评估是否需要迁移**：

1. **邮件规模下的图查询不需要专用图数据库。** 一个重度用户 10 年邮件可能有 50 万封。从中提取的实体数量在几千到几万级别。SQLite 用 recursive CTE 处理这个量级的图遍历足够快（< 10ms）。

2. **减少编译复杂度。** CozoDB 是一个 Rust 库但依赖较重。每多一个 native dependency，Tauri 交叉编译（特别是 Windows + ARM64 macOS）就多一个可能的失败点。

3. **简化运维。** 只有一个数据库文件（SQLite）比"SQLite + LanceDB + CozoDB"三个存储引擎容易备份、迁移和调试得多。

**实体图的 SQLite 实现：**

```sql
-- 实体表 (节点)
CREATE TABLE knowledge_entities (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,  -- 'person', 'organization', 'project', 'commitment', 'topic'
    name TEXT NOT NULL,
    email TEXT,                -- for person entities
    domain TEXT,               -- for organization entities
    summary TEXT,              -- LLM 生成的实体摘要
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    mention_count INTEGER DEFAULT 0,
    metadata_json TEXT         -- 灵活的扩展字段
);

-- 关系表 (边)
CREATE TABLE knowledge_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id TEXT NOT NULL,      -- 主体实体
    relation_type TEXT NOT NULL,   -- 'works_at', 'involved_in', 'mentioned_in', 'committed_to'
    object_id TEXT NOT NULL,       -- 客体实体
    source_email_id TEXT NOT NULL, -- ★ 溯源到原始邮件
    confidence REAL DEFAULT 1.0,   -- 提取置信度
    created_at INTEGER NOT NULL,
    FOREIGN KEY (subject_id) REFERENCES knowledge_entities(id),
    FOREIGN KEY (object_id) REFERENCES knowledge_entities(id),
    FOREIGN KEY (source_email_id) REFERENCES messages(id)
);

-- 邮件-实体关联表 (邮件包含哪些实体)
CREATE TABLE email_entities (
    email_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    relevance REAL DEFAULT 1.0,  -- 该实体在这封邮件中的重要程度
    PRIMARY KEY (email_id, entity_id),
    FOREIGN KEY (email_id) REFERENCES messages(id),
    FOREIGN KEY (entity_id) REFERENCES knowledge_entities(id)
);

CREATE INDEX idx_ke_type ON knowledge_entities(entity_type);
CREATE INDEX idx_ke_name ON knowledge_entities(name);
CREATE INDEX idx_kr_subject ON knowledge_relations(subject_id, relation_type);
CREATE INDEX idx_kr_object ON knowledge_relations(object_id, relation_type);
CREATE INDEX idx_ee_entity ON email_entities(entity_id);
```

**图查询用 recursive CTE 示例：**

```sql
-- 查询: "找到和张三有关的所有项目和相关人员"
WITH RECURSIVE related AS (
    -- 起点: 张三参与的项目
    SELECT kr.object_id AS entity_id, 1 AS depth
    FROM knowledge_relations kr
    JOIN knowledge_entities ke ON kr.subject_id = ke.id
    WHERE ke.name = '张三' AND kr.relation_type = 'involved_in'

    UNION ALL

    -- 递归: 同一项目中还涉及哪些人
    SELECT kr.subject_id, r.depth + 1
    FROM knowledge_relations kr
    JOIN related r ON kr.object_id = r.entity_id
    WHERE kr.relation_type = 'involved_in' AND r.depth < 2
)
SELECT DISTINCT ke.name, ke.entity_type
FROM related r
JOIN knowledge_entities ke ON ke.id = r.entity_id;
```

SQLite 处理这类查询在 10 万实体规模下是毫秒级的。

### 记忆系统的 MVP 边界

第一版只做这些：

| 能力 | MVP 做 | MVP 不做 |
|------|--------|---------|
| 语义搜索 | ✅ 邮件 embedding → LanceDB → 自然语言搜索 | ❌ 附件内容 embedding |
| 实体提取 | ✅ Person + Organization 从邮件自动提取 | ❌ Project/Commitment/Topic 自动提取 |
| 关系图 | ✅ Person ↔ Organization (works_at) | ❌ 复杂的多跳关系推理 |
| 用户模型 | ✅ 从 settings 表读偏好写入 LLM prompt | ❌ 自动学习、行为模式分析 |
| Memory Compression | ❌ | ❌ 有了足够数据积累后再做 |
| Proactive Agent | ❌ | ❌ 第二阶段 |

---

## 二、Rust AI 生态 vs JS/Python：务实建议

### 诚实评估

```
Python AI 生态:  ████████████████████████████████ 100%
JavaScript 生态: ████████████████████░░░░░░░░░░░░  65%
Rust AI 生态:    ████████░░░░░░░░░░░░░░░░░░░░░░░░  25%
```

**Python 的优势（但对我们不适用）：**
- LangChain, LlamaIndex, HuggingFace Transformers, vLLM, PyTorch...
- 但 Tauri 不能嵌入 Python 运行时（sidecar 可以但太重）
- 我们不用 Python

**JavaScript/TypeScript 的 AI 优势（我们可以用）：**
- ✅ **Vercel AI SDK** — 统一 OpenAI/Anthropic/Google/Ollama 的 provider 抽象
- ✅ **Streaming** — AI SDK 的 `streamText()` 天然对接 React
- ✅ **Tool Calling** — AI SDK 的 `tool()` 定义比手写 JSON Schema 方便得多
- ✅ **LangChain.js** — 虽然抽象偏重，但某些模块有用
- ✅ **transformers.js** — 浏览器端运行小模型（可用于 L1 本地推理）

**Rust 的 AI 优势（我们可以用）：**
- ✅ **fastembed-rs** — 本地 embedding，比 Python 版本快，无需 GPU
- ✅ **async-openai** — 调用 OpenAI 兼容 API（包括 Ollama）
- ✅ **tiktoken-rs** — Token 计数
- ✅ **candle** (HuggingFace) — Rust 原生推理框架，可运行小模型
- ❌ 没有 LangChain 等价物
- ❌ 没有 AI SDK 级别的 streaming/tool-calling 抽象
- ❌ 大部分模型的最新量化版本优先支持 Python → GGUF → llama.cpp

### 核心建议：混合架构，各取所长

不要二选一。**Rust 做数据处理和隐私边界，TypeScript 做 LLM 编排和 UI 集成。**

```
                    数据流向
    ┌─────────────────────────────────────────────┐
    │                 Rust (Tauri Backend)         │
    │                                             │
    │  ┌──────────┐   ┌──────────┐  ┌──────────┐ │
    │  │ Embedding│   │ Document │  │ Privacy  │ │
    │  │ Service  │   │ Parser   │  │ Gate     │ │
    │  │(fastembed│   │(pdf/docx │  │(ammonia, │ │
    │  │ -rs)     │   │ /xlsx)   │  │ token    │ │
    │  └────┬─────┘   └────┬─────┘  │ counting)│ │
    │       │              │        └──────────┘ │
    │       ▼              ▼                     │
    │  ┌────────────────────────┐                │
    │  │   Context Assembler    │                │
    │  │   (组装 LLM 上下文)     │                │
    │  │   - 语义搜索 → 相关邮件 │               │
    │  │   - 实体图 → 相关人和事 │               │
    │  │   - 用户偏好 → 个性化   │               │
    │  └────────┬───────────────┘                │
    │           │                                │
    │           │  Tauri Command:                 │
    │           │  "这是上下文，调 LLM"            │
    │           ▼                                │
    └─────────────────────────────────────────────┘
                     │
              ┌──────┴──────┐
              │  Tauri IPC   │
              └──────┬──────┘
                     │
    ┌─────────────────────────────────────────────┐
    │            TypeScript (Frontend)             │
    │                                             │
    │  ┌──────────────────────────────────────┐   │
    │  │        Vercel AI SDK                  │   │
    │  │  ┌────────────────────────────────┐  │   │
    │  │  │ generateText / streamText       │  │   │
    │  │  │ tool() definitions              │  │   │
    │  │  │ Provider: OpenAI|Anthropic|     │  │   │
    │  │  │           Google|Ollama          │  │   │
    │  │  └────────────────────────────────┘  │   │
    │  └──────────────────────────────────────┘   │
    │                                             │
    │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
    │  │ Streaming│  │ Agent    │  │ Tool Use │  │
    │  │ → React  │  │ Loop     │  │ Executor │  │
    │  │ UI 实时  │  │ (多步    │  │ (调用    │  │
    │  │ 渲染     │  │  规划)   │  │  Rust    │  │
    │  └──────────┘  └──────────┘  │ command) │  │
    │                              └──────────┘  │
    └─────────────────────────────────────────────┘
```

### 具体分工

| 职责 | 在哪做 | 用什么 | 原因 |
|------|--------|--------|------|
| **Email → Text** | Rust | `mail-parser` (已有) | 已经在 Rust 侧 |
| **HTML Clean** | Rust | `ammonia` + `html2text` | 隐私 — 清洗后再交给 AI |
| **Embedding 生成** | Rust | `fastembed-rs` | 本地运行最快，无需网络 |
| **向量搜索** | Rust | LanceDB | 嵌入式数据库，Rust 原生 |
| **Token 计数** | Rust | `tiktoken-rs` | 需要准确计数来控制上下文大小 |
| **文档解析** | Rust | `pdf-extract` + `docx-rs` + `calamine` | 附件解析，数据不出本地 |
| **Context 组装** | Rust | 自建 | 从向量库 + 实体图 + 设置 拼装 prompt |
| **LLM 调用** | **TypeScript** | Vercel AI SDK | streaming、tool calling、provider switch 最成熟 |
| **Streaming → UI** | **TypeScript** | AI SDK `streamText` → React | AI SDK 的 React hook 无缝集成 |
| **Agent Loop** | **TypeScript** | 自建 + AI SDK tool() | Agent 编排逻辑更灵活地在 TS 侧 |
| **Tool 执行** | 混合 | TS 调 Rust commands | Agent 调 tool → tool 实际执行在 Rust (搜索/写邮件等) |
| **敏感信息检测** | Rust | `ammonia` + 规则引擎 | 不需要 LLM，正则+规则即可 |
| **本地小模型推理** | Ollama sidecar | HTTP API (两种语言都能调) | Ollama 是独立进程，语言无关 |

### 为什么 LLM 调用建议放前端

这似乎是反直觉的（前面 AI_Native_design.md 建议放 Rust），但有几个实际原因：

1. **Vercel AI SDK 的 streaming 体验无法替代。** `useChat()` hook 直接对接 React 组件，处理 abort、retry、backpressure。在 Rust 侧调 LLM 然后通过 Tauri Event 传 streaming chunks 到前端，等于重写了一遍 AI SDK。

2. **前端调 LLM 也是 HTTP 请求。** LLM API（OpenAI、Anthropic、Ollama）都是标准 HTTPS。不存在"前端直连不安全"的问题——数据从用户机器到 LLM 服务器，不经过你的服务器。

3. **Provider 配置灵活性。** 用户想用自己的 API key、换 provider、调参数——这些都在前端 UI 操作，直接从前端调 API 最直接。

4. **Rust 侧已经保护了隐私边界。** 传给 LLM 的 prompt 由 Rust 组装（只包含必需的上下文摘要，不包含原始邮件全文），然后通过 Tauri Command 交给前端去调 LLM。最敏感的数据处理（解密、清洗、提取）都在 Rust 侧完成。

### 一个例外：纯本地模式

当用户开启 `PrivacyMode::LocalOnly` 时，所有 LLM 调用必须走本地 Ollama。Ollama 暴露的是 HTTP API，前端可以直接调（`localhost:11434`），也可以从 Rust 调。两种方式都可以。

**建议：统一走 AI SDK 的 Ollama provider，保持代码路径一致。**

```typescript
// 前端统一入口
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { ollama } from 'ollama-ai-provider'; // community provider

async function callLLM(context: AssembledContext, mode: PrivacyMode) {
  const model = mode === 'local'
    ? ollama('qwen2.5:1.5b')
    : openai('gpt-4o-mini');

  const result = await generateText({
    model,
    system: context.systemPrompt,   // Rust 侧组装的
    messages: context.messages,     // Rust 侧筛选和清洗后的
    tools: availableTools,          // TS 侧定义的
    maxTokens: context.tokenBudget, // Rust 侧计算的
  });

  // 结果回存到 Rust 侧 (cache, entity updates, etc.)
  await invoke('ai_store_result', { result });
}
```

---

## 三、AI Layer 放置：Backend or Frontend？

### 直接回答：Rust 做数据层，TypeScript 做交互层

```
Rust (Backend) 负责:
  ✅ 数据接入 — MIME 解析、HTML 清洗、文档解析
  ✅ 隐私边界 — 解密后明文不出 Rust 侧
  ✅ 向量化 — embedding 生成和存储
  ✅ 搜索 — 语义搜索、混合检索
  ✅ 上下文组装 — 从多数据源拼装 prompt
  ✅ Token 管理 — 计数、budget、truncation
  ✅ 结果持久化 — 实体更新、缓存写入

TypeScript (Frontend) 负责:
  ✅ LLM 通信 — 调 OpenAI/Anthropic/Ollama API
  ✅ Streaming — 实时流式渲染到 UI
  ✅ Agent 编排 — Tool calling loop
  ✅ UI 交互 — Conversational UI、Daily Briefing 渲染
  ✅ Provider 配置 — 用户选择和配置 AI provider
```

### 这个架构的核心原则

**Rust 拥有数据，TypeScript 拥有对话。**

Rust 侧永远是"数据的守门人"——任何离开本机的数据都经过 Rust 的清洗和脱敏。TypeScript 侧是"对话的管家"——LLM 通信、streaming、tool use 这些交互逻辑在 TS 侧更灵活。

### 一个具体的流程示例

用户问："帮我找一下和张三讨论 Q4 预算的邮件，总结一下"

```
1. [TS] 用户输入 → invoke('ai_ask', { query: "..." })

2. [Rust] ai_ask command:
   a. 生成 query embedding (fastembed-rs)
   b. LanceDB 语义搜索 → 20 封相关邮件
   c. 实体识别 "张三" → CozoDB/SQLite 图查询 → 张三的 context
   d. FTS5 关键词搜索 "Q4 预算" → 10 封补充邮件
   e. Hybrid 去重 + Rerank → top 15 邮件
   f. 组装 Context = {
        system_prompt: "你是邮件助手...",
        relevant_emails: [摘要1, 摘要2, ...],  // 不是原文，是摘要
        entity_context: "张三: ABC公司VP, 上次联系3天前...",
        user_prefs: "用户偏好简洁回答...",
        token_budget: 8000
      }
   g. 返回 Context 给前端

3. [TS] 收到 Context:
   a. generateText({ model, messages: context.messages, ... })
   b. streaming → React UI 逐字渲染

4. [TS] LLM 完成:
   a. invoke('ai_store_result', { query, result, sources })
   
5. [Rust] ai_store_result:
   a. 写入 ai_cache (下次同样问题直接返回)
   b. 更新实体图的 last_seen/interaction_count
```

在这个流程中，Rust 处理了所有数据相关的重活（搜索、实体查询、隐私保护），TypeScript 只负责"把 context 发给 LLM 并 stream 回来"——这正是各自生态最强的部分。

---

## 四、总结：三个关键决策

### 决策 1: 记忆系统 — 从简开始

```
AI_Native_design.md 建议: 5 层 (Working/Episodic/Semantic/Entity/Procedural)
我的建议:               3 层 (Semantic Index / Knowledge Graph / User Model)
                      其中 Episodic = 现有的 messages 表
                      其中 Working = 现有的 Zustand stores
                      其中 Entity Graph = SQLite 关系表, 不用 CozoDB
MVP 第一版只做:         Semantic Index (LanceDB) + 简单的 Entity Extraction
```

### 决策 2: AI 生态 — 混合架构

```
不要选边站。Rust 做数据处理，TypeScript 做 LLM 交互。

Rust 负责: Embedding, 搜索, 上下文组装, 隐私边界, Token 管理
TS 负责:   LLM 调用 (Vercel AI SDK), Streaming UI, Agent Loop, Provider 配置
```

### 决策 3: 前后端分工

```
Rust 拥有数据 — 是所有数据的守门人，上下文组装在 Rust 侧完成
TypeScript 拥有对话 — LLM 通信和 UI 渲染在 TS 侧完成

关键边界: 传给 LLM 的内容由 Rust 筛选和脱敏，不传原始邮件全文
```

# AI Email Client — 竞品与参考产品深度研究

> 研究日期: 2026-06-30
> 覆盖: Proton / Thunderbird Thunderbolt / Nubo / Quartz Mail / Shortwave / Superhuman / Notion

---

## 一、产品速览矩阵

| 产品 | 定位 | AI 核心策略 | 技术栈 | 与 Kylins 相关度 |
|------|------|-----------|--------|-----------------|
| **Proton Mail** | 全球最大加密邮件服务 | 本地模型 (Scribe) + 隐私 AI 平台 (Lumo) | Rust 核心 + UniFFI + WASM + GPL-3.0 | ⭐⭐⭐⭐⭐ 最高 |
| **Thunderbird Thunderbolt** | 开源自托管 AI 客户端 | 模型无关 + 本地优先 + E2EE | Tauri + React + SQLite + Bun + PowerSync | ⭐⭐⭐⭐⭐ 最高 |
| **Quartz Mail** | 隐私绝对主义 AI 邮件 | 100% 本地模型 (Gemma 4B) | Tauri + Apple Silicon + llama.cpp | ⭐⭐⭐⭐⭐ 最高 |
| **Shortwave** | 最成熟的 AI 邮件客户端 | 云端 AI + RAG + 团队协作 | Next.js + Electron + Pinecone + GPT-4 | ⭐⭐⭐⭐ |
| **Superhuman** | 高端生产力套件 | Proactive Agent + Cross-app | Browser extension + Go agent platform | ⭐⭐⭐ |
| **Notion** | 工作空间平台 | Custom Agents 24/7 自主运行 | Custom + MCP + Workers | ⭐⭐⭐ |
| **Nubo** | 隐私商务邮件平台 | 信息极少 | 未知 | ⭐ (信息不足) |

---

## 二、Proton Mail — 加密邮件的黄金标准 + Rust 转型先驱

### 2.1 为什么 Proton 是 Kylins 最重要的参考

Proton 是全球最大的加密邮件服务（1 亿+ 用户），在三个维度上与 Kylins 高度相关：
1. **加密架构** — 行业最成熟的端到端加密实现，我们的加密设计大量借鉴了 Proton
2. **Rust 转型战略** — 正在从多平台独立代码库（Swift/Kotlin/TS）统一到 Rust 核心，与我们的 Tauri+Rust 路线一致
3. **隐私 AI 策略** — 开创了"本地模型 + 安全服务端"双模 AI 方案，直接回应了政府场景的合规需求

### 2.2 加密架构 — 四层防护体系

Proton 的加密不是单一方案，而是**四层叠加的纵深防御**：

```
Layer 0: 传输安全
  └── TLS 1.3 (标准 HTTPS)
  
Layer 1: API Tunnel (TLS 内的第二层加密)
  └── ECDHE 密钥交换 → AES-128-GCM
  └── SRP 登录后将 Session Key 升级为密码派生
  └── 防御: 流氓 CA 证书、企业 MITM 代理
  └── 每个包: IV + Timestamp (120s 窗口) + Nonce → 防重放
  
Layer 2: 零访问加密 (Zero-Access — 存储加密)
  └── 私钥由用户密码 bcrypt 派生密钥 AES-256 加密
  └── 服务器只存密文 → Proton 自己也无法解密
  └── 双重密码模式 (可选): 登录密码 ≠ 邮箱密码
  
Layer 3: 端到端加密 (E2EE — 邮件内容加密)
  └── Proton↔Proton: OpenPGP, 自动密钥交换
  └── Proton↔外部: 密码保护邮件 / 标准 PGP 互操作
  └── Key Transparency (2025): 区块链公钥目录 → 防密钥替换攻击
```

**对 Kylins 的关键启示：**

Proton 的 API Tunnel（TLS 内的第二层加密）在桌面客户端场景中**不需要**——我们没有中心化 API 服务器。但他们的**密钥分层模型**（Master Key → Account Key → Identity Key → Session Key）是我们 Crypto System Design 的直接参考来源。

### 2.3 跨平台 Rust 战略 — 与我们路线完全一致

Proton 正在进行一场雄心勃勃的架构转型：

```
旧架构 (2014-2024):
  Android: Kotlin (独立实现, 功能滞后)
  iOS:     Swift (独立实现)
  Web:     TypeScript/React (WebClients monorepo, 最活跃)
  Bridge:  Go (IMAP/SMTP 本地代理)
  加密:    OpenPGP.js (JS, 已归档) + 各平台独立实现
  → 问题: 功能不同步, bug 修 N 遍, 加密实现可能不一致

新架构 (2025-2026):
  ┌─────────────────────────────────────┐
  │        Rust Core (共享 ~80%)         │
  │  ├── proton-crypto-rs (加密)         │
  │  ├── 邮件业务逻辑                    │
  │  ├── 离线存储引擎                    │
  │  └── AI 功能模块 (Lumo shared/)      │
  ├────────────┬────────────┬───────────┤
  │ UniFFI     │ UniFFI     │ WASM      │
  │ → Kotlin   │ → Swift    │ → TS      │
  │ Android    │ iOS        │ Web       │
  └────────────┴────────────┴───────────┘
```

**2026 年的参考架构（proton-rust-nation-2026 仓库）：**

```
proton-rust-nation-2026/
├── lumo/                    # AI 功能模块 (可跨 app 复用!)
│   ├── shared/              # Rust: Lumo Crux app
│   ├── apple/               # iOS 壳
│   └── android/             # Android 壳
├── proton-news/             # 另一个 app, 组合使用 lumo
├── shared/                  # 跨 app 可复用模块
└── tools/                   # uniffi-bindgen, serde-codegen CLI
```

**核心理念：Feature 级别的跨 app 复用。** 一个 AI 功能（如 Lumo）写一次（Rust），通过 UniFFI + WASM 编译到所有平台，在 Mail / Calendar / News / Drive 中复用。

**对 Kylins 的启示：**
- ✅ 我们的 Tauri 路线本质上就是 Proton 的 "Rust core + thin shell" 模式——Tauri 直接用 Rust，不需要 FFI
- ✅ 我们的 `crates/` 工作空间设计（mail-core, ai-core, ai-memory 等）对应 Proton 的 shared crate 策略
- ✅ 加密从 Rust 侧统一实现（proton-crypto-rs → 我们的 crypto/ 模块）
- ⚠️ Proton 花了 ~2 年完成这个转型——我们需要意识到这是一个逐步演进的过程

### 2.4 AI 策略 — 双模隐私方案

Proton 有两个 AI 产品，代表两种不同的隐私策略：

#### Proton Scribe（邮件写作助手）

| 属性 | 详情 |
|------|------|
| **基础模型** | Mistral 7B（法国开源模型）|
| **运行模式 1** | **本地设备** — 模型下载到本地 (~4GB)，完全离线，零数据出设备 |
| **运行模式 2** | **安全服务端** — Proton 无日志服务器，处理后立即删除，不用于训练 |
| **功能** | Help me write / Proofread / Shorten / Expand / Formalize / Friendly |
| **语言** | 本地: 仅英文; 服务端: 9 种语言 |
| **隐私保证** | 零访问加密 → 无法用 inbox 训练；无日志；无第三方；开源 (GPL-3.0) |
| **系统要求** | macOS M-series / Windows (Core 7th gen+, GPU 6GB VRAM) / Chromium 浏览器 |
| **定价** | $2.99/用户/月 或 高级套餐免费 |

#### Lumo（隐私 AI 平台）

| 属性 | 详情 |
|------|------|
| **定位** | 跨 Proton 套件的通用 AI 助手 |
| **Lumo 1.3 Projects** (2026.1) | 加密工作空间 — 对话+文件+指令打包，多设备同步 |
| **深度集成** | Mail → Calendar → Drive → Pass → 所有 Proton 服务 |
| **2026 路线图** | 持久记忆、插件生态、原生桌面应用、Calendar 深度集成 |
| **企业定位** | Lumo Professional — 团队策略、决策制定 |

**对 Kylins 的关键启示：**

1. **双模 AI 是隐私敏感场景的最佳实践。** Proton 证明了用户愿意接受"本地模型能力弱但隐私强" vs "云端模型能力强但有隐私权衡"的选择。这正是我们 Privacy Mode 枚举的设计来源。

2. **"不访问 inbox"的 AI 写作更安全但更通用。** Proton Scribe 因为不能读用户邮件（零访问加密），生成的草稿是"通用"的。用户需要手动添加个性化细节。这提示我们：Kylins 的 AI 写作因为能访问本地邮件数据（在 Rust 侧），可以比 Proton Scribe 更个性化——但必须在 Privacy Mode = LocalOnly 时降级。

3. **开源是隐私 AI 的信任基础。** Proton Scribe 的代码和模型选择都开源 (GPL-3.0)。如果我们想说服政府客户 AI 是安全的，开源核心 AI 代码是最强力的证明。

4. **Feature 级跨 app 复用是终局。** Proton 的 `lumo/shared/` → 所有 app 的架构，提示我们 AI 功能模块应该设计为可跨场景复用——同一个 Entity Extraction 模块同时服务于 Composer、ReadingPane、Daily Briefing。

### 2.5 Proton Bridge — 邮件客户端的加密桥梁

Proton Bridge 是一个本地 IMAP/SMTP 代理（Go 编写），让 Thunderbird/Outlook/Apple Mail 等标准客户端可以访问 Proton 的加密邮件：

```
Thunderbird/Outlook
    │ IMAP/SMTP (标准协议)
    ▼
Proton Bridge (本地运行)
    │ 解密/加密
    │ Proton API (加密通道)
    ▼
Proton Servers (只存密文)
```

**对 Kylins 的启示：** Kylins 的角色类似"内置 Bridge 的邮件客户端"——我们直接处理 IMAP/SMTP + 本地 E2EE 加密，不需要 Bridge。但 Bridge 的架构证明了一点：**加密层应与协议层解耦，加密是 MIME 转换器，协议层只传输加密后的 MIME。** 这与我们的 Crypto System Design 完全一致。

### 2.6 开源策略

| 组件 | 协议 | 说明 |
|------|------|------|
| 客户端 (Web/Mobile) | **GPL-3.0** | Copyleft — 修改必须开源 |
| 加密库 (proton-crypto-rs) | **MIT** | Permissive — 生态友好 |
| IMAP 库 (gluon) | **MIT** | Permissive |

Proton 的"客户端 GPL-3.0 + 核心库 MIT"策略值得借鉴：
- 加密库用 MIT → 推动行业采用（RustCrypto 生态兼容）
- 客户端用 GPL-3.0 → 保护完整产品不被闭源 fork

---

## 三、Thunderbird Thunderbolt — 最接近我们的技术路线

### 2.1 为什么相关性最高

Thunderbolt 与 Kylins 的技术栈几乎完全重合：

| 维度 | Thunderbolt | Kylins | 对齐度 |
|------|------------|--------|--------|
| 桌面框架 | **Tauri** (Rust) | **Tauri 2.10** (Rust) | ✅ 100% |
| 前端 | React + TypeScript | React 19 + TypeScript | ✅ |
| 状态管理 | **Zustand** + TanStack Query | **Zustand** | ✅ |
| 本地数据库 | **SQLite** (Drizzle ORM) | **SQLite** (sqlx) | ✅ |
| 构建工具 | Vite | Vite | ✅ |
| 离线优先 | ✅ (SQLite 唯一数据源) | ✅ (local-first sync engine) | ✅ |
| 端到端加密 | ✅ (开发中) | ✅ (设计完成,待实现) | ✅ |
| 开源协议 | MPL-2.0 | Apache-2.0 / 待定 | 兼容 |

### 2.2 值得借鉴的设计

#### 推理代理层 (Inference Proxy)

Thunderbolt 的 LLM 路由架构：

```
前端 → 推理代理层 (Bun + Elysia)
         ├── 速率限制
         ├── 流量分配
         ├── 模型选择逻辑
         └── 路由到:
              ├── Ollama (本地,免费,离线)
              ├── llama.cpp (本地)
              └── 任何 OpenAI 兼容 API (云端)
```

**对 Kylins 的启示：** 我们不需要 Bun + Elysia 后端（Tauri Rust 后端已有），但"推理路由层"的概念应该放在 Rust 侧。借鉴其设计：

```rust
// Kylins 的 InferenceRouter
struct InferenceRouter {
    local_providers: Vec<LocalProvider>,    // Ollama, llama.cpp
    cloud_providers: Vec<CloudProvider>,    // OpenAI, Anthropic, etc.
    rate_limiter: RateLimiter,
    fallback_chain: Vec<ProviderTier>,      // L1 → L2 → L3
}
```

#### 邮件智能摘要流水线

```
Thunderbird 邮件同步 → 拉取原始邮件
  → 本地向量化 → SQLite 向量存储 (无外部向量库!)
  → LLM 推理 → 结构化摘要
  → PowerSync → 跨设备同步
```

**关键洞察：** Thunderbolt 用 SQLite 存向量，没有引入专门的向量数据库。这对 MVP 阶段很有参考价值——可以先不引入 LanceDB，用 SQLite + 简单余弦相似度起步。

**对 Kylins 的启示：** Phase 0 可以先在 SQLite 中存储向量（用 BLOB 列），等需要 HNSW 索引性能时再引入 LanceDB。

#### 模型无关策略

Thunderbolt 不绑定任何模型提供商——用户在设置中填 API key，支持任何 OpenAI 兼容接口。这给用户完全的控制权。

**对 Kylins 的启示：** 我们的 AI provider 抽象应该支持"用户自带 key"模式，同时提供默认的 provider。不过 Kylins 是桌面客户端（不是 Thunderbolt 那样的自托管服务），不需要后端代理——AI 请求可以直接从前端发出。

### 2.3 注意的局限

- Thunderbolt **不是邮件客户端**——它是一个通用 AI 助手，可以读邮件但不是邮件客户端
- 它的后端（Bun + Elysia）是必需的，不适用于纯桌面应用
- E2EE 和离线支持仍在开发中，尚未生产就绪

---

## 四、Quartz Mail — 隐私绝对主义的参考

### 3.1 架构亮点

Quartz 是所有竞品中架构最激进的：

```
┌─────────────────────────────────────┐
│         Quartz (Tauri)              │
│  ┌───────────────────────────────┐  │
│  │  Gemma 4 E4B (~4B params)    │  │
│  │  运行在 Apple Silicon 上      │  │
│  │                              │  │
│  │  • Inbox 分类 (5 级重要性)   │  │
│  │  • Reply 草稿生成            │  │
│  │  • 用户风格学习              │  │
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │  Encrypted Local Storage      │  │
│  │  (user-held keys)             │  │
│  └───────────────────────────────┘  │
│              │                       │
│       Gmail API (OAuth)              │
│   NO AI processing in cloud          │
└─────────────────────────────────────┘
```

**核心原则：没有任何服务器看到邮件内容。** AI 模型（Gemma 4 E4B, ~4B 参数, ~4GB）下载到本地运行。

### 3.2 值得借鉴的设计

#### 冷启动方案

Quartz 面临的核心问题：新用户没有历史数据，AI 如何学习偏好？

**Quartz 的做法：** 在 onboarding 时让用户主动描述偏好：
- 哪些类型的邮件是重要的？
- 写作风格偏好（正式/友好/简洁）
- 创建一个类似 "CLAUDE.md for the model" 的 profile

**对 Kylins 的启示：** 我们的 AI 也需要冷启动。可以设计一个 onboarding flow：
1. 用户连接邮箱后 → 分析最近 100 封邮件的元数据（不发云端）
2. 让用户标注 5-10 封邮件的优先级 → 建立初始分类模型
3. 让用户选择写作风格 → 模板化 system prompt

#### 学习闭环

用户纠正 AI 的分类 → 反馈被记录 → 下次类似邮件到达时，反馈作为上下文传给模型。

这个设计模式非常优雅——不需要模型微调，只需要在 prompt 中注入用户历史反馈。

```
User feedback: "这封邮件应该是 Important, 不是 FYI"
  → 存储: { thread_subject: "Q4 Review", user_correction: "Important" }
  → 下次类似邮件: system prompt 中包含 "Previously, user corrected similar emails to Important"
```

#### 本地模型选型

Quartz 选择 **Gemma 4 E4B**（Google 的 4B 参数模型）：
- 适合在消费级硬件上运行（~4GB 模型文件）
- 足以处理邮件分类和简单草稿
- 不需要 GPU，Apple Silicon Neural Engine 即可

**对 Kylins 的启示：** 对于 Privacy Mode = LocalOnly 的场景，我们可以推荐用户安装 Ollama + Qwen2.5-1.5B（更小，~1GB）或 Gemma 4 E4B（更强，~4GB）。不做本地模型的内置捆绑（太重），而是对接用户已有的 Ollama 实例。

### 3.3 Quartz 的局限

| 局限 | 影响 |
|------|------|
| Apple Silicon only | 无法服务 Windows 用户（我们的核心用户群） |
| Gmail only | 无法服务 Outlook/Exchange/Coremail 用户 |
| 4GB 模型每次更新都要重新下载 | 用户体验差 |
| 只有 5 个标准分类 | 不支持自定义（roadmap 中） |
| 只在 Quartz 内发送的邮件中学习风格 | 不发邮件就没有风格数据 |

**关键判断：Quartz 的"100% 本地 AI"路线适合隐私绝对主义者，但不适合 Kylins 的目标用户（香港政府 + To C 主流用户）。我们需要的是"本地可选，云端增强"的灵活架构。**

---

## 五、Shortwave — 最成熟的 AI 邮件产品

### 4.1 产品成熟度

Shortwave 在所有竞品中功能最完整：
- ✅ AI Agent（组织、排程、写作、搜索于一体）
- ✅ AI 搜索（自然语言 + Gmail 式过滤）
- ✅ AI 写作（学习用户风格 + 实时引用历史邮件中的链接和事实）
- ✅ AI 摘要（每封邮件顶部 tl;dr）
- ✅ AI 过滤（自然语言写规则）
- ✅ 团队协作（共享标签、评论、分配、已读回执）
- ✅ 自动化（Tasklet：3000+ 集成）
- ✅ CASA Tier 2 安全认证

### 4.2 值得借鉴的设计

#### AI 写作中的"事实引用"

> "Autocomplete with personalized suggestions... incorporating **real links, facts, and phrases from your email history**."

Shortwave 的 AI 不仅在语言上模仿用户，还自动从历史邮件中提取可引用的事实和链接。这是 Semantic Memory 的实战应用。

**对 Kylins 的启示：** 我们的 Ghost Text / Smart Compose 不只是预测下一个词——还要在 prompt 中注入从 Knowledge Graph 检索到的相关事实："收件人张三上次在邮件中提到预算上限是 50 万"、"相关项目 Q4 Launch 的 timeline 是..."

#### 单次 LLM 推理架构

Shortwave 发现链式 LLM 调用会在每一步引入数据丢失和错误。他们的方案是：把所有上下文收集到一个大 Prompt 中，一次调用完成。

**对 Kylins 的启示：** 我们的 Agent 架构不要追求"多步推理链"——把精力放在"如何组装高质量的单次 Prompt"上。Tool Use 只用于确定需要哪些数据源，而不是用于多步推理。

#### AI Filter = 自然语言规则

用户用自然语言写过滤规则："自动标记所有来自供应商的发票邮件，并标记为待处理"。

**对 Kylins 的启示：** 这比传统的 filter UI（条件+动作下拉框）直观得多。可以在 settings 中加一个 "AI Filter" 功能——用户用自然语言描述规则 → LLM 生成 filter 配置 → 用户确认 → 规则引擎执行。

### 4.3 Shortwave 的局限（对 Kylins 的参考意义）

- **Gmail only** — 不支持 Exchange/Outlook/IMAP/Coremail
- **云端 AI** — 邮件数据经过 OpenAI API，政府场景不可行
- **Electron** — 比 Tauri 重
- **不开源** — 无法参考代码

---

## 六、Superhuman — 从邮件客户端到 AI 平台

### 6.1 产品演进

Superhuman 从"最快的邮件客户端"演变为"AI Native 生产力套件"：

```
Superhuman Mail (邮件客户端)
  → Superhuman Go (proactive AI assistant)
  → Agent Store (第三方 Agent 市场)
  → + Grammarly (AI 写作)
  → + Coda (协作空间)
```

### 6.2 值得借鉴的设计

#### Superhuman Go = Ambient AI 的标杆

> "The proactive AI assistant that knows what you know and offers help **without you having to ask**."

Go 的核心设计原则：
1. **理解上下文** — 知道你在看什么邮件、什么文档
2. **主动行动** — 不只是建议，而是执行（预订会议、生成报告）
3. **跨 app 工作** — 连接 Gmail、Drive、Jira 等
4. **不打断用户** — 在后台运行，结果呈现为卡片/建议而非弹窗

**对 Kylins 的启示：** 这就是我们 Ambient UI 的目标形态。Superhuman Go 验证了"Proactive AI"不是 Clippy——它确实有用，前提是：
- 不常驻占位
- 只在相关时出现
- 用户可以随时忽略或关闭
- AI 操作可撤销

#### Agent Store

Superhuman 开放了 Agent 平台，第三方可以构建专门的 Agent。

**对 Kylins 的启示：** 我们的 Plugin 系统已经支持第三方扩展。加密和 AI 功能都可以通过 Plugin 扩展。未来可以考虑 "AI Plugin" 市场——第三方提供专门的 AI 能力（例如：法律合规检查 Agent、财务审批 Agent）。

### 6.3 不适用 Kylins 的方面

- **Browser extension 模式** — Superhuman 主要通过浏览器扩展工作，这不适用于 Tauri 桌面应用
- **$30/月定价** — 面向高端专业用户，不适用于政府场景的定价模式
- **云端 AI only** — 没有本地 AI 选项

---

## 七、Notion — Agent 架构的最佳参考

### 7.1 为什么参考 Notion

Notion 不是邮件客户端，但它的 **Custom Agents 架构** 是所有竞品中最成熟的 Agent 基础设施。他们花了 4 年、5 次推倒重来才达到现在的架构。

### 7.2 五次架构迭代的教训

| 版本 | 做法 | 为什么失败 |
|------|------|-----------|
| v1 (2022) | Coding agent — 给 AI JavaScript API 写代码 | 模型编程能力不够 |
| v2 | Custom XML — lossless XML 映射 Notion blocks | 模型不擅长 XML，需要大量 prompt 工程 |
| v3 | **Markdown + SQL** | ✅ 突破。模型天然擅长这两种格式 |
| v4 | **Declarative tool definitions** | ✅ 允许分布式 tool ownership |
| v5 | **Progressive tool disclosure** | ✅ 100+ tools 按需展示，大幅降低 token 成本 |

**最重要的教训：给模型它擅长的格式。**

Notion 发现：
- ❌ XML → 模型不擅长
- ❌ 自定义 DSL → 模型需要大量训练
- ✅ **Markdown** → 模型在训练中大量接触
- ✅ **SQL-like** → 模型在训练中大量接触

**对 Kylins 的启示：**
1. Agent 与邮件的交互界面用 **Markdown** 格式（Tiptap 输出 HTML，但给 AI 时转 Markdown）
2. Agent 搜索邮件用 **SQL-like** 查询语法
3. **不要发明自定义的 agent<>tool 通信格式**——用 JSON + JSON Schema（AI SDK 的 `tool()` 定义）

### 7.3 Progressive Tool Disclosure

Notion 面临的问题：100+ tools，全部放进 prompt 太贵（token 成本爆炸）。

解决方案：**Agent 按需搜索 Tools**——只展示与当前任务相关的 tools。

```
User: "帮我整理本周的客户反馈"
  → Agent 搜索 tool 注册表: "我需要哪些 tool?"
  → 找到: search_pages, read_database, summarize_text
  → 只把这 3 个 tool 的定义放入 prompt
  → Token 成本: 100 tools (全部) → 3 tools (按需)
```

**对 Kylins 的启示：** 当我们有超过 10 个 Agent Tools 时，需要实现类似的机制。初期 tools 少（search_emails, compose_email, get_thread, find_person, schedule——5个），不需要。但架构上预留扩展点。

### 7.4 Manager Agent 模式

Notion 内部最成功的实践：**一个 Manager Agent 管理 30+ 子 Agent。**

原来每天 70+ 条通知 → 经理 Agent 整合 → 每天 ~5 条。

**对 Kylins 的启示：** 这是 Daily Briefing 的技术基础。不是所有 AI 发现都直接推给用户——先由一个 "Briefing Agent" 整合和优先级排序，再输出到 Daily Briefing 卡片。

### 7.5 @Mention Agents Inline

在 Notion 页面中，用户可以 `@agent-name` 直接调用 Agent，Agent 在上下文中执行操作。

**对 Kylins 的启示：** 在 Composer 中，用户可以 `@ai summarize this thread` 或 `@ai draft a reply`——Agent 作为编辑器中的一等公民，不是外部工具。

### 7.6 Triggers & Schedules

Notion Agents 的触发机制：
- **定时** — 每天/每周/每月
- **事件** — 页面更新、数据库新增、评论添加
- **外部** — Slack 消息、webhook

**对 Kylins 的启示：** Daily Briefing 不需要用户触发——Agent 在后台定时运行（每天早上 7:00），结果推送到 UI。其他 trigger 场景：
- "收到 VIP 联系人的邮件" → Agent 立即处理 → 推送通知
- "邮件中包含承诺" → Agent 提取 → 存入 Commitment Tracker

---

## 八、最佳实践提炼

### 8.1 架构层面

| 最佳实践 | 来源 | 对 Kylins 的应用 |
|---------|------|-----------------|
| **给模型它擅长的格式** (Markdown + SQL) | Notion v3 | Agent<>邮件交互用 Markdown；搜索用 SQL-like |
| **单次 LLM 推理优于链式调用** | Shortwave | Agent 的重点是组装高质量 Prompt，不是多步推理 |
| **Progressive Tool Disclosure** | Notion v5 | 当 tools > 10 时实现按需 tool 搜索 |
| **推理路由层** (本地 vs 云端分流) | Thunderbolt | 在 Rust 侧实现 InferredRouter |
| **SQLite 向量存储起步** | Thunderbolt | MVP 用 SQLite BLOB 存向量，后期迁 LanceDB |
| **Markdown 作为 AI 交互格式** | Notion v3 | Tiptap HTML → Markdown → LLM → Markdown → HTML |

### 8.2 隐私与安全层面

| 最佳实践 | 来源 | 对 Kylins 的应用 |
|---------|------|-----------------|
| **三级隐私模式** (Local / Balanced / Cloud) | Quartz + Thunderbolt | Architecture-level enum, 所有跨网请求检查 |
| **CASA Tier 2 认证** | Shortwave + Quartz | 政府场景的安全认证目标 |
| **本地模型可选而非强制** | Quartz + Thunderbolt | 用户选择: Ollama 本地 / 云端 API |
| **冷启动 Onboarding 主动引导** | Quartz | 让用户标注少量邮件 + 选择风格偏好 |
| **用户反馈 → Prompt 注入（非微调）** | Quartz | 纠正不重训练，而是在下次 prompt 中注入历史反馈 |

### 8.3 AI 功能层面

| 最佳实践 | 来源 | 对 Kylins 的应用 |
|---------|------|-----------------|
| **AI 写作引用历史事实** | Shortwave | Ghost text + KG 检索 → 注入可引用的上下文 |
| **自然语言过滤规则** | Shortwave | 替代传统 filter UI |
| **每封邮件顶部 AI 摘要** | Shortwave | ReadingPane 顶部 2 行 tl;dr |
| **Proactive Agent (不打断用户)** | Superhuman Go | Ambient UI 的核心设计原则 |
| **Agent Store / Agent 市场** | Superhuman | Plugin 系统的 AI 扩展 |
| **Daily Briefing = Manager Agent 模式** | Notion | 一个 Agent 整合多个子 Agent 的输出 |
| **@Mention Agent inline** | Notion | Composer 中 `@ai` 触发 AI 命令 |
| **Agent Triggers (定时+事件)** | Notion | Daily Briefing 定时 + VIP 邮件事件触发 |

### 8.4 工程层面

| 最佳实践 | 来源 | 对 Kylins 的应用 |
|---------|------|-----------------|
| **不要捆绑模型文件** (4GB 太沉) | Quartz 的教训 | 对接用户已有的 Ollama，不内置模型 |
| **本地向量用 SQLite 起步** | Thunderbolt | Phase 0 不需要 LanceDB |
| **Tauri 做桌面壳** | Thunderbolt + Quartz | 确认我们的技术路线正确 |
| **增量更新优于全量重下载** | Quartz 的教训 | 上下文增量更新，不每次重建 |

---

## 九、对 Kylins 路线的修正建议

基于以上所有竞品研究，对我之前提出的架构做以下修正：

### 修正 1: 向量存储 — MVP 用 SQLite，后期迁 LanceDB

Thunderbolt 证明了 SQLite 向量存储是可行的起步方案。减少 Phase 0 的一个依赖。

### 修正 2: 本地 AI — 不内置模型，对接 Ollama

Quartz 的 4GB 模型捆绑在桌面应用中太重。Kylins 应该：
- 在 settings 中配置 Ollama endpoint（默认 `localhost:11434`）
- 自动检测本地可用的模型列表
- 推荐轻量模型（Qwen2.5-1.5B / Gemma 4 E4B）
- 云端 API 作为默认，本地作为隐私选项

### 修正 3: Agent 交互格式 — Markdown

Notion 的教训太重要了。在给 AI 发送邮件内容时，先转 Markdown（Tiptap 的 `editor.getText()` 已经够了，HTML 用 `turndown` 或 Rust `html2text` 转 Markdown）。

### 修正 4: AI Filter — 加入 Phase 1

Shortwave 的自然语言过滤规则是一个低实现成本、高用户价值的 feature。可以放在 AI Side Panel 中作为首批功能之一。

### 修正 5: Manager Agent — Daily Briefing 的技术基础

Notion 的 Manager Agent 模式验证了"一个 Agent 整合多个来源 → 减少通知"的可行性。Daily Briefing 就是 Kylins 的 Manager Agent。

---

## 十、竞争定位

```
                    AI 处理位置
                    云端 ←──────────→ 本地

    通用性  ↑  Shortwave     |  Quartz
    (多协议) |  Superhuman   |  Thunderbolt
            |  Proton       |  ★ Kylins (目标)
            |  Notion       |
    专用性  ↓  (非邮件)     |  Nubo (?)
    (Gmail only)
```

**Kylins 的独特位置：** 唯一同时满足以下条件的产品：
1. ✅ 本地 AI 可选（像 Quartz + Proton Scribe）
2. ✅ 云端 AI 可选（像 Shortwave）
3. ✅ 多协议支持（IMAP/Exchange/Coremail — 不是 Gmail only）
4. ✅ 端到端加密（Proton 级别的安全设计）
5. ✅ Tauri 轻量桌面应用（与 Quartz/Thunderbolt 一致）
6. ✅ Rust 核心（与 Proton 新架构一致）
7. ✅ 开源

**没有任何竞品同时满足这七点。**

---

## 参考资料

- [Proton Mail](https://proton.me/)
- [ProtonMail GitHub](https://github.com/ProtonMail)
- [Proton Scribe Writing Assistant](https://proton.me/blog/proton-scribe-writing-assistant)
- [Proton Crypto Architecture (proton-crypto-rs)](https://github.com/ProtonMail/proton-crypto-rs)
- [Proton Rust Cross-Platform Strategy (Kerkour)](https://kerkour.com/proton-apps-rust)
- [Proton Lumo AI Projects](https://proton.me/blog/lumo-1-3)
- [Proton 2026 Roadmap](https://itdaily.com/news/software/proton-new-features-mail-drive-vpn/)
- [Thunderbird Thunderbolt GitHub](https://github.com/thunderbird/thunderbolt)
- [Thunderbolt Architecture Deep Dive](https://blog.hotdry.top/posts/2026/04/18/thunderbird-thunderbolt-architecture-local-inference-privacy/)
- [Quartz Mail](https://www.quartzmail.ai/)
- [Shortwave](https://www.shortwave.com/)
- [Shortwave AI Deep Dive](https://www.shortwave.com/blog/deep-dive-into-worlds-smartest-email-ai/)
- [Superhuman](https://superhuman.com/)
- [Superhuman Go Blog](https://blog.superhuman.com/superhuman-heygen-turn-content-into-video/)
- [Notion Custom Agents](https://www.notion.com/releases/2026-02-24)
- [Notion Developer Platform](https://www.notion.com/blog/introducing-developer-platform)
- [Notion's Agent Architecture Journey (ZenML)](https://www.zenml.io/llmops-database/building-custom-agents-at-scale-notions-multi-year-journey-to-production-ready-agentic-workflows)

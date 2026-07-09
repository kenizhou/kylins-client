# Kylins — AI + Security Native Mail Client

## Architecture Proposal & Full-Stack Design

> **Status:** Proposal (canonical for AI + security implementation)  
> **Date:** 2026-07-09  
> **Based on:** `docs/design/*`, crypto system design, and the current codebase  
>   (Rust-owned SQLite + `SyncEngine` + IMAP/EAS + classification UI scaffolding)

This document is the **binding engineering proposal** for implementing an AI-native and security-native mail client. Where earlier design docs disagree, the decisions in **§2** win.

### Related documents

| Document | Role |
|----------|------|
| `AI_Native_design.md` | Product vision, government + To-C context, six-layer mental model |
| `AI_Native_Gap_Analysis.md` | Codebase gap vs AI Native (partially superseded by §2 decisions) |
| `Memory_System_Design.md` | Pragmatic 3-layer memory; Rust/TS split — **adopted** |
| `Composer_AI_Inline_Design.md` | Ghost text / inline rewrite / slash commands |
| `AI_UI_Industry_Research.md` | Multi-agent patterns, AG-UI events, CopilotKit stance |
| `Competitor_AI_Research.md` | Proton / Thunderbolt / Quartz / Shortwave / Superhuman |
| `../superpowers/specs/2026-06-29-crypto-system-design.md` | CryptoProvider trait, S/MIME → PGP → 国密 |

---

## 1. Product thesis

### 1.1 Positioning

| Axis | Choice |
|------|--------|
| Form | **Mail client only** (no MTA) — protocol client over IMAP/SMTP/EAS (+ Graph/Gmail later) |
| Dual market | **Security-sensitive / government-pro** *and* **To-C prosumer** on one architecture |
| AI definition | AI sits on the **write path** of mail (index · structure · risk), not a ChatGPT sidebar |
| Security definition | **Classification + crypto + privacy gate + auditability** are first-class, not plugins |
| Trust rule | AI **advises and drafts**; humans **decide and send**. No silent auto-send in MVP |

### 1.2 What “AI + Security Native” means

1. **AI participates in ingest** — every message can be classified, embedded, entity-linked, risk-scored *asynchronously after sync*.
2. **Security participates in egress** — every send path can run sensitivity check, classification suggestion, sign/encrypt.
3. **Privacy is an architecture mode**, not a settings toggle afterthought: `LocalOnly | Balanced | Cloud`.
4. **UI stays Outlook-muscle-memory first**, then conversational + ambient layers on top.

### 1.3 Product stage alignment

| Stage | Time horizon | Product reality |
|-------|--------------|-----------------|
| **Stage 1 (now)** | 2–3 years | AI-assisted client: summary, NL search, compose assist, security checks |
| **Stage 2 (architecture only)** | 3–7 years | Decision queue, deeper memory, tool-using agent with HITL |
| **Stage 3 (not MVP)** | 7+ years | Agent protocol / proactive autonomy |

**Ship Stage 1. Architect for Stage 2. Do not ship Stage 3 autonomy early.**

Government constraint: no “AI acts for you.” AI is compliance and productivity enhancement.

---

## 2. Binding decisions (vs prior design docs)

### 2.1 Keep

| Idea | Source | Why |
|------|--------|-----|
| Six-layer mental model (UI → Agent → Semantic → AI service → Mail → Identity) | `AI_Native_design` / Gap Analysis | Correct separation of concerns |
| Post-sync AI pipeline (async, non-blocking) | Gap Analysis | Only way to be “native” without killing sync |
| L1/L2/L3 model routing + PrivacyMode | Gap + Competitors | Cost + compliance |
| Hybrid retrieval (FTS + vector + entities) | Industry research | Production RAG pattern |
| Composer ghost text / inline rewrite / command palette | Composer AI design | Highest UX ROI for outbound intelligence |
| CryptoProvider trait, S/MIME → PGP → 国密 | Crypto system design | Modular security |
| Dual-mode AI (local + private/cloud) | Proton / Quartz research | Trust narrative |
| No full CopilotKit lock-in; adopt AG-UI *event shapes* only | AI UI research | Fits Tauri + Zustand |

### 2.2 Reject or simplify

| Idea | Recommendation | Reason |
|------|----------------|--------|
| 5-layer MemGPT memory (Working/Episodic/Semantic/Entity/Procedural as separate systems) | **3-layer pragmatic memory** | Messages *are* episodic; Zustand *is* working memory |
| CozoDB for entity graph | **SQLite entity tables + recursive CTE** | Scale, build complexity, ops |
| All LLM orchestration in Rust | **Rust owns data & context; TS owns chat streaming & tool loop** | Vercel AI SDK is stronger for streaming/tools; Rust still owns privacy gate |
| LanceDB from day 0 | **Phase A: sqlite-vec or BLOB vectors; Phase B: LanceDB if needed** | Thunderbolt lesson; fewer native deps |
| Auto-send / proactive agent that acts | **Phase 3+ only, always HITL** | Trust + government market |
| CopilotKit full stack | **No** | Conflicts with Tauri/Rust ownership |

### 2.3 Strategic sequencing

Ship in this order — **security-visible AI first**, then memory, then agents:

```
P0  Privacy + Security AI surface (classification, sensitivity, local gate)
P1  AI foundation (providers, cache, context assembler, streaming)
P2  Ingest pipeline (embed + classify + extract person/org)
P3  Interaction (NL search, chat panel, composer inline AI)
P4  Memory graph (commitments/tasks/relations) + Daily Briefing
P5  Crypto E2EE (S/MIME → PGP → optional SM) + encrypted-mail AI policy
P6  Tool-using agent (HITL) + optional Graph/Gmail sources
```

Rationale: classification UI scaffolding and a solid mail engine already exist. The first *product-visible* win is “this client understands risk and helps me write/search safely,” not a full knowledge graph.

---

## 3. Target full-stack architecture

### 3.1 Layer diagram (mapped to Kylins packages)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ INTERACTION (kylins.client.frontend)                                    │
│  Traditional: AppShell · MessageList · ReadingPane · Composer           │
│  Security UI: Classification badges/banners/watermark · SecurityChips   │
│  Conversational: AI Assistant panel · NL search · @context chips        │
│  Ambient: StatusBar AI state · Briefing cards · sensitivity toast       │
│  Composer AI: Ghost text · Ctrl/Cmd-K rewrite · /commands               │
├─────────────────────────────────────────────────────────────────────────┤
│ FRONTEND AI RUNTIME (TS)                                                │
│  Vercel AI SDK  · streamText / generateText · tool() definitions        │
│  Provider registry (user keys + Ollama + private OpenAI-compatible)     │
│  Agent loop (HITL confirm before destructive tools)                     │
│  Event bus (AG-UI-shaped): run:* · text:* · tool:* · security:*         │
├─────────────────────────────────────────────────────────────────────────┤
│ Tauri IPC                                                               │
│  Commands: ai_assemble_context · ai_index_* · security_scan_draft · …   │
│  Events:   ai:pipeline · ai:index-progress · security:alert · sync:*    │
├─────────────────────────────────────────────────────────────────────────┤
│ RUST BACKEND (kylins.client.backend)                                    │
│                                                                         │
│  ┌─ SECURITY PLANE ──────────────────────────────────────────────────┐  │
│  │ PrivacyGate · ClassificationService · SensitivityScanner          │  │
│  │ CryptoProvider (S/MIME / PGP / SM) · KeyStore · AuditLog          │  │
│  │ Policy: LocalOnly blocks cloud · encrypted-mail AI opt-in         │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ AI DATA PLANE ───────────────────────────────────────────────────┐  │
│  │ ContextAssembler · EmbeddingService · HybridRetriever             │  │
│  │ EntityExtractor (async) · KnowledgeStore (SQLite) · VectorStore   │  │
│  │ Prompt templates (minijinja) · TokenBudget · AiCache              │  │
│  │ PostSyncPipeline (hook after SyncEngine delta apply)              │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ MAIL ENGINE (existing) ──────────────────────────────────────────┐  │
│  │ SyncEngine · MailSource (IMAP/EAS) · pending_ops · sqlx SQLite    │  │
│  │ mail-parser · SMTP · OAuth · attachment cache                     │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

**Principle:** *Rust owns data and risk; TypeScript owns conversation and streaming.*  
This is the Memory doc’s hybrid model, not “everything in Rust.”

### 3.2 Ownership matrix

| Concern | Owner | Technology |
|---------|-------|------------|
| MIME parse / HTML clean for AI | Rust | `mail-parser`, `ammonia`, `html2text` |
| Embedding + vector search | Rust | `fastembed-rs` + sqlite-vec (then LanceDB) |
| Entity / knowledge graph | Rust | SQLite tables (see §5.2) |
| Token budget / truncation | Rust | `tiktoken-rs` or equivalent |
| Privacy / redaction before leave-device | Rust | `PrivacyGate` |
| Sensitivity rules + classification suggest | Rust (+ optional L1 LLM) | rules + local model |
| Crypto sign/encrypt/decrypt | Rust | `CryptoProvider` trait |
| LLM chat / draft / rewrite streaming | TS | Vercel AI SDK |
| Agent tool loop | TS | AI SDK `tool()` → `invoke` tools |
| Tool *execution* (search, move, compose draft) | Rust via IPC | existing `db_*` / `sync_*` |
| UI state | TS | Zustand |
| Mail sync | Rust | existing `SyncEngine` |

---

## 4. Security plane

### 4.1 PrivacyMode (architecture enum)

```
LocalOnly   → no cloud LLM/embedding; only Ollama/local embed; AI may be weaker
Balanced    → L1 local always; L2/L3 cloud only for user-initiated tasks; ingest stays local
Cloud       → allow cloud embed + L2/L3 for ingest enrichment (To-C power users)
```

Enforced in **Rust `PrivacyGate`**: any payload leaving the process for a cloud endpoint is built only after gate approval. Frontend cannot bypass by calling a cloud API with raw mailbox bodies from the viewer. Draft text the user typed is their choice; **mailbox content** must go through assemble/redact.

### 4.2 Security AI capabilities (MVP-aligned)

| Feature | When | Where |
|---------|------|--------|
| Classification levels | List / viewer / composer | Existing `features/classification` + `classification_id` on messages/threads |
| Auto classification suggest | Post-sync / on open | L1 rules + optional local LLM → write `classification_id` |
| Pre-send sensitivity scan | Composer send | PII/secret patterns + keyword lists + optional L1 |
| Classification watermark / banners | View / compose | Existing UI |
| Encrypted-mail policy | Decrypt path | Decrypt in Rust → AI enrich only if policy allows → never put full plaintext in IPC for AI |
| Audit trail (enterprise) | Optional | `security_audit_events` table (who viewed classified, who overrode AI block) |

### 4.3 Crypto integration (with AI)

Align with `docs/superpowers/specs/2026-06-29-crypto-system-design.md`:

```
Receive:  sync → detect CMS/PGP → decrypt/verify (Rust)
          → plaintext stays in message_bodies / ephemeral buffer
          → AI pipeline sees plaintext only in-process
          → extracts embeddings/entities (no raw body in vector metadata)
          → UI gets sanitized HTML via existing SafeHtmlFrame path

Send:     Composer → sensitivity_scan + classification_suggest
          → user confirms → sign/encrypt via CryptoProvider
          → SMTP/EAS send
```

**Hard rules**

1. Decrypted plaintext never round-trips through TS for “AI convenience.”
2. Vector/entity stores hold **derived** data (summaries, ids, types), not full classified bodies (configurable).
3. AI on encrypted mail is **off by default** until user opts in per account.
4. `LocalOnly` + classified mail → no cloud, period.

### 4.4 Existing classification scaffolding

The tree already has:

- UI: classification levels, badges, banners, watermarks, security chips (`features/classification`)
- Schema fields: `classification_id`, `is_encrypted`, `is_signed` on threads/messages

**Wire AI suggest → those fields.** Do not invent a parallel security model.

### 4.5 Government / security product constraints

From product vision (client-only, security-sensitive markets):

| Do | Do not (MVP) |
|----|----------------|
| Summary, NL search, writing assist, sensitivity detection, classification suggest | Auto-reply, auto-send, AI agent that decides alone |
| Local / private-model AI; AI fully disableable | Hard-coded cloud-only AI |
| Auditability for overrides | Opaque AI decisions with no evidence |
| Citations for factual claims about mail | Hallucinated “facts” without message ids |

Enterprise-only features (DRM, watermarking hardware, CA integration) can layer later without changing the core planes.

---

## 5. AI data plane

### 5.1 Pragmatic memory (3 layers)

Adopt `Memory_System_Design.md`:

| Layer | Storage | Content | MVP |
|-------|---------|---------|-----|
| **Semantic index** | Vector store | Message/chunk embeddings | Yes |
| **Knowledge graph** | SQLite | person, org, relations; later commitment | Person+Org first |
| **User model** | `settings` + small profile tables | tone, language, style | Manual settings first |

- **Working memory** = Zustand (open thread, chat session, composer draft).
- **Episodic memory** = existing `messages` / `threads` tables.

### 5.2 Schema additions (illustrative)

```sql
-- Vector (Phase A: sqlite-vec or BLOB)
CREATE TABLE message_embeddings (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  chunk_id   TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  embedding  BLOB NOT NULL,          -- or virtual vec table
  text_hash  TEXT NOT NULL,          -- skip re-embed if body unchanged
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id, chunk_id, model)
);

CREATE TABLE knowledge_entities (
  id TEXT PRIMARY KEY,
  account_id TEXT,                   -- null = global person across accounts (policy)
  entity_type TEXT NOT NULL,          -- person | organization | project | commitment | topic
  name TEXT NOT NULL,
  email TEXT,
  domain TEXT,
  summary TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  mention_count INTEGER DEFAULT 0,
  metadata_json TEXT
);

CREATE TABLE knowledge_relations (
  id INTEGER PRIMARY KEY,
  subject_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  created_at INTEGER NOT NULL
);

CREATE TABLE email_entities (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  relevance REAL DEFAULT 1.0,
  PRIMARY KEY (account_id, message_id, entity_id)
);

CREATE TABLE ai_pipeline_state (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  stage TEXT NOT NULL,                -- cleaned | embedded | extracted | classified
  status TEXT NOT NULL,               -- pending | done | error | skipped
  updated_at INTEGER NOT NULL,
  error TEXT,
  PRIMARY KEY (account_id, message_id, stage)
);

CREATE TABLE security_audit_events (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);
```

**Reuse existing:** `ai_cache`, `writing_style_profiles`, `classification_id`, `thread_categories`.

### 5.3 Post-sync pipeline

Hook **after** `SyncEngine` applies a folder delta (do not block the poll loop):

```
delta.added / body available
  → enqueue ai_pipeline_state(pending)
  → worker pool (Semaphore, low priority):
       1. Clean HTML → plain text (Rust)
       2. Sensitivity + classification features (rules / L1)
       3. Chunk + embed (if PrivacyMode allows)
       4. Entity extract Person/Org (L1 or L2 per mode)
       5. Optional summary → ai_cache
  → emit ai:pipeline { accountId, messageId, stage, status }
```

**Backpressure:** cap concurrent embeds; on first-sync, only last N days or inbox-only until idle.

### 5.4 Hybrid retrieval (for “ask” and NL search)

```
Query
  → FTS5 (existing search)
  → Vector top-k
  → Entity name match / graph 1-hop
  → merge + light re-rank (recency, contact boost, folder boost)
  → ContextAssembler (token budget, redaction, citations = message ids)
  → return AssembledContext to TS (summaries + snippets, not full raw dump by default)
```

### 5.5 LLM routing

| Tier | Tasks | Examples |
|------|--------|----------|
| **L1 local** | always-on, privacy-critical | classification features, sensitivity, simple extract, offline draft assist |
| **L2 cloud mid** | user-triggered | summary, rewrite, translate, draft, entity extract (if allowed) |
| **L3 cloud top** | rare | multi-step agent, daily briefing synthesis |

**Provider abstraction:** any OpenAI-compatible endpoint (private 千问 / DeepSeek / vLLM) + Ollama + commercial keys. Model-agnostic (Thunderbolt lesson).

### 5.6 Context assembly boundary

Example: user asks “Find and summarize mail with 张三 about Q4 budget.”

```
1. [TS]  invoke('ai_assemble_context', { query, … })
2. [Rust]
   a. query embedding
   b. vector + FTS + entity hybrid search
   c. token budget + redaction under PrivacyMode
   d. return AssembledContext {
        system_prompt, relevant_emails (summaries/snippets),
        entity_context, user_prefs, token_budget, citations[]
      }
3. [TS]  streamText / generateText with AI SDK
4. [TS]  invoke cache / store result as needed
```

Rust never needs to own streaming UX; TS never assembles unredacted mailbox dumps for cloud calls.

---

## 6. Interaction plane

### 6.1 Three UI modes (coexist)

| Mode | Components | First ship |
|------|------------|------------|
| Traditional + AI chips | priority/classification, thread summary strip, security chips | P0–P1 |
| Conversational | right tool window / drawer AI panel, NL search bar | P3 |
| Ambient | briefing card on launch, status “AI indexing…”, sensitivity toast | P3–P4 |

Do **not** remove Outlook three-pane UX.

### 6.2 Composer AI

From `Composer_AI_Inline_Design.md`:

| Mode | UX | Backend |
|------|-----|---------|
| Ghost text | Tab accept / Esc dismiss | L1/L2 short completion; debounce ~300ms; requestId discard |
| Inline chat | select → rewrite / formalize / translate | stream into decoration then apply |
| Slash commands | `/summary` `/agenda` `/reply` | templates + context assembler |

Context for compose: draft before cursor + thread + recipients + user style + **classification level** + sensitivity warnings.

### 6.3 Agent tools (HITL)

Phase P6 tools (execute in Rust, confirm in UI for mutations):

| Tool | Effect | Confirm? |
|------|--------|----------|
| `search_emails` | hybrid search | No |
| `get_thread_context` | load thread | No |
| `find_person` | knowledge + contacts | No |
| `summarize_thread` | L2 + cache | No |
| `draft_reply` | open composer with body | Soft |
| `apply_classification` | write classification | Soft |
| `move_thread` / `archive` | mutation | **Yes** |
| `send_email` | send | **Always Yes** — MVP may omit tool entirely |

Use AG-UI-like events for run/tool/text so the chat UI stays protocol-shaped without CopilotKit:

```typescript
type AIEvent =
  | { type: 'run:started'; runId: string }
  | { type: 'run:finished'; runId: string }
  | { type: 'run:error'; runId: string; error: string }
  | { type: 'text:start'; messageId: string }
  | { type: 'text:delta'; messageId: string; content: string }
  | { type: 'text:end'; messageId: string }
  | { type: 'tool:start'; toolName: string; args: unknown }
  | { type: 'tool:result'; toolName: string; result: unknown }
  | { type: 'state:snapshot'; data: unknown }
  | { type: 'state:delta'; path: string; value: unknown };
```

### 6.4 Generative UI (controlled mode only)

Agent returns component name + props; frontend maps to React components. No open-ended HTML generation.

```rust
struct AgentResponse {
    text: String,
    components: Vec<GeneratedUI>,  // EmailSummaryCard, CommitmentTracker, …
    actions: Vec<SuggestedAction>,
}
```

---

## 7. Module layout (on current monorepo)

### 7.1 Backend (`kylins.client.backend/src/`)

```
ai/
  mod.rs
  privacy_gate.rs          # PrivacyMode, redaction, allow/deny cloud
  embedding.rs
  vector_store.rs          # sqlite-vec / later lancedb
  context.rs               # ContextAssembler + token budget
  prompts/                 # minijinja templates
  pipeline.rs              # post-sync worker
  classification_ai.rs     # suggest classification_id
  sensitivity.rs           # pre-send scanner

knowledge/
  entities.rs
  relations.rs
  extract.rs               # LLM/rules extraction → SQLite

security/                  # extend beyond secret encrypt
  audit.rs
  # existing crypto.rs stays for secret encryption;
  # new crypto/ for S/MIME etc. per crypto design

# existing stays:
sync_engine/  db/  mail/  eas/  oauth/
```

**New / extended IPC (examples):**

| Command | Purpose |
|---------|---------|
| `ai_assemble_context` | Hybrid retrieval + redacted prompt payload |
| `ai_semantic_search` | Ranked hits with citations |
| `ai_pipeline_status` | Per-account / message pipeline progress |
| `ai_store_result` | Persist cache / side effects (or extend `db_*` ai_cache) |
| `security_scan_draft` | Pre-send sensitivity scan |
| `security_suggest_classification` | Classification suggestion |
| `crypto_*` | Later: sign / encrypt / decrypt / verify |

**Events:** `ai:pipeline`, `ai:index-progress`, `security:alert` (plus existing `sync:*`).

### 7.2 Frontend (`kylins.client.frontend/src/`)

```
features/ai/
  providers/               # AI SDK provider factory
  assistant/               # chat panel, event reducer
  search/                  # NL search UX
  tools/                   # tool defs → invoke

features/composer/         # existing +
  plugins/aiGhostText.ts
  plugins/aiInlineChat.ts

features/classification/   # existing — wire AI suggestions

services/ai/               # replace stubs: real providers via AI SDK
stores/aiStore.ts          # run state, privacy mode mirror, pipeline progress
```

### 7.3 Preferences surface

**Preferences → Security / AI**

- Privacy mode
- Provider + API keys / base URL (private deploy)
- Ollama endpoint + models
- Ingest: embed on/off, extract on/off, classify on/off
- Encrypted-mail AI opt-in
- Pre-send sensitivity: warn / block

---

## 8. End-to-end flows

### 8.1 Summarize this thread

```
UI → invoke assemble_context(threadId, task=summary)
Rust: load messages → clean → budget → AssembledContext
TS: streamText(L2) → ReadingPane summary card
TS → cache via db_cache_ai_result / ai_store_result
```

### 8.2 NL search: “Q4 budget with 张三”

```
UI → ai_semantic_search(query)
Rust: hybrid FTS + vector + entity → ranked hits with citations
UI: results panel or filtered list; optional L2 answer with citations
```

### 8.3 Send classified email

```
Composer Send
  → security_scan_draft (local)
  → if hits: modal (edit / override with reason)
  → classification required if policy says so
  → optional crypto_encrypt/sign
  → existing send queue (SMTP/EAS)
  → audit event if override
```

### 8.4 Background: new mail

```
SyncEngine delta → pipeline enqueue
  → embed / classify / extract under PrivacyMode
  → uiStore / StatusBar progress
  → optional: high classification → stronger notification policy
```

---

## 9. Phased delivery plan

| Phase | Duration (indicative) | Deliverables | Success criteria |
|-------|----------------------|--------------|------------------|
| **P0 Security AI surface** | 2–3 w | Wire classification suggest (rules), pre-send sensitivity, PrivacyMode setting, audit stub | Can warn on secrets/PII; classification UI live |
| **P1 AI foundation** | 3–4 w | AI SDK providers, assemble_context IPC, streaming summary on thread, replace provider stubs | Summary works online + Ollama offline |
| **P2 Ingest** | 4–6 w | Pipeline, embeddings, FTS+vector search, Person/Org extract | NL search beats FTS alone on sample corpus |
| **P3 Interaction** | 4–5 w | AI panel, composer ghost + rewrite, citation UX | Daily use without leaving list/composer |
| **P4 Memory + Ambient** | 4–6 w | Commitments, relation queries, Daily Briefing | “Who is X / open commitments” works |
| **P5 Crypto** | 6–10 w | S/MIME provider, decrypt path + AI policy | Sign/encrypt interoperable; AI respects policy |
| **P6 Agent + sources** | ongoing | HITL tools; Graph/Gmail adapters | Multi-step search+draft with confirms |

**Do not** start P6 before P1–P2: agents without a semantic index are expensive chatbots.

---

## 10. Non-goals (MVP)

- Silent auto-reply / auto-send
- Full 5-layer memory / CozoDB
- Training on user mail
- Central server that sees mailbox content
- Replacing Coremail / Exchange server
- Perfect multi-hop knowledge graph reasoning

---

## 11. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| First sync AI storm | Time-window backfill, semaphore, inbox-first |
| Cost explosion | L1 for bulk; cache; user-triggered L2/L3 only in Balanced |
| Hallucinated security advice | Rules-first sensitivity; LLM as secondary; always show evidence |
| Hallucinated mail facts | Citations mandatory; quote snippets |
| Cross-compile / native AI crates | Start with sqlite-vec + optional fastembed; isolate feature flags |
| Trust failure on one bad send | No send tool; sensitivity block modes; classification watermark |
| Doc drift | This document + Memory hybrid split are canonical for AI/security; update `docs/architecture.md` when implementing |

---

## 12. Stack summary

| Layer | Stack |
|-------|--------|
| Shell | Tauri 2.10, Windows / macOS first (Linux / 信创 later) |
| Mail | Existing: async-imap, lettre, EAS/WBXML, SyncEngine, sqlx SQLite |
| Security | AES secrets (existing), classification UI (existing), S/MIME→PGP→SM (planned), PrivacyGate, sensitivity |
| AI data | ammonia/html2text, fastembed, vector in SQLite→LanceDB, knowledge tables, pipeline |
| AI chat | Vercel AI SDK, OpenAI-compatible + Ollama + private base URL |
| UI | React 19, Zustand, Tailwind 4, React Aria, Tiptap, virtual lists |
| Extensibility | Plugin slots for extra AI cards; AI modules reusable across Mail / Calendar / Tasks |

---

## 13. One-paragraph summary

Build **Security AI on the send/view path** and **Semantic AI on the sync path**, with **Rust as the privacy and data gate** and **TypeScript as the streaming/agent surface**, using a **3-layer memory model** and **HITL-only agents**. Sequence so classification, sensitivity, summary, and semantic search ship before knowledge graphs and crypto E2EE — those become differentiators once the core loop (ingest → understand → assist → protect-on-send) is trustworthy.

---

## 14. Next engineering artifacts

When implementation starts, produce in order:

1. **P0–P1 PR plan** — migrations, IPC contracts, test plan, feature flags  
2. **IPC OpenAPI-style table** — command names, payloads, error codes  
3. **Update** `docs/architecture.md` and `CLAUDE.md` so they no longer describe AI as frontend-only stubs once P1 lands  

---

## Changelog

| Date | Change |
|------|--------|
| 2026-07-09 | Initial canonical proposal from design-doc synthesis + live codebase review |

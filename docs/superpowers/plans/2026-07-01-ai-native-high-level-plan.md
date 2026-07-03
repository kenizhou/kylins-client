# AI-Native Client — High-Level Plan

> **Status:** Approved (2026-07-01). This is the **high-level** roadmap synthesized from the six `docs/design/` docs + a code audit. Each phase (A0/A1/B/C/D/S) will get its own detailed SDD plan before execution. The locked decisions in §"Key decisions" resolve conflicts between the source design docs.

## Context

`docs/design/` holds a six-doc vision for turning Kylins from an email client into an **AI-native** one (AI in the data-write path, AI as a default interaction surface, UI organized around semantics not folders). An audit of the current code confirms the gap analysis doc is accurate: the codebase is **"email-client-complete, AI-virgin."**

**Built:** mail engine (IMAP/EAS sync, IDLE, offline replay), TipTap composer, manual security classification, basic contacts, and the DB schema for AI features (`ai_cache`, `bundle_rules`, `smart_folders`, `follow_up_reminders`, `thread_categories`, `writing_style_profiles`).

**Stub or absent (the entire AI surface):** the OpenAI/Ollama providers are `TODO` returning `''` (`services/ai/providers/{ollama,openai}Provider.ts`); no Rust LLM router, no embeddings, no vector store, no entity graph, no memory layers, no composer AI (the toolbar `AI` button exists but `Composer` never passes `onToggleAiAssist`), no smart-folder/bundle/triage logic, no AI settings model.

This plan is the high-level roadmap to close that gap, sequenced for early user-visible value.

## Key decisions (locked, resolve doc conflicts)

1. **LLM call layer — Hybrid.** Rust owns every call that touches email plaintext (LLM router, embeddings, entity extraction, thread summarization, post-sync pipeline) — plaintext never crosses Tauri IPC, matching the Gap Analysis privacy stance. The **TypeScript Vercel AI SDK** is used *only* for the composer ghost-text / inline-rewrite path, where sub-100ms streaming and ProseMirror decoration integration justify a JS-side `streamText` (per the Composer-AI doc). Streaming from Rust surfaces via a new `ai:streaming` Tauri event.
2. **Entity graph — SQLite, not CozoDB.** `Memory_System_Design.md` (the more recent doc) rejects CozoDB in favor of SQLite tables + recursive CTEs. Adopt that for the MVP; revisit a graph DB only if query complexity demands it.
3. **Vector store — LanceDB** (Rust-native embedded). Embeddings via `fastembed-rs` (BGE-small, local) + optional OpenAI `text-embedding-3-small` (cloud), routed by privacy mode.
4. **Three-tier LLM routing with privacy mode** (`LocalOnly` / `Balanced` / `Performance`): L1 local Ollama (Qwen2.5 / Phi-3-mini), L2 cloud mid (GPT-4o-mini / Haiku / Flash), L3 cloud flagship. Every call: 30s timeout, exponential-backoff retry, fallback down the tier.
5. **Classification = hybrid** (industry best practice): Tier-1 deterministic rules (~60%, <1ms) + Tier-2 LLM JSON-schema (~40%) + local-model fallback. Replaces today's manual-only classification.
6. **UI stance — embed, don't float.** Context Side Panel + Ctrl+K + Daily Briefing + smart notifications (Shortwave/Superhuman patterns). **No** floating "sad chat bubble," **no** full CopilotKit framework, **no** auto-send/delete without explicit approval.

## Reused existing pieces (don't rebuild)

- `services/ai/aiService.ts` — real cache-through pattern + streaming `chat()`; swap the stub `_provider` for a real Rust-backed provider.
- `ai_cache` table + `db_get_cached_ai_result` / `db_cache_ai_result` commands — already production-ready.
- Composer (`components/composer/Composer.tsx` + `features/composer/editorExtensions.ts`) — full TipTap; add a ProseMirror AI decoration plugin.
- `EditorToolbar.tsx` — `onToggleAiAssist` / `aiAssistOpen` props already declared; wire them.
- `db::contacts` + the schema-only `bundle_rules` / `smart_folders` / `follow_up_reminders` tables — ready to power entity extraction, bundling, snooze.
- Post-sync hook point: the SyncEngine's per-message apply path (`db::messages::apply_folder_delta` / `request_bodies_inner`) is where a future AI post-sync pipeline latches on.

## Roadmap (quick-wins-first)

**Phase A0 — AI foundation (unblocks everything)**
- Rust `ai/` crate: `router.rs` (three-tier + privacy mode + fallback), `providers/` (async-openai for cloud, Ollama HTTP for local), `prompt_manager.rs` (minijinja templates), `tiktoken-rs` token budgeting. Streaming via `ai:streaming` Tauri event.
- AI settings: provider/model/endpoint/API-key/privacy-mode — stored via existing settings KV + `crypto::encrypt` for secrets; Preferences UI panel.
- Wire `aiService` to real Rust commands (replace stub providers).

**Phase A1 — first user-visible AI**
- One-click **thread summarization** (reuses `aiService.summarize` + `ai_cache`; "Summarize" button in ReadingPane header → streaming card).
- **Composer AI assist** (the Hybrid TS path): draft-from-prompt, tone rewrite (formal/friendly/concise), translate — Vercel AI SDK `streamText` + Rust `ai_assemble_compose_context` for the prompt. Wire `EditorToolbar`'s AI button + an inline panel.

**Phase B — memory & semantic layer**
- `fastembed-rs` embedding service + LanceDB store + **post-sync embedding pipeline** (email → HTML-clean (ammonia) → chunk → embed → store), with `tokio::Semaphore` backpressure.
- **Entity extraction** (rules + LLM) → SQLite entity graph (Person/Org/Project/Commitment/Topic + relationships) seeded from `db::contacts`.
- **Semantic + hybrid search** ("emails about Q4 budget with ABC Corp") — Shortwave-style 5-stage retrieval (reformulate → feature-extract → vector → heuristic rerank → cross-encoder rerank), exposed via Ctrl+K.

**Phase C — interaction & ambient**
- **Ambient Awareness Loop (elevate from feature → pillar).** Not one-off briefings, but a *continuous* background pass that surfaces: threads that went quiet without resolution (the "quiet-thread" pattern), commitments nearing due dates, people who owe you a reply. Drives the Daily Briefing + smart notifications below; refreshes on a schedule and on sync events. Human-at-the-lever for all actions — output is notification/flag only, never auto-send/delete (locked decision #6). Made explicit (was previously implicit) after studying Anthropic's Claude Tag Ambient Mode.
- **Context Side Panel** (ReadingPane, context-aware, AG-UI lifecycle/tool/text events; Controlled-Mode generative UI).
- **Daily Briefing** (needs-attention / since-last-night / waiting-on / drafts-ready / inbox-health) at startup — rendered output of the Ambient Awareness Loop.
- **Smart notifications** (Critical/Important/FYI triage) wired into the existing `send_desktop_notification` + the 3g notification dedupe/DND.
- Spin up the schema-only **smart folders / bundle delivery** engine.

**Phase D — agent & proactive**
- Agent tool-use loop (`search_emails`, `find_person`, `schedule_followup`, …) with max-steps safety + human-at-the-lever approval.
- **Agent self-scheduling (made explicit).** Beyond passive tool-use: the agent schedules its own future work ("draft the Monday weekly digest", "re-ping this thread if unanswered in 3 days", "re-summarize this long thread on Friday"). A self-queue + scheduled-trigger mechanism; all outputs are drafts/notifications, never autonomous sends. Inspired by Claude Tag's async-long-task / self-scheduled-work mode (was previously implicit).
- **Commitment tracking** + proactive cards ("you promised to reply 3 days ago"), AI prioritization scoring on the message list.

**Phase S — security / email crypto (parallel track; spec at `docs/superpowers/specs/2026-06-29-crypto-system-design.md`)**
- *Built (keep):* at-rest AES-256-GCM for OAuth tokens / IMAP passwords via OS keyring (`crypto.rs`).
- *S/MIME (Phase 1 of the spec):* `src/crypto/smime/` — CMS/PKCS#7 via RustCrypto `cms`; PKCS#11 hardware-token path (raw RSA: SHA-256→DigestInfo→token→sig); AES-256 session key → RSA-per-recipient → CMS EnvelopedData; streaming for large attachments. X.509 cert store + per-account provider selection (`CryptoProvider` / `KeyStore` traits).
- *Stop the lie (do FIRST, before S/MIME):* `services/composer/send.ts` currently IGNORES `isEncrypted`/`isSigned` — the composer toggles + Confidential/Restricted classification set them, but `buildRawEmail` emits plain MIME, so the app silently sends plaintext for an email the user marked "Encrypt." Add a **fail-closed guard**: a pure `validateCryptoFlags({isEncrypted,isSigned}) -> string|null` helper + a check in `sendEmail` (return `success:false`) AND an early check in `Composer.handleSend` (toast via `useToastStore.push(msg,'error')` + `return` before the undo timer starts). Unit-test the helper. Until a provider exists, ANY encrypt/sign request is refused with an actionable message.
- *Wire the stub (when S/MIME lands):* replace the guard's "no provider" branch with real sign/encrypt between draft finalize and MIME build; detect S/MIME on inbound during the post-sync MIME parse and set `messages.is_encrypted`/`is_signed` (always 0 today). Reading-pane shows lock/seal icons once the columns are real.
- *PGP (Phase 2)* and *SM2/SM3/SM4 (Phase 3, HK-government national crypto)* after S/MIME.
- *Quick wins (do anytime):* (1) confirm the live renderer is `EmailRenderer` (`sandbox="allow-same-origin"`, no `allow-scripts` + DOMPurify — the velo-approved config) and that the regressed `SafeHtmlFrame.tsx` `sandbox=""` is not on a reachable path (or fix it); (2) classification is **labeling-only** (no DRM/access-control) — keep calling it that so nobody mistakes the banners for cryptographic protection.

**Deferred (documented, not in MVP):** Tantivy (FTS5 adequate for now), CozoDB/KuzuDB, PGP + SM2/3/4 (after S/MIME), full document parsing (pdf/docx/xlsx) for attachment AI, persisted notification dedupe.

## Verification (per phase)

- **A0/A1:** `cargo test --lib` (router routing table, prompt assembly, token budget) + frontend `tsc`/`vitest` (settings panel, aiService wiring). Manual: configure Ollama or an OpenAI key → summarize a real thread; compose with tone-rewrite. Confirm plaintext never appears in a non-Rust log.
- **B:** embedding round-trip + semantic-search recall test on a seeded corpus; entity-extraction precision test on fixture emails; `cargo clippy --all-targets`.
- **C/D:** manual e2e (Daily Briefing renders, side-panel answers cite real threads, smart-notification triage, agent executes an approved multi-step action).
- **S:** S/MIME round-trip (sign+encrypt outbound → decrypt+verify inbound with a test cert pair); PKCS#11 sign path against a real token or a soft-token; confirm `is_encrypted`/`is_signed` flip on a real signed/encrypted inbound; `cargo test --lib` for the CMS/PKCS#7 helpers; confirm no plaintext email body crosses Tauri IPC.

## Notes

- **Depth:** this is intentionally high-level. Each phase will get its own detailed SDD plan (per-task implementer + review) before execution, grounded in the corresponding `docs/design/` doc.
- **Source docs:** `AI_Native_design.md` (vision), `AI_Native_Gap_Analysis.md` (gap + roadmap), `AI_UI_Industry_Research.md` (UX patterns + AG-UI), `Memory_System_Design.md` (3-layer memory, SQLite graph), `Composer_AI_Inline_Design.md` (ghost-text/inline/palette), `Competitor_AI_Research.md` (Shortwave/Superhuman takeaways). Crypto spec: `docs/superpowers/specs/2026-06-29-crypto-system-design.md`.

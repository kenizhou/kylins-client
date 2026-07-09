# Thunderbird Desktop vs. Kylins Client — Source-Level Gap Analysis

*Generated 2026-07-09 from a source-code walk of Thunderbird Desktop (`D:\Projects\mailclient\opensource\thunderbird-desktop`, TB 154.0a1) and Kylins (`D:\Projects\mailclient\kylins`, branch `a11y-contrast-touch-targets`).*

---

## 1. Executive Summary

**Thunderbird Desktop** is a full Mozilla-platform email suite: a C++/JS/Rust mail/news/calendar/address-book stack running on Necko sockets, NSS crypto, SQLite/Mork storage, Gloda full-text search, and WebExtension-style add-ons.

**Kylins** is a Tauri v2 + React/TypeScript desktop client whose backend is far more advanced than the original high-level report suggested. It already has a real IMAP/EAS/SMTP sync engine, a comprehensive SQLite schema, FTS5 search, an offline mutation queue, and a polished Outlook-style UI. The remaining gaps are concentrated in a few high-value areas: **end-to-end encryption**, **Microsoft Graph / Gmail API**, **CalDAV/CardDAV sync**, **EAS mutation completeness**, **OAuth token exchange**, **AI providers**, and **MailExtensions-style extensibility**.

This report focuses on *source-level* differences: files, modules, traits, and concrete TODOs.

---

## 2. Methodology

- Walked Thunderbird source tree under `mailnews/`, `calendar/`, `mailnews/addrbook/`, `mail/extensions/openpgp/`, `mail/components/extensions/`, `mail/components/accountcreation/`, and `rust/`.
- Walked Kylins source tree under `kylins.client.backend/src/` and `kylins.client.frontend/src/`.
- Classified each subsystem as **Implemented**, **Partial**, **Stub/TODO**, or **Missing**.
- Cross-referenced the two trees to highlight exact gaps.

---

## 3. Thunderbird Implementation Reference

### 3.1 Mail/News Core

| Subsystem | Location | Key Files | Notes |
|-----------|----------|-----------|-------|
| **IMAP** | `mailnews/imap/src/` | `nsImapProtocol.cpp/h`, `nsImapServerResponseParser.cpp/h`, `nsImapIncomingServer.cpp/h`, `nsImapMailFolder.cpp/h`, `nsImapService.cpp/h`, `nsAutoSyncManager.cpp`, `nsImapOfflineSync.cpp/h` | C++ state machine on Necko/XPCOM. Supports IDLE, CONDSTORE, RFC 8474 `OBJECTID`, Gmail extensions. Message keys are server UIDs. |
| **POP3** | `mailnews/local/src/` | `Pop3Client.sys.mjs`, `Pop3IncomingServer.sys.mjs`, `Pop3Service.sys.mjs`, `nsPop3Sink.cpp/h` | Modern JS client with `LineReader`. PLAIN, CRAM-MD5, OAuth2. |
| **SMTP / Composition** | `mailnews/compose/src/` | `SmtpClient.sys.mjs`, `SmtpServer.sys.mjs`, `OutgoingServerService.sys.mjs`, `MessageSend.sys.mjs`, `MimeMessage.sys.mjs`, `MimePart.sys.mjs`, `MimeEncoder.sys.mjs`, `nsMsgComposeService.cpp`, `nsMsgSend.cpp` | MIME built in JS, then handed to SMTP or message store. STARTTLS, XOAuth2, DSN. |
| **NNTP** | `mailnews/news/src/` | `NntpClient.sys.mjs`, `NntpIncomingServer.sys.mjs`, `NntpService.sys.mjs`, `nsNewsFolder.cpp/h` | JS client with AUTHINFO, XOVER, newsrc state. |
| **RSS/Feeds** | `mailnews/extensions/newsblog/` | `Feed.sys.mjs`, `FeedItem.sys.mjs`, `FeedParser.sys.mjs`, `FeedUtils.sys.mjs`, `NewsBlog.sys.mjs`, `nsRssIncomingServer.cpp` | Pseudo-incoming-server. Fetches RSS/Atom via HTTP, stores as RFC 5322 messages. |
| **MIME Parsing** | `mailnews/mime/` | `mimeParser.sys.mjs`, `MimeHeaderParser.cpp/h`, `jsmime/jsmime.mjs`, `nsMimeStreamConverter.cpp`, `cthandlers/pgpmime/`, `emitters/nsMimeHtmlEmitter.cpp` | Dual C++/JS stack. `mimeParser.sys.mjs` used by extensions/search; C++ emitters for display. |
| **Folder Storage** | `mailnews/base/src/`, `mailnews/local/src/` | `nsMsgDBFolder.cpp/h`, `nsMsgFolderCache.cpp`, `FolderCompactor.cpp/h`, `nsLocalMailFolder.cpp`, `nsMsgBrkMBoxStore.cpp`, `nsMsgMaildirStore.cpp`, `MboxCompactor.cpp`, `MboxScanner.cpp` | Pluggable `nsIMsgPluggableStore`. Default mbox; maildir opt-in. |
| **Message Database** | `mailnews/db/msgdb/`, `mailnews/db/mork/`, `mailnews/db/panorama/` | `nsMsgDatabase.cpp/h`, `nsMailDatabase.cpp`, `nsImapMailDatabase.cpp`, `nsMsgHdr.cpp`, `nsMsgThread.cpp`, `mailnews/db/mork/`, `mailnews/db/panorama/src/DatabaseCore.cpp` | Per-folder `.msf` files use legacy Mork. **Panorama** is the in-progress global SQLite replacement; compiled in nightly but disabled unless `mail.panorama.enabled`. |
| **Search / Indexing** | `mailnews/search/`, `mailnews/db/gloda/`, `mailnews/extensions/fts3/` | `nsMsgSearchSession.cpp`, `nsMsgSearchTerm.cpp`, `nsMsgSearchAdapter.cpp`, `nsMsgFilterService.cpp`, `nsMsgFilterList.cpp`, `Gloda.sys.mjs`, `GlodaIndexer.sys.mjs`, `GlodaMsgIndexer.sys.mjs`, `nsFts3Tokenizer.cpp` | Message filters in `.sfd`/`.dat`. Quick Filter + virtual folders. Gloda = global SQLite FTS index (`global-messages-db.sqlite`). |
| **Junk Filtering** | `mailnews/extensions/bayesian-spam-filter/` | `nsBayesianFilter.cpp/h` | Token-based Bayesian classifier. Training corpus in `training.dat`. External plug-in interface `nsIMsgFilterPlugin`. |
| **Offline Sync** | `mailnews/base/src/`, `mailnews/imap/src/`, `mailnews/db/msgdb/src/` | `nsMsgOfflineManager.cpp/h`, `nsImapOfflineSync.cpp`, `nsMsgOfflineImapOperation.cpp` | Playback of IMAP ops, download mail/news, send unsent. Offline ops queued in per-folder `.msf`. |

### 3.2 Exchange / EWS / Microsoft Graph

| Layer | Location | Key Files | Notes |
|-------|----------|-----------|-------|
| C++ protocol shell | `mailnews/protocols/exchange/src/` | `ExchangeService.cpp/h`, `ExchangeIncomingServer.cpp/h`, `ExchangeFolder.cpp/h`, `ExchangeMessageSync.cpp`, `ExchangeMessageCreate.cpp`, `IExchangeClient.idl`, `EwsClient.h`, `GraphClient.h` | Implements standard mailnews interfaces; delegates HTTP to Rust behind `IExchangeClient`. |
| Rust EWS | `rust/ews_xpcom/` | `src/lib.rs`, `client.rs`, `client/*.rs` | EWS SOAP: folder hierarchy sync, message sync, create/send, copy/move, mark junk. |
| Rust Graph | `rust/graph_xpcom/`, `rust/ms_graph_tb/` | `graph_xpcom/src/lib.rs`, `client/*.rs`, `ms_graph_tb/src/lib.rs`, `types/*.rs`, `paths/**/*.rs` | REST/JSON client. `ms_graph_tb` is generated from Microsoft OpenAPI spec. **Under heavy development.** |
| Shared infra | `rust/protocol_shared/`, `rust/moz_http/` | `protocol_shared/src/lib.rs`, `moz_http/src/client.rs` | XPCOM helpers, Necko-wrapping HTTP client. |
| OAuth scopes | `mailnews/base/src/` | `OAuth2Providers.sys.mjs` | Defines `EWS_SCOPES` and `GRAPH_SCOPES`. |

**Status:** EWS email shipped in TB 145 (Nov 2025). Graph scaffolding exists in nightly but is not release-ready. Calendar/contacts for Exchange are **not implemented**.

### 3.3 Calendar & Tasks

| Layer | Location | Key Files | Notes |
|-------|----------|-----------|-------|
| Core | `calendar/base/` | `calendar.js`, `src/` provider interfaces, item model, timezone, alarms | `calICalendar` provider architecture. |
| Local storage | `calendar/providers/storage/` | `CalStorageCalendar.sys.mjs`, `CalStorageDatabase.sys.mjs` | Local SQLite backend. |
| CalDAV | `calendar/providers/caldav/` | `CalDavCalendar.sys.mjs`, `CalDavProvider.sys.mjs`, `CalDavRequest.sys.mjs`, `CalDavSession.sys.mjs` | OAuth2, scheduling inbox/outbox, iTIP. |
| ICS | `calendar/providers/ics/` | `CalICSCalendar.sys.mjs` | Remote ICS subscriptions. |
| iCalendar parsing | `third_party/icaljs/` | — | JS iCalendar library. |
| Tasks | `calendar/base/content/` | `calendar-task-tree*.js` | `VTODO` first-class items. |

### 3.4 Address Book

| Layer | Location | Key Files | Notes |
|-------|----------|-----------|-------|
| Manager | `mailnews/addrbook/modules/` | `AddrBookManager.sys.mjs`, `AddrBookDirectory.sys.mjs` | `MailServices.ab`. |
| Local storage | `mailnews/addrbook/modules/` | `SQLiteDirectory.sys.mjs` | `abook.sqlite`, `history.sqlite`. |
| CardDAV | `mailnews/addrbook/modules/` | `CardDAVDirectory.sys.mjs`, `CardDAVUtils.sys.mjs` | Syncs remote vCards over local SQLiteDirectory. |
| LDAP | `mailnews/addrbook/modules/` | `LDAPDirectory.sys.mjs`, `LDAPClient.sys.mjs`, `LDAPConnection.sys.mjs` | Read-only/search-on-server; can replicate locally. |
| vCard | `mailnews/addrbook/modules/` | `VCardUtils.sys.mjs` | vCard 3/4 parse/generate. |
| UI | `mail/components/addrbook/` | `aboutAddressBook.js`, `vcard-edit/*.mjs` | Modern address book UI. |

### 3.5 OpenPGP / S-MIME

| Subsystem | Location | Key Files | Notes |
|-----------|----------|-----------|-------|
| **OpenPGP** | `mail/extensions/openpgp/` | `RNP.sys.mjs`, `RNPLib.sys.mjs`, `decryption.sys.mjs`, `encryption.sys.mjs`, `mimeDecrypt.sys.mjs`, `mimeEncrypt.sys.mjs`, `mimeVerify.sys.mjs`, `keyRing.sys.mjs`, `keyserver.sys.mjs`, `sqliteDb.sys.mjs`, `PgpMimeHandler.sys.mjs` | RNP-based, SQLite keyring. Enabled by default since TB 78.2.1. |
| RNP/Botan libraries | `third_party/rnp/`, `third_party/botan/` | — | Native crypto libraries. |
| External GnuPG | `mail/extensions/openpgp/` | `GPGME.sys.mjs`, `GPGMELib.sys.mjs` | Optional hidden-pref path for smartcards. |
| **S/MIME** | `mailnews/mime/src/` | `mimecms.cpp/h`, `mimemcms.cpp/h`, `mimecryp.cpp/h` | NSS CMS. Certificate manager integration. |

### 3.6 Extensions / MailExtensions

| Layer | Location | Key Files |
|-------|----------|-----------|
| Schemas | `mail/components/extensions/schemas/` | `messages.json`, `folders.json`, `accounts.json`, `compose.json`, `mailTabs.json`, `messageDisplay.json`, `addressBook.json`, `cloudFile.json`, `menus.json`, etc. |
| Parent implementation | `mail/components/extensions/parent/` | `ext-messages.js`, `ext-folders.js`, `ext-accounts.js`, `ext-compose.js`, `ext-addressBook.js`, etc. |
| Helpers | `mail/components/extensions/` | `ExtensionMessages.sys.mjs`, `ExtensionAccounts.sys.mjs`, `ExtensionUtilities.sys.mjs`, `MessagesSendTracker.sys.mjs` |
| Experiment APIs | `mail/components/extensions/annotations/` | `experiments.json`, `schemas/extensionScripts.json` |

### 3.7 Account Setup / Autoconfig

| Layer | Location | Key Files | Notes |
|-------|----------|-----------|-------|
| Account Hub | `mail/components/accountcreation/` | `accountHub.js`, `widgets/email-*.mjs` | New first-run wizard shipped March/April 2026. |
| Autoconfig | `mail/components/accountcreation/modules/` | `FetchConfig.sys.mjs`, `FindConfig.sys.mjs`, `GuessConfig.sys.mjs`, `ExchangeAutoDiscover.sys.mjs`, `ConfigVerifier.sys.mjs`, `CreateInBackend.sys.mjs` | Local XML → `.well-known/autoconfig` → ISP autoconfig subdomain → Mozilla ISPDB. |
| OAuth2 | `mailnews/base/src/` | `OAuth2.sys.mjs`, `OAuth2Module.sys.mjs`, `OAuth2Providers.sys.mjs` | Provider registry + flows. |

### 3.8 Cross-Cutting Infrastructure

| Concern | Location | Notes |
|---------|----------|-------|
| Preferences | `mailnews/base/prefs/content/`, `mail/components/*/content/preferences/` | Standard Mozilla `Services.prefs`. |
| Telemetry | `mail/metrics.yaml`, component `metrics.yaml` files | Mozilla Glean. |
| Localization | `mail/locales/en-US/messenger/`, `calendar/locales/en-US/` | Fluent (`.ftl`) + legacy `.properties`. |
| Themes | `mail/themes/` | CSS custom properties, Fluent icons, density, color schemes; WebExtension `theme` API. |
| Sync | `mail/services/sync/` | Firefox-Account-based sync of accounts, address books, calendars, identities, servers. |

---

## 4. Kylins Implementation Inventory

### 4.1 Backend (Rust)

| File | Status | Notes |
|------|--------|-------|
| `kylins.client.backend/src/lib.rs` | **Implemented** | Tauri v2 builder; registers single-instance, autostart, deep-link, global-shortcut, notification, opener, fs, dialog, http, process, os, log plugins; ~240 IPC commands; `SyncEngine` in Tauri state. |
| `kylins.client.backend/src/commands.rs` | **Implemented** | App commands, IMAP commands, SMTP commands, autostart, notifications, attachment staging. |
| `kylins.client.backend/src/crypto.rs` | **Implemented** | AES-256-GCM; master key in OS keyring; nonce || ciphertext hex-encoded. |
| `kylins.client.backend/src/oauth.rs` | **Partial** | Localhost callback listener + code/state parsing. **No token exchange/refresh.** |

### 4.2 Database Layer

| File | Status | Notes |
|------|--------|-------|
| `kylins.client.backend/migrations/20260627000001_baseline.sql` | **Implemented** | ~30 tables including accounts, labels, threads, messages, message_bodies, attachments, contacts, calendars, events, tasks, pending_operations, local_drafts, settings, signatures, send_as_aliases, scheduled_emails, templates, ai_cache, folder_sync_state, eas_sync_state, contact_sync_state, image_allowlist, FTS5 `message_search`. |
| `kylins.client.backend/src/db/mod.rs` | **Implemented** | `SqlitePool`, WAL, busy timeout, sqlx migrations, `BindValue` helpers. |
| `kylins.client.backend/src/db/accounts.rs` | **Implemented** | CRUD with AES encryption for tokens/passwords. |
| `kylins.client.backend/src/db/messages.rs` | **Implemented** | CRUD, delta apply, snippet, thread derivation, FTS indexing. |
| `kylins.client.backend/src/db/threads.rs` | **Implemented** | Thread CRUD, unread aggregation. |
| `kylins.client.backend/src/db/labels.rs` | **Implemented** | Folder/label CRUD, role resolution, pruning. |
| `kylins.client.backend/src/db/message_bodies.rs` | **Implemented** | Body cache with 2000-row eviction. |
| `kylins.client.backend/src/db/queue.rs` | **Implemented** | `pending_operations` with exponential backoff (`60 * (1 << retry_count)`). |
| `kylins.client.backend/src/db/mutations.rs` | **Implemented** | `MutationOp` enum (Send, MarkRead, SetFlag, Move, Delete, Append). |
| `kylins.client.backend/src/db/sync_state.rs` | **Implemented** | IMAP + EAS cursor state. |
| `kylins.client.backend/src/db/rate_limit.rs` | **Implemented** | Per-account rate-limit windows. |
| `kylins.client.backend/src/db/attachments.rs` | **Implemented** | Attachment metadata + inline image allowlist. |
| `kylins.client.backend/src/db/attachment_cache.rs` | **Implemented** | File-based attachment cache. |
| `kylins.client.backend/src/db/contacts.rs` | **Implemented** | Contact CRUD + header extraction. |
| `kylins.client.backend/src/db/ai_cache.rs` | **Implemented** | AI result cache. |
| `kylins.client.backend/src/db/drafts.rs` | **Implemented** | Local draft CRUD. |
| `kylins.client.backend/src/db/signatures.rs` | **Implemented** | Per-account signatures. |
| `kylins.client.backend/src/db/send_as_aliases.rs` | **Implemented** | Send-as aliases. |
| `kylins.client.backend/src/db/calendars.rs`, `calendar_events.rs` | **Implemented** | Calendar/event CRUD, range queries. |
| `kylins.client.backend/src/db/tasks.rs` | **Implemented** | Tasks + tags. |
| `kylins.client.backend/src/db/search.rs` | **Implemented** | FTS5 message search. |
| `kylins.client.backend/src/db/commands.rs` | **Implemented** | ~80 Tauri command wrappers. |

### 4.3 Mail Providers

| File | Status | Notes |
|------|--------|-------|
| `kylins.client.backend/src/sync_engine/mod.rs` | **Implemented** | `MailSource` trait; factory selects IMAP or EAS. |
| `kylins.client.frontend/src/services/mail/provider.ts` | **Implemented** | Frontend `MailProvider` interface. |
| `kylins.client.frontend/src/services/mail/imapProvider.ts` | **Implemented** | Wraps Rust IMAP commands. |
| `kylins.client.frontend/src/services/mail/easProvider.ts` | **Implemented** | Wraps Rust EAS commands. |
| `kylins.client.backend/src/mail/imap/client.rs` | **Implemented** | ~2900 lines. TLS/STARTTLS/plain, XOAUTH2, headers-only sync, CONDSTORE, SEARCH, MOVE, COPY, APPEND, DELETE, inline CID fetching. |
| `kylins.client.backend/src/mail/imap/types.rs` | **Implemented** | IMAP types. |
| `kylins.client.backend/src/mail/imap/session_manager.rs` | **Implemented** | Persistent session manager with reconnect and SELECT caching. |
| `kylins.client.backend/src/mail/smtp/client.rs` | **Implemented** | `lettre` transport; TLS/STARTTLS/plain; XOAUTH2; `send_raw_email`. |
| `kylins.client.backend/src/mail/smtp/types.rs` | **Implemented** | SMTP types. |
| `kylins.client.backend/src/mail/builder.rs` | **Implemented** | MIME builder using `mail_builder`. |
| `kylins.client.backend/src/mail/address.rs` | **Implemented** | Address parsing helpers. |
| `kylins.client.backend/src/eas/client.rs` | **Implemented** | WBXML client via `reqwest`: FolderSync, Sync, SendMail, SmartForward/Reply, ItemOperations, GetItemEstimate, Ping, Provision, Folder CRUD. |
| `kylins.client.backend/src/eas/wbxml/` | **Implemented** | WBXML serializer/deserializer. |
| `kylins.client.backend/src/eas/commands.rs` | **Implemented** | EAS request/response builders. |
| `kylins.client.backend/src/eas/types.rs` | **Implemented** | EAS types. |
| `kylins.client.backend/src/eas/status.rs` | **Implemented** | Status-code recovery classifier. |
| `kylins.client.backend/src/eas/provision.rs` | **Implemented** | Two-phase Provision handshake. |
| `kylins.client.backend/src/eas/auth.rs` | **Implemented** | OAuth Bearer + Basic auth. |
| `kylins.client.backend/src/eas/autodiscover.rs` | **Partial** | Entry point present; XML/redirect chain stub/TODO. |
| `kylins.client.backend/src/eas/service.rs` | **Implemented** | Tauri command wrappers. |
| `kylins.client.backend/src/sync_engine/imap_source.rs` | **Implemented** | `MailSource` adapter; IDLE watcher with 28-min keepalive. |
| `kylins.client.backend/src/sync_engine/eas_source.rs` | **Partial** | FolderSync, Sync, SendMail, Ping implemented. `fetch_body`, `set_flags`, `move_messages`, `delete_messages`, `append` are NYI. |
| `kylins.client.backend/src/sync_engine/engine.rs` | **Implemented** | Per-account `AccountWorker`, 60 s poll / 300 s IDLE backstop, circuit breaker, replay queue, sync events. |

### 4.4 Sync, Offline, Contacts

| File | Status | Notes |
|------|--------|-------|
| `kylins.client.frontend/src/services/queue/offlineQueue.ts` | **Implemented** | Delegates to Rust `pending_operations`. |
| `kylins.client.backend/src/sync/contacts/source.rs` | **Partial** | Dispatcher to CardDAV / Google People / EAS GAL / vCard. |
| `kylins.client.backend/src/sync/contacts/vcard.rs` | **Implemented** | vCard parse/export. |
| `kylins.client.backend/src/sync/contacts/carddav.rs` | **Stub/TODO** | Placeholder. |
| `kylins.client.backend/src/sync/contacts/google_people.rs` | **Stub/TODO** | Placeholder. |
| `kylins.client.backend/src/sync/contacts/eas_gal.rs` | **Stub/TODO** | Placeholder. |

### 4.5 Crypto / Security

| File | Status | Notes |
|------|--------|-------|
| `kylins.client.backend/src/crypto.rs` | **Implemented** | AES-256-GCM for secrets only. |
| `kylins.client.frontend/src/services/crypto.ts` | **Implemented** | Frontend façade. |
| OpenPGP / S/MIME | **Missing** | No implementation. |

### 4.6 AI Layer

| File | Status | Notes |
|------|--------|-------|
| `kylins.client.frontend/src/services/ai/aiService.ts` | **Implemented** | Caching + `chat`/`summarize` façade. |
| `kylins.client.frontend/src/services/ai/providers/base.ts` | **Implemented** | `LLMProvider` interface. |
| `kylins.client.frontend/src/services/ai/providers/openaiProvider.ts` | **Stub/TODO** | `// TODO: integrate OpenAI SDK`. |
| `kylins.client.frontend/src/services/ai/providers/ollamaProvider.ts` | **Stub/TODO** | Similar placeholder. |

### 4.7 Plugin System

| File | Status | Notes |
|------|--------|-------|
| `kylins.client.frontend/src/services/plugins/pluginManager.ts` | **Implemented** | Singleton registry by role; dynamic `import(/* @vite-ignore */ path)`. |
| `kylins.client.frontend/src/services/plugins/pluginAPI.ts` | **Implemented** | `PluginAPI` interface. |
| `kylins.client.frontend/src/services/plugins/builtInPlugins.ts` | **Implemented** | Activates built-ins. |
| `kylins.client.frontend/plugins/example-plugin/main.ts` | **Implemented** | Minimal example. |
| `kylins.client.frontend/src/components/plugins/InjectedComponent.tsx` | **Implemented** | Slot injection. |

### 4.8 UI / Stores / Theme

| File | Status | Notes |
|------|--------|-------|
| `kylins.client.frontend/src/App.tsx` | **Implemented** | Startup sequence, plugin activation, sync start, compose/viewer pop-outs. |
| `kylins.client.frontend/src/components/layout/AppShell.tsx` | **Implemented** | Outlook-style shell with resizable panes. |
| `kylins.client.frontend/src/components/email/SafeHtmlFrame.tsx` | **Implemented** | Sandboxed iframe + DOMPurify. |
| Zustand stores | **Implemented** | uiStore, accountStore, folderStore, threadStore, composerStore, contactStore, calendarStore, taskStore, preferencesStore, shortcutStore, etc. |
| Theme | **Implemented** | Tailwind v4, CSS variables, 8 skins, light/dark/system. |

### 4.9 Tests

| Stack | Status | Notes |
|-------|--------|-------|
| Rust tests | **Implemented** | sync engine, IMAP/EAS sources, SMTP, EAS client, DB migrations, OAuth parsing. |
| Frontend tests | **Implemented** | Vitest + jsdom + Testing Library across services, stores, db, composer, calendar, shortcuts, plugins. |

---

## 5. Module-by-Module Gap Matrix

| Capability | Thunderbird | Kylins | Gap Severity |
|------------|-------------|--------|--------------|
| **IMAP client** | Full C++ state machine (`mailnews/imap/src/`) | Full Rust client (`src/mail/imap/client.rs`) | ✅ Parity |
| **POP3** | JS client (`mailnews/local/src/Pop3Client.sys.mjs`) | **Missing** | 🔴 High |
| **SMTP** | JS client + C++ send (`mailnews/compose/src/`) | Rust `lettre` client (`src/mail/smtp/client.rs`) | ✅ Near parity |
| **NNTP** | JS client (`mailnews/news/src/`) | **Missing** | 🟡 Medium |
| **RSS/Feeds** | Pseudo-server + parser (`mailnews/extensions/newsblog/`) | **Missing** | 🟡 Medium |
| **Exchange ActiveSync (EAS)** | N/A | Full WBXML client (`src/eas/`) | Kylins-only |
| **Exchange Web Services (EWS)** | Shipped email-only (`rust/ews_xpcom/`, `mailnews/protocols/exchange/`) | **Missing** | 🔴 High |
| **Microsoft Graph API** | In development (`rust/graph_xpcom/`, `rust/ms_graph_tb/`) | **Missing** | 🔴 High |
| **Gmail API** | Uses IMAP | **Missing** | 🟡 Medium |
| **MIME parsing/building** | Dual C++/JS stack (`mailnews/mime/`) | `mail-parser` + `mail-builder` | ✅ Sufficient for now |
| **Message storage** | mbox/maildir + Mork MSF + Panorama SQLite | Single SQLite schema + bodies table | Different architecture; Kylins simpler |
| **Global full-text search** | Gloda FTS3 (`global-messages-db.sqlite`) | FTS5 `message_search` | ✅ Sufficient |
| **Message filters / rules** | `nsMsgFilterService` + `.sfd` files | **Missing** | 🔴 High |
| **Junk mail filtering** | Bayesian filter (`nsBayesianFilter.cpp`) | **Missing** | 🟡 Medium |
| **Offline sync** | Offline manager + IMAP op playback | Replay queue + body cache | 🟡 Partial |
| **OpenPGP** | RNP-based, enabled by default (`mail/extensions/openpgp/`) | **Missing** | 🔴 High |
| **S/MIME** | NSS CMS (`mailnews/mime/src/mimecms.cpp`) | **Missing** | 🔴 High |
| **Smartcards** | External GnuPG path only | **Missing** | 🟡 Medium |
| **Calendar** | Full provider architecture + CalDAV + local SQLite | DB tables only; no sync providers | 🔴 High |
| **Tasks** | `VTODO` first-class | DB tables only | 🟡 Medium |
| **Address Book** | SQLite + CardDAV + LDAP + vCard | SQLite CRUD + vCard parse; CardDAV/LDAP stubs | 🟡 Partial |
| **Account setup / autoconfig** | Account Hub + ISPDB + Autodiscover | Account setup wizard exists; no ISPDB/Autodiscover backend | 🟡 Partial |
| **OAuth2** | Full flow + refresh + provider registry | Callback listener only; **no token exchange/refresh** | 🔴 High |
| **Extensions / add-ons** | WebExtension/MailExtensions with 20+ APIs | Custom slot-based plugin manager | 🟡 Different model |
| **Themes** | CSS + WebExtension `theme` API | Tailwind + CSS variables + 8 skins | ✅ Sufficient |
| **Localization** | Fluent + 65+ languages | Not implemented | 🟡 Medium |
| **Sync across devices** | Firefox Account sync engine | **Missing** | 🟡 Medium |
| **Telemetry** | Glean metrics | **Missing** | 🟢 Low |
| **AI providers** | N/A | Interface + cache; OpenAI/Ollama stubs | 🟡 Medium |

---

## 6. Concrete TODOs / Stubs in Kylins

### High-Impact Stubs

| File | Line / Area | Issue |
|------|-------------|-------|
| `kylins.client.backend/src/oauth.rs` | `TokenExchangeResult` struct only | No token exchange or refresh implementation. |
| `kylins.client.backend/src/sync_engine/eas_source.rs` | `fetch_body` | `EasSource method not yet implemented`. |
| `kylins.client.backend/src/sync_engine/eas_source.rs` | `set_flags` | NYI. |
| `kylins.client.backend/src/sync_engine/eas_source.rs` | `move_messages` | NYI. |
| `kylins.client.backend/src/sync_engine/eas_source.rs` | `delete_messages` | NYI. |
| `kylins.client.backend/src/sync_engine/eas_source.rs` | `append` | NYI. |
| `kylins.client.backend/src/eas/autodiscover.rs` | full file | XML/redirect chain stubbed. |
| `kylins.client.backend/src/sync/contacts/carddav.rs` | full file | Placeholder. |
| `kylins.client.backend/src/sync/contacts/google_people.rs` | full file | Placeholder. |
| `kylins.client.backend/src/sync/contacts/eas_gal.rs` | full file | Placeholder. |
| `kylins.client.frontend/src/services/ai/providers/openaiProvider.ts` | line 11, 16 | `// TODO: integrate OpenAI SDK`, `// TODO: implement`. |
| `kylins.client.frontend/src/services/ai/providers/ollamaProvider.ts` | full file | Empty placeholder. |

### Missing Subsystems (No Files)

- OpenPGP / S-MIME implementation.
- EWS / Microsoft Graph source adapters.
- Gmail API source adapter.
- POP3 source adapter.
- NNTP source adapter.
- RSS feed source adapter.
- Message filters / rules engine.
- Junk mail classifier.
- CalDAV calendar sync provider.
- LDAP address book provider.
- MailExtensions / WebExtension runtime.
- Cross-device sync engine.

---

## 7. Architecture & Dependency Gaps

| Area | Thunderbird Stack | Kylins Stack | Gap |
|------|-------------------|--------------|-----|
| **Crypto** | RNP + Botan + NSS | AES-GCM via Rust `ring`/`aes-gcm` + keyring | Missing OpenPGP/S-MIME libraries (`rnp`, `sequoia-openpgp`, or `openpgp-rs`). |
| **HTTP** | Necko (Mozilla network stack) | `reqwest` + Tauri http plugin | Sufficient; Graph/EWS can be built on `reqwest`. |
| **Storage** | SQLite + Mork + mbox/maildir | SQLite (sqlx) + file cache | Simpler; may not scale to huge mailboxes like Thunderbird's mbox/maildir. |
| **Search** | Gloda FTS3 | FTS5 | Equivalent or better. |
| **UI toolkit** | XUL / Fluent / CSS | React 19 / Tailwind / Radix/Aria | Different but modern. |
| **Extension runtime** | Firefox WebExtensions + TB schemas | Custom dynamic-import plugin manager | No compatibility with MailExtensions. |
| **Build system** | `mach` / `moz.build` | Cargo + Vite | Kylins is much lighter to build. |

---

## 8. Recommendations / Open Questions

1. **Exchange strategy** — Thunderbird shipped EWS first and is now building Graph because of the October 2026 EWS deprecation. Kylins has EAS today. Should Kylins skip EWS and go straight to **Microsoft Graph**, or implement EWS as a stopgap?
2. **OAuth completion** — `kylins.client.backend/src/oauth.rs` needs token exchange, refresh-token storage, and token refresh before any OAuth provider (Gmail, Outlook, Graph) is usable end-to-end.
3. **EAS completeness** — The EAS source adapter needs `fetch_body`, `set_flags`, `move_messages`, `delete_messages`, and `append` to be a full mail source.
4. **Encryption stack** — Decide between RNP (Thunderbird-compatible, C++ bindings), Sequoia PGP (Rust-native), or OpenPGP.js (JS, easier in Tauri webview). S/MIME will require NSS or `rustls` + CMS crate.
5. **CalDAV/CardDAV** — Use existing DB tables but add real DAV sync providers. Consider `caldav` / `carddav` Rust crates or build on `reqwest` + `icalendar` / `vCard` parsers.
6. **Extensions** — Decide whether to evolve the slot-based plugin manager toward WebExtension compatibility (high effort, high ecosystem value) or keep it custom (lower effort, smaller ecosystem).
7. **Filters / junk** — These can be layered on top of the existing sync engine and SQLite schema; start with simple SQLite-backed filters and a token-based Bayes classifier.

---

## 9. Bottom Line

Kylins is far more than a skeleton: it has a working IMAP/SMTP/EAS sync engine, a solid SQLite/FTS5 backend, a polished React UI, and good test coverage. The remaining work is not “build everything from scratch” but rather **close specific high-value gaps**:

1. Complete OAuth token exchange/refresh.
2. Finish EAS mutations (or pivot to Graph/EWS).
3. Add Microsoft Graph and/or EWS source adapter.
4. Implement OpenPGP and S/MIME.
5. Implement CalDAV/CardDAV sync.
6. Add message filters/rules and junk filtering.
7. Fill AI provider stubs.

Everything else (POP3, NNTP, RSS, MailExtensions, sync, localization) is important but secondary to becoming a viable daily-driver replacement.

---

## 10. Sources

- Local source trees:
  - `D:\Projects\mailclient\opensource\thunderbird-desktop`
  - `D:\Projects\mailclient\kylins`
- Web sources from the earlier deep-research pass:
  - [Thunderbird Desktop Roadmap](https://roadmaps.thunderbird.net/en-US/desktop/)
  - [Thunderbird Blog — Native Exchange Support](https://blog.thunderbird.net/2025/11/thunderbird-adds-native-microsoft-exchange-email-support/)
  - [Thunderbird Monthly Dev Digest — June 2026](https://blog.thunderbird.net/2026/06/thunderbird-monthly-development-digest-june-2026/)
  - [OpenPGP in Thunderbird — Mozilla Support](https://support.mozilla.org/en-US/kb/openpgp-thunderbird)
  - [Thunderbird:OpenPGP — MozillaWiki](https://wiki.mozilla.org/Thunderbird:OpenPGP)
  - [Supported Standards — Thunderbird](https://developer.thunderbird.net/planning/standards-status)
  - [Thunderbird Add-ons / MailExtensions](https://developer.thunderbird.net/add-ons/about-add-ons)

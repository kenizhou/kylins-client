# Comparative Architecture Report: Thunderbird Desktop, Mailspring, and Kylins Client

> Scope: architecture, technology stack, mail-sync mechanism, protocol support, plugin/extension model, data storage, security, and implementation approach.  
> Prepared for the Kylins Client team to inform build-vs-borrow decisions and roadmap prioritization.  
> Date: 2026-06-27

---

## 1. Executive Summary

| Project | Maturity | Core Stack | Notable Trait |
|---|---|---|---|
| **Thunderbird Desktop** | Mature (20+ years, Mozilla-backed) | Gecko/XPCOM + C++/JS/Rust | Battle-tested, multi-protocol, heavy legacy baggage (Mork, XUL→HTML migration) |
| **Mailspring** | Mature fork of Nylas Mail | Electron + React/TS + C++ `mailsync` (MailCore2) | Polished UI, package-based plugins, proprietary metadata cloud sync, security history |
| **Kylins Client** | Early implementation / pre-release | **Tauri v2 + Rust + React 19 + TypeScript + SQLite** | Modern lightweight stack, Outlook-inspired UI, custom Rust EAS/WBXML codec, still wiring the sync engine |

**Bottom line for Kylins:**
- **Architecture bet is sound**: Tauri + Rust + SQLite is materially lighter than Electron or Gecko and matches the current generation of desktop-mail clients (e.g., Velo).
- **Protocol coverage has a Microsoft-shaped gap**: Thunderbird just shipped native EWS (2025), Mailspring has no Exchange support, and Kylins has a custom EAS implementation but no EWS/Graph fallback. Microsoft is deprecating EWS for Exchange Online in 2026 and EAS/basic-auth is increasingly restricted, so a **Microsoft Graph provider should be a near-term priority**.
- **Sync engine is the biggest remaining risk**: Rust IMAP/EAS clients exist, but the frontend scheduler, delta sync, background polling/IDLE, and offline mutation replay are not fully wired.
- **Plugins are powerful but currently trusted**: Like Mailspring, Kylins loads plugins with full frontend power via dynamic `import()`. Before shipping third-party plugins, add a capability/permission model or run untrusted plugins in an isolated context.

---

## 2. Project Context & Scope

- **Thunderbird Desktop** (`D:\Projects\mailclient\opensource\thunderbird-desktop`) — full Mozilla/Gecko-based mail, address book, calendar, and chat suite.
- **Mailspring** (`D:\Projects\mailclient\opensource\Mailspring`) — Electron-based client with a closed-source C++ sync engine (`mailsync`) and an open-source UI/plugin layer.
- **Kylins Client** (`D:\Projects\mailclient\kylins-client`) — Tauri v2 desktop email client (codename `mailclient`), targeting an Outlook-like experience with AI-native features and Exchange ActiveSync support.

The report focuses on the **mail client subsystems**; calendar/contact/chat features are covered only where they intersect with mail architecture.

---

## 3. Technology Stack Comparison

| Layer | Thunderbird | Mailspring | Kylins Client |
|---|---|---|---|
| **Desktop shell** | Mozilla Gecko (same as Firefox) | Electron 41 + Node | **Tauri v2 + WebView2/WKWebView/WebKitGTK** |
| **UI framework** | Custom elements / XUL → HTML | React 17 + LESS | **React 19 + Tailwind CSS v4 + React Aria Components** |
| **Primary languages** | C++, JavaScript (ES modules / `.sys.mjs`), Rust, Python (build) | TypeScript (UI), C++11 (sync) | **TypeScript (frontend), Rust (backend)** |
| **Build system** | Mozilla `mach` + `moz.build` | Custom Node build (`app/build/build.js`) | **Vite 7 + Cargo + `tauri-build`** |
| **State management** | Redux Toolkit (per document) | Reflux (Flux) + observable queries | **Zustand 5** |
| **Rich text composer** | ProseMirror-based | Forked Slate | **Tiptap v3 / ProseMirror** |
| **Mail parsing** | Internal MIME + libmime | MailCore2 / libetpan | **`mail-parser` (Rust), `async-imap`, `lettre`** |
| **HTTP / EAS transport** | Necko / Rust EWS client | libcurl inside MailCore2 | **`reqwest` + custom WBXML codec** |
| **Crypto/security** | RNP (OpenPGP), NSS (S/MIME), OAuth2 module | Electron `safeStorage` / OS keychain | **AES-256-GCM + OS keyring (`keyring` crate)** |
| **Testing** | Mochitest, XPCShell, GTest, Taskcluster | Jasmine 2, Playwright, GitHub Actions | **Vitest 4 + jsdom + Testing Library** |
| **Bundle size baseline** | Very large (full browser engine) | ~150 MB Electron runtime | **~5 MB Tauri binary target** |

### Observations
- Kylins inherits Velo’s proven Tauri stack and is the only one of the three built directly on Rust+WebView, giving it a smaller footprint than both Thunderbird and Mailspring.
- Thunderbird’s build system is the heaviest: it must be built as a `comm/` subtree inside the Firefox repository.
- Mailspring’s C++ sync engine is decoupled from the Electron UI, which resembles Kylins’s Rust-backend/TS-frontend split, but Mailsync communicates over stdin/stdout JSON lines rather than Tauri IPC.

---

## 4. High-Level Architecture

### 4.1 Thunderbird — Gecko/XPCOM layered stack

```
UI (HTML/XUL custom elements, Redux Toolkit)
        │
MailGlue / MessengerContentHandler
        │
Message Service ── URL ── Channel ── Incoming Server ── Protocol/Connection
        │                                                    │
   nsIMsgFolder ── nsIMsgDatabase ── Message Store (mbox/maildir)
        │
   Gloda / SQLite global search
```

Key abstraction layers (from `source-docs.thunderbird.net`):

| Layer | Interface | Responsibility |
|---|---|---|
| Message Service | `nsIMsgMessageService` | Protocol-agnostic API for opening/sending messages |
| URL | `nsIMsgMailNewsUrl` | Describes the operation per protocol |
| Channel | `nsIChannel` | Async request ferry between service and server |
| Incoming Server | `nsIMsgIncomingServer` | Server connection info + connection pool |
| Protocol | `nsIMsgProtocol` / `nsImapProtocol` | Socket-level I/O, runs on its own thread |
| Folder | `nsIMsgFolder` | Storage abstraction for one folder |
| Database | `nsIMsgDatabase` | Headers/metadata per folder |
| Message Store | `nsIMsgPluggableStore` | Raw message content (mbox or maildir) |

Thunderbird is transitioning away from XPCOM where possible (“DeCOMtamination”) and replacing Mork per-folder databases with a new global SQLite store called **Panorama** (`mailnews/db/panorama/`), currently nightly-only.

### 4.2 Mailspring — Electron UI + C++ sync worker

```
Electron Main Process
├── Window mgmt, auto-update, protocol handlers
└── Spawns one mailsync child process per account

Renderer Process (per window)
├── AppEnv singleton (config, packages, themes)
├── PackageManager / Plugin registries
├── Flux: Actions → Stores → React
├── DatabaseStore (read-only SQLite)
└── MailsyncBridge (IPC to mailsync via stdin/stdout JSON)

mailsync (C++11, MailCore2)
├── IMAP/SMTP/Gmail/Office365/Exchange sync
├── Emits DatabaseChangeRecord JSON deltas
└── Executes Tasks (send, move, label, etc.)
```

- **Process model**: one `mailsync` process per account; killed/restarted on errors.
- **Concurrency**: two-thread, two-connection design — a background worker iterates folders, a foreground worker idles on the primary folder.
- **Writes**: UI never writes SQLite directly; it serializes `Task` objects and sends them to `mailsync` via stdin.

### 4.3 Kylins Client — Tauri three-layer data flow

```
Tauri Desktop Shell (Rust)
├── system tray, notifications, global shortcuts, deep links, updater
├── AES-256-GCM crypto via OS keyring
└── SQLite connection via tauri-plugin-sql

Rust Backend
├── IMAP client  (async-imap + tokio-native-tls)   ──┐
├── SMTP client  (lettre)                            ├── IPC invoke()
├── EAS client   (reqwest + custom WBXML codec)     ──┘
└── OAuth helpers (PKCE localhost redirect)

React 19 Frontend
├── Plugin system (dynamic import, slot injection)
├── Service layer (accounts, settings, crypto, queue, AI)
├── MailProvider abstraction (IMAP, EAS, planned Gmail/Graph)
├── Zustand stores (account, thread, folder, composer, …)
└── Outlook-style UI (AppShell, FolderPane, MessageList, ReadingPane)
```

Key files:
- `kylins.client.backend/src/lib.rs` — Tauri builder + plugin registration
- `kylins.client.backend/src/commands.rs` — IPC command dispatch
- `kylins.client.backend/src/mail/imap/client.rs` — full IMAP client
- `kylins.client.backend/src/mail/smtp/client.rs` — SMTP sender
- `kylins.client.backend/src/eas/` — EAS HTTP/WBXML client
- `kylins.client.frontend/src/services/mail/provider.ts` — `MailProvider` interface
- `kylins.client.frontend/src/services/mail/imapProvider.ts` — IMAP provider wrapper
- `kylins.client.frontend/src/services/mail/easProvider.ts` — EAS provider wrapper

### Architecture comparison table

| Aspect | Thunderbird | Mailspring | Kylins |
|---|---|---|---|
| **Process model** | Single process, multi-thread + JS actors | Main + renderer + one C++ worker per account | Single Tauri process + Rust threads |
| **Frontend/backend bridge** | XPCOM / C++ ↔ JS | stdin/stdout JSON lines | Tauri `invoke()` IPC |
| **Protocol abstraction** | Layered XPCOM interfaces | MailCore2 C++ API wrapped in TS models | `MailProvider` TS interface + Rust command wrappers |
| **State style** | Redux per document | Reflux + observable queries | Zustand |
| **Plugin isolation** | Sandboxed WebExtensions + privileged Experiments | No sandbox; plugins have full API | No sandbox currently; dynamic imports |

---

## 5. Protocol Support Matrix

| Protocol | Thunderbird | Mailspring | Kylins Client | Notes |
|---|---|---|---|---|
| **IMAP** | ✅ Native (`mailnews/imap/`) | ✅ Via MailCore2 | ✅ Rust `async-imap` | All three support IDLE, TLS, OAuth2 XOAUTH2. Kylins has raw-TCP fallback. |
| **POP3** | ✅ Native | ✅ Via MailCore2/libetpan | ❌ Not implemented | Kylins architecture targets IMAP-first providers. |
| **SMTP** | ✅ Native (`mailnews/compose/`) | ✅ Via MailCore2 | ✅ Rust `lettre` | Kylins supports TLS/STARTTLS/plain/OAuth2. |
| **EWS (Exchange Web Services)** | ✅ Native since TB 145 (Nov 2025) | ❌ Not supported | ❌ Not implemented | TB EWS is Rust + XPCOM; calendar/contacts not yet. Microsoft deprecates EWS Online in 2026. |
| **EAS (Exchange ActiveSync)** | ❌ Native; via **TbSync** add-on only | ❌ Not supported | ✅ Custom Rust WBXML codec + TS provider | Kylins’s strongest differentiator, but EAS is being restricted by Microsoft. |
| **Microsoft Graph** | 🛠️ In development | ❌ | ❌ Planned future fallback | Kylins architecture doc mentions Graph as future fallback. |
| **Gmail API** | Via OAuth2 for IMAP/CalDAV/CardDAV | Native OAuth + IMAP + X-GM-LABELS | ❌ Not implemented | Kylins has `history_id` in DB schema but no provider file. |
| **CalDAV / CardDAV** | ✅ Native | ❌ Mail only | 🟡 Partial (DB columns + vCard parsing) | Kylins calendar UI exists; EAS calendar backend partially stubbed. |
| **NNTP / RSS / Chat** | ✅ Native | ❌ | ❌ | Thunderbird is a communications suite; others are mail-only. |

### Protocol implementation detail

**Thunderbird**
- Uses a consistent five-layer XPCOM model for IMAP/POP3/NNTP.
- EWS (`mailnews/protocols/exchange/`) is a Rust client exposed through `IExchangeClient.idl`.
- OAuth2 module supports internal (in-app) and external-browser flows; external browser is preferred for security.

**Mailspring**
- All mail protocols go through `mailsync`, built on MailCore2/libetpan.
- Uses `X-GM-LABELS` for Gmail label support.
- Supports Office365 OAuth2 with PKCE.

**Kylins**
- IMAP commands include `test_connection`, `list_folders`, `fetch_messages`, `fetch_message_body`, `set_flags`, `move_messages`, `delete_messages`, `get_folder_status`, `fetch_attachment`, `append_message`, `sync_folder`, `delta_check`.
- EAS commands include `eas_folder_sync`, `eas_sync`, `eas_send_mail`, `eas_smart_forward`, `eas_smart_reply`, `eas_item_operations`, `eas_get_item_estimate`, `eas_ping`, `eas_folder_create/update/delete`, `eas_meeting_response`.

---

## 6. Mail Sync Mechanisms

### 6.1 Thunderbird

- **Per-folder storage**: each folder has a `.msf` (Mork) metadata file; bodies live in mbox/maildir.
- **IMAP sync**: headers cached in `.msf`; bodies downloaded on demand or by folder policy.
- **Delta sync**: optional **CONDSTORE** (RFC 7162) for mod-sequence based updates; **QRESYNC** in development.
- **Offline**: pending operations queued and replayed on reconnect (`nsIMsgOfflineOpsDatabase`).
- **Background**: polling-based IDLE bursts (default ~5 min), not persistent push.
- **Compaction**: deleted messages marked; folder compaction rewrites mbox.

### 6.2 Mailspring

- **Local-first cache**: SQLite `edgehill.db` with WAL mode; bodies split into `MessageBody` table.
- **Delta streaming**: `mailsync` emits `DatabaseChangeRecord` JSON deltas; UI updates reactively.
- **Concurrency**: background worker + foreground worker; two connections per account.
- **Windowing**: fetches full content for roughly the last 3 months; older mail gets headers only.
- **Deduplication**: hashes message headers to generate stable IDs.
- **Crash protection**: `CrashTracker` limits sync-worker restarts; marks account error after 5 crashes in 5 minutes.
- **Writes**: all mutations go to `mailsync` as `Task` objects; renderer DB is read-only.

### 6.3 Kylins Client

- **Target design** (from `docs/architecture.md`): `listFolders()` → `initialSync()` / `deltaSync()` → upsert messages/threads → update FTS5 → save sync token.
- **Current state**:
  - IMAP: `syncFolderBatched`, `deltaCheck`, `fetchNewUids`, `searchAllUids` implemented in Rust and wrapped in TS.
  - EAS: `syncFolder` wrapper performs `FolderSync` + `Sync` with sync key `0`.
  - SQLite schema has `folder_sync_state` (IMAP UIDVALIDITY/UIDNEXT) and `eas_sync_state` tables.
  - **Not yet wired**: a scheduler/poller, IMAP IDLE, EAS Ping, background sync, and full offline mutation replay.

### Sync comparison table

| Aspect | Thunderbird | Mailspring | Kylins |
|---|---|---|---|
| **Local cache format** | Mork + mbox/maildir | SQLite + JSON blobs | SQLite normalized schema |
| **Body strategy** | On-demand / policy | 3-month full, older headers | Planned on-demand/lazy |
| **Delta mechanism** | CONDSTORE/QRESYNC (optional) | JSON deltas from mailsync | `imap_delta_check`, EAS sync keys |
| **Background refresh** | Polling IDLE | Two-connection worker | Not fully implemented |
| **Offline mutations** | Offline ops queue | Task queue to mailsync | `pending_operations` queue exists |
| **Deduplication** | Server UID + folder | Header hash | Planned thread-by-message-ID |

---

## 7. Data Storage Models

### 7.1 Thunderbird

| Data | Store | Format |
|---|---|---|
| Message headers/metadata | Per-folder database | Mork (`.msf`) — being replaced by Panorama SQLite |
| Message bodies | Pluggable message store | mbox (default) or maildir (experimental) |
| Global search index | Gloda | SQLite (`global-messages-db.sqlite`) |
| Contacts | Address book | SQLite (`abook.sqlite`, `history.sqlite`) |
| Calendar | Calendar storage | SQLite + ICS |
| Settings/accounts | Preferences | `prefs.js` / `user.js` |
| Sync data | Firefox Sync (Weave) | Encrypted JSON records (optional) |

### 7.2 Mailspring

| Data | Store | Notes |
|---|---|---|
| Models (Account, Thread, Message, Contact, etc.) | SQLite `edgehill.db` | JSON blob in `data` + queryable column copies |
| Message bodies | `MessageBody` table | `JoinedData` attribute, loaded on demand |
| Search | `ThreadSearch`, `ContactSearch` virtual tables | SQLite FTS5 |
| Settings | `config.json` | JSON, not SQLite |
| Credentials | OS keychain / Electron `safeStorage` | Encrypted blob |
| Tasks / mutations | `Task` table | Serialized and sent to mailsync |

### 7.3 Kylins Client

| Data | Store | Notes |
|---|---|---|
| Accounts, settings | SQLite `mailclient.db` | `accounts`, `settings` tables; secrets encrypted |
| Folders/labels | SQLite | `labels` table with `role`, `source`, `parent_id` |
| Threads/messages | SQLite | `threads`, `messages`; bodies moved to `message_bodies` in migration v34 |
| Message bodies | SQLite | `message_bodies` (Mailspring-style split) |
| Contacts/calendar/tasks | SQLite | `contacts`, `calendar_events`, `tasks`, etc. |
| Search | SQLite FTS5 | `messages_fts`, `events_fts` (trigram tokenizer) |
| AI cache | SQLite | `ai_cache` per account+thread+type |
| Offline queue | SQLite | `pending_operations` with exponential backoff |
| Sync state | SQLite | `folder_sync_state`, `eas_sync_state` |

Kylins has 36 version-tracked migrations (`src/services/db/migrations.ts`) and uses `withTransaction()` to serialize multi-statement writes because the Tauri SQL plugin does not serialize by default.

---

## 8. Plugin / Extension Models

### 8.1 Thunderbird — MailExtensions + Experiments

- **Model**: WebExtensions (Manifest V2/V3) with Thunderbird-specific namespaces (`messenger.*`).
- **APIs**: `accounts`, `addressBooks`, `compose`, `messages`, `messageDisplay`, `mailTabs`, `cloudFile`, `folders`, `spaces`, etc. Schemas live in `mail/components/extensions/schemas/`.
- **Loading**: parent-process scripts (`ext-*.js`) + child-process scripts registered via `ext-mail.json`.
- **Permissions**: granular (`messagesRead`, `accountsRead`, `compose`, etc.).
- **Experiments**: escape hatch with full core access and a single scary permission prompt; used when built-in APIs are insufficient.
- **Security**: sandboxed extension contexts; CSP enforced.

### 8.2 Mailspring — Package-based React injection

- **Package structure**: `package.json` with `engines.mailspring`, `lib/main.ts` exporting `activate()`/`deactivate()`, optional `styles/`, `keymaps/`, `menus/`.
- **Discovery**: `internal_packages/` (51 built-in), user config dir, dev dir, spec fixtures.
- **Registries**:
  - `ComponentRegistry` — inject React components by role/location.
  - `ExtensionRegistry.Composer` / `MessageView` / `ThreadList` / `AccountSidebar`.
  - `CommandRegistry`, `DatabaseObjectRegistry`, etc.
- **DB access**: plugins can only read; writes must go through `Task` objects sent to `mailsync`.
- **Sandboxing**: **none** — plugins have full API access and have caused real security issues (CVE-2023-47479 attack chain partly involved plugins).

### 8.3 Kylins Client — Mailspring-inspired slot system

- **Package structure** (planned in `docs/architecture.md`):
  ```
  my-plugin/
  ├── package.json            # engines.velomail, main
  ├── src/main.ts             # activate(context: PluginContext) / deactivate()
  ├── styles/plugin.css       # auto-injected
  ├── keymaps/plugin.json
  └── settings/schema.ts
  ```
- **Current API** (`src/services/plugins/pluginAPI.ts`):
  ```typescript
  interface PluginAPI {
    registerComponent(role, Component);
    unregisterComponent(role, Component);
    onEvent(event, handler);
    registerAction(id, handler);
    unregisterAction(id);
    registerMessageViewExtension(ext, priority?);
    registerComposerExtension(ext, priority?);
  }
  ```
- **Loading**: `PluginManager.loadPlugins()` scans directories, persists installed paths in `settings`, activates with `import(/* @vite-ignore */ path)`.
- **Slots**: `header:right`, `folder-pane:header`, `reading-pane:footer`, `toolwindow:left`, etc.
- **Current limitation**: no permission manifest, no sandbox, no capability gating. Every plugin runs in the renderer with full frontend/IPC access.

### Plugin comparison table

| Aspect | Thunderbird | Mailspring | Kylins |
|---|---|---|---|
| **Model** | WebExtension + Experiments | npm-like packages | Mailspring-like packages |
| **Sandbox** | ✅ Yes (WebExtensions) | ❌ No | ❌ No yet |
| **Permissions** | Granular + Experiments warning | None | None yet |
| **UI injection** | `compose_action`, `message_display_action` | `ComponentRegistry` roles | `InjectedComponent` slots |
| **DB writes** | Via API only | Via Task objects only | Not defined yet; plugins can call services directly |
| **Built-in examples** | OpenPGP, S/MIME, mailviews | 51 internal packages | `example-plugin/` skeleton |

---

## 9. Security & Privacy

### Thunderbird
- **Encryption**: OpenPGP via RNP; S/MIME via NSS.
- **Auth**: OAuth2 with external-browser option recommended.
- **Extension security**: WebExtensions sandboxed; Experiments bypass.
- **Storage**: profile directory is not encrypted at rest by default.
- **Phishing**: `PhishingDetector.sys.mjs`, Bayesian spam filter.

### Mailspring
- **Credential storage**: OS keychain / Electron `safeStorage`.
- **Privacy promise**: mail credentials and content stay local; only metadata (snooze, read receipts) goes to Mailspring ID cloud.
- **Known issues**: CVE-2023-47479 RCE chain (mXSS + sandboxed iframe bypass + CSP gap + unsafe `nodeIntegration`/`contextIsolation` settings). CSP was hardened but underlying parsing differential was not fully fixed per public analysis.
- **Stable IDs**: header hashing for deduplication and cross-device metadata association.

### Kylins Client
- **Credential encryption**: AES-256-GCM with a master key stored in the OS keyring; nonce prepended and hex-encoded before SQLite storage.
- **HTML rendering**: DOMPurify + sandboxed `<iframe sandbox="">` (no `allow-same-origin`); `target="_blank" rel="noopener noreferrer"` forced on links.
- **Remote images**: blocked by default; per-sender `image_allowlist`.
- **Phishing**: `phishingDetector.ts` + `link_scan_results` cache + allowlist.
- **Auth results**: `auth_results` column for SPF/DKIM/DMARC display.
- **CSP**: `default-src 'self'; connect-src 'self' https:; img-src 'self' data: blob: https:` (dev-broad).
- **Self-signed certs**: `accept_invalid_certs` per-account flag for IMAP/SMTP/EAS.
- **Plugin risk**: dynamic imports currently run with full renderer privileges; needs capability model before third-party distribution.

---

## 10. Development & Testing

| Aspect | Thunderbird | Mailspring | Kylins |
|---|---|---|---|
| **Unit tests** | XPCShell, GTest | Jasmine 2 | Vitest 4 + jsdom |
| **UI/E2E tests** | Mochitest (browser-chrome) | Playwright | Not yet present (architecture doc mentions Playwright) |
| **Mock servers** | Built-in IMAP/POP3/SMTP mocks | Limited | Not yet present |
| **CI** | Taskcluster | GitHub Actions | Not configured yet |
| **Lint/format** | ESLint + clang-format | ESLint + Prettier | ESLint + Prettier + husky |
| **Type-checking** | Part of `mach` build | `tsc --noEmit` | `tsc --noEmit` via `npm run build` |
| **Build complexity** | Very high (Firefox base) | Medium (Electron + C++ binary) | Medium (Rust + Vite) |

Kylins currently relies on mocked `getDb()` and Tauri `invoke()` in unit tests; integration tests for live IMAP/SMTP/EAS exist as a new file (`kylins.client.backend/tests/imap_smtp_integration.rs`) but are not yet part of CI.

---

## 11. Strengths & Weaknesses

### Thunderbird
**Strengths**
- Native support for the widest protocol set, including NNTP, RSS, chat, LDAP.
- Deep OpenPGP/S-MIME integration.
- Mature offline model and huge extension ecosystem.
- New EWS native support and Panorama SQLite migration address long-standing gaps.

**Weaknesses**
- Massive codebase and build system; high contribution barrier.
- Legacy formats (Mork, XUL) still being migrated.
- No native EAS; EWS/Graph support still maturing.
- Resource footprint comparable to a full browser.

### Mailspring
**Strengths**
- Polished, fast Electron UI with a coherent design system.
- Battle-tested C++ sync engine (MailCore2) handles large mailboxes efficiently.
- Rich built-in plugin ecosystem (51 internal packages).
- Excellent cross-provider OAuth onboarding.

**Weaknesses**
- **No Exchange support** (EWS or EAS) — a major enterprise gap.
- Proprietary Mailspring ID cloud dependency for some metadata features.
- Security history (CVE-2023-47479) and permissive plugin model.
- Closed-source `mailsync` binary limits community contributions.

### Kylins Client
**Strengths**
- Modern, lightweight Tauri+Rust stack; smallest resource footprint target.
- Custom EAS implementation fills a gap that Mailspring and Thunderbird lack natively.
- Well-structured provider abstraction, plugin slot system, and AI pipeline scaffolding.
- Strong security defaults for credential encryption and HTML rendering.

**Weaknesses**
- **Pre-release**: high-level sync engine, scheduler, background polling, and offline replay not fully wired.
- **AI providers are stubs** (`OpenAIProvider`, `OllamaProvider`).
- **No Gmail API or Microsoft Graph provider yet** — both are increasingly important.
- **No plugin sandbox**; trusted-plugin model is unsafe for third-party distribution.
- **No CI/E2E** yet.

---

## 12. Recommendations for Kylins Client

### Priority 1 — Critical before beta

1. **Wire the sync engine end-to-end**
   - Implement a `SyncManager` that schedules `ImapProvider.syncFolder` / `EasProvider.syncFolder` per account, respects UIDVALIDITY/EAS sync keys, and persists state in `folder_sync_state` / `eas_sync_state`.
   - Add background polling, IMAP IDLE, and EAS Ping.
   - Integrate the existing `offlineQueue` so mutations replay after reconnect.

2. **Add a Microsoft Graph API provider**
   - Microsoft is deprecating EWS for Exchange Online and restricting EAS/basic-auth. A Graph provider is essential for modern Microsoft 365 accounts.
   - Keep the custom EAS implementation for on-premise Exchange and older servers, but plan Graph as the primary path for M365.

3. **Implement a Gmail API provider**
   - IMAP+XOAuth2 works, but Gmail API gives reliable label/history/draft semantics and avoids IMAP rate limits.
   - Reuse Velo’s `gmailProvider.ts` pattern referenced in `docs/architecture.md`.

### Priority 2 — Important before GA

4. **Replace AI provider stubs**
   - Integrate `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `ollama-ai-provider`, and `@openrouter/ai-sdk-provider` behind the existing `LLMProvider` interface.
   - Implement prompt versioning and per-feature TTL caching (the `ai_cache` table is ready).

5. **Sandbox or capability-gate plugins**
   - Before allowing third-party plugins, add a permission manifest (`permissions` in `package.json`) and restrict `PluginAPI` access accordingly.
   - Consider running untrusted plugins in a Web Worker or iframe with a message-port bridge, or adopt an SES-style Compartment if bundle size permits.

6. **Harden Electron-equivalent attack surface**
   - Tauri is not Electron, but the HTML renderer still parses untrusted mail. Keep DOMPurify updated, tighten CSP (`object-src 'none'`, `media-src` allowlist), and ensure inline reply/forward rendering stays inside the sandboxed iframe.

7. **Finish calendar/contact sync**
   - EAS calendar backend (`easCalendarProvider.ts`) is partially stubbed; wire `eas_sync` for `class: 'Calendar'` in Rust.
   - Implement CalDAV/CardDAV for Google/iCloud/non-Exchange providers.

### Priority 3 — Nice to have / roadmap

8. **Performance optimization**
   - Enable SQLite WAL mode and prepared-statement caching.
   - Add lazy body loading and keyset pagination for message lists (virtualization is already via `@tanstack/react-virtual`).

9. **Testing & CI**
   - Add mock IMAP/SMTP/EAS servers for backend tests.
   - Set up GitHub Actions for `cargo test`, `cargo clippy`, frontend typecheck/lint/test.
   - Add Playwright or Tauri Driver E2E tests for account setup and compose flows.

10. **Cross-device sync (optional)**
    - If you want Kylins to sync settings/snooze/metadata across devices, design an end-to-end encrypted metadata sync from day one — avoid a Mailspring ID-style cloud dependency unless users explicitly opt in.

---

## 13. Sources & References

### Thunderbird
- [Thunderbird Developer — Codebase Overview](https://developer.thunderbird.net/thunderbird-development/codebase-overview)
- [Thunderbird Source Docs — Email Protocols](https://source-docs.thunderbird.net/en/latest/backend/email_protocols.html)
- [Thunderbird Source Docs — Folders](https://source-docs.thunderbird.net/en/latest/backend/folders.html)
- [MailNews Protocols (MDN archive)](https://udn.realityripple.com/docs/Mozilla/Thunderbird/MailNews_protocols)
- [nsIMsgIncomingServer.idl](https://searchfox.org/comm-central/source/mailnews/base/public/nsIMsgIncomingServer.idl)
- [nsIMsgFolder.idl](https://searchfox.org/comm-central/source/mailnews/base/public/nsIMsgFolder.idl)
- [Thunderbird Blog — Native Microsoft Exchange support (Nov 2025)](https://blog.thunderbird.net/2025/11/thunderbird-adds-native-microsoft-exchange-email-support/)
- [BleepingComputer — Thunderbird native Exchange support](https://www.bleepingcomputer.com/news/software/thunderbird-adds-native-support-for-microsoft-exchange-accounts/)
- [Thunderbird MailExtensions Guide](https://developer.thunderbird.net/add-ons/mailextensions)
- [Thunderbird WebExtension API Docs](https://webextension-api.thunderbird.net/en/mv3/)
- [Thunderbird Experiments Guide](https://developer.thunderbird.net/add-ons/mailextensions/experiments)
- [Bug 1747311 — QRESYNC](https://bugzilla.mozilla.org/show_bug.cgi?id=1747311)
- [Bug 1606285 — Mork→SQLite LDAP](https://bugzilla.mozilla.org/show_bug.cgi?id=1606285)
- [Thunderbird/Maildir Wiki](https://wiki.mozilla.org/Thunderbird/Maildir)

### Mailspring
- [Mailspring GitHub](https://github.com/Foundry376/Mailspring)
- [Mailspring-Sync GitHub](https://github.com/Foundry376/Mailspring-Sync)
- [Mailspring Plugin System Architecture](https://github.com/Foundry376/Mailspring/blob/master/PLUGIN_SYSTEM_ARCHITECTURE.md)
- [Mailspring Database Guide](https://foundry376.github.io/Mailspring/guides/Database.html)
- [Mailspring ID FAQ](https://foundry376.zendesk.com/hc/en-us/articles/115003141552-What-is-a-Mailspring-ID-and-why-do-I-need-one)
- [Mailspring Privacy Policy](https://www.getmailspring.com/privacy-policy)
- [SonarSource — Attack chain to compromise Mailspring (CVE-2023-47479)](https://www.sonarsource.com/blog/reply-to-calc-the-attack-chain-to-compromise-mailspring/)
- [Mailspring Community — Major security vulnerabilities](https://community.getmailspring.com/t/major-security-vulnerabilties/9394)

### Kylins Client (local)
- `D:\Projects\mailclient\kylins-client\CLAUDE.md`
- `D:\Projects\mailclient\kylins-client\docs\architecture.md`
- `D:\Projects\mailclient\kylins-client\kylins.client.backend\Cargo.toml`
- `D:\Projects\mailclient\kylins-client\kylins.client.frontend\package.json`
- `D:\Projects\mailclient\kylins-client\kylins.client.frontend\src\services\mail\provider.ts`
- `D:\Projects\mailclient\kylins-client\kylins.client.frontend\src\services\mail\imapProvider.ts`
- `D:\Projects\mailclient\kylins-client\kylins.client.frontend\src\services\mail\easProvider.ts`
- `D:\Projects\mailclient\kylins-client\kylins.client.frontend\src\services\plugins\pluginAPI.ts`
- `D:\Projects\mailclient\kylins-client\kylins.client.frontend\src\services\db\migrations.ts`
- `D:\Projects\mailclient\kylins-client\kylins.client.frontend\src\services\ai\providers\openaiProvider.ts`
- `D:\Projects\mailclient\kylins-client\kylins.client.frontend\src\services\ai\providers\ollamaProvider.ts`
- `D:\Projects\mailclient\kylins-client\kylins.client.frontend\src\services\calendar\easCalendarProvider.ts`

# Thunderbird vs Kylins — Feature Comparison Report

> Generated 2026-07-08 | Sources: Thunderbird source (`comm-central`), Kylins source, web research

## Executive Summary

**Thunderbird** is a 20+ year mature open-source email client built on Mozilla's Gecko/XPCOM platform with ~2M+ lines of C++, JavaScript, and Rust across mail, calendar, chat, address book, newsgroups, RSS, and extensions.

**Kylins** is a young (~Phase 3/4) desktop email client built on **Tauri v2 + React 19 + TypeScript + Rust + SQLite + Zustand**, targeting a modern Outlook-inspired experience with EAS (Exchange ActiveSync) as a first-class protocol alongside IMAP.

**Key differentiator**: Thunderbird is a *complete PIM suite* (mail + calendar + contacts + tasks + chat + RSS + news). Kylins is a *focused mail client* with strong EAS/Exchange support, a modern React UI, and AI ambitions — but is still early in its lifecycle.

---

## 1. Protocol Support

| Protocol | Thunderbird | Kylins | Notes |
|----------|------------|--------|-------|
| **IMAP** | ✅ Full C++ impl (30 files, auto-sync, CONDSTORE, IDLE, offline) | ✅ Full Rust impl (`async-imap`, IDLE, CONDSTORE, QRESYNC, headers-only sync) | Both strong. Kylins Rust impl is more modern. |
| **SMTP** | ✅ Full JS impl (`SmtpClient.sys.mjs`) | ✅ Full Rust impl (`lettre`, TLS, OAuth2) | Both complete. |
| **POP3** | ✅ Full JS impl (`Pop3Client.sys.mjs`) | ❌ Not implemented | Thunderbird supports legacy POP3 accounts. |
| **EAS (Exchange ActiveSync)** | ❌ Not natively supported | ✅ **Full WBXML codec + 11 commands** (FolderSync, Sync, SendMail, Ping, etc.) | **Kylins advantage** — EAS is a first-class protocol with its own WBXML codec. |
| **EWS (Exchange Web Services)** | ✅ Rust + C++ hybrid (`rust/ews_xpcom/` + `mailnews/protocols/exchange/`) | ❌ Not implemented | Thunderbird added native EWS in v115+ via Rust. |
| **Microsoft Graph API** | ✅ Rust impl (`rust/graph_xpcom/` + `rust/ms_graph_tb/`) with type-safe client | ❌ Not implemented (mentioned in architecture risk register) | Thunderbird is ahead on Microsoft 365 integration. |
| **NNTP / Usenet** | ✅ Full JS impl (`NntpClient.sys.mjs`) | ❌ Not present | Newsgroups — not planned for Kylins. |
| **RSS / Atom Feeds** | ✅ Built-in (`mailnews/extensions/newsblog/`) | ❌ Not present | Blog/feed reader — not planned for Kylins. |
| **CardDAV (Contacts)** | ✅ **Native since TB 102** (`CardDAVDirectory` extends `SQLiteDirectory`) | 🔶 **Phase 3 stub** (`sync/contacts/carddav.rs` — one-line stub) | Thunderbird way ahead. |
| **CalDAV (Calendar)** | ✅ Full impl (`calendar/providers/caldav/`, ctag/sync-token, WebDAV-Sync) | ❌ Not implemented | Kylins calendar is local-only. |
| **LDAP** | ✅ Full impl (address completion + directory browsing) | ❌ Not present | Enterprise directory lookups. |
| **MAPI (Windows)** | ✅ Windows MAPI DLL + hook | ❌ Not present | Windows mail integration. |

**Protocol summary**: Thunderbird supports **9 protocols** (IMAP, POP3, SMTP, EWS, Graph, NNTP, RSS, CardDAV, CalDAV, LDAP, MAPI). Kylins supports **3 protocols** (IMAP, SMTP, EAS) — but its EAS implementation is more complete than anything Thunderbird offers for ActiveSync.

---

## 2. Account Types & Setup

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **Account wizard** | Full Account Hub with ISPDB auto-config, Exchange Autodiscover | Full wizard with 6 providers (Gmail, Outlook, M365, Yahoo, IMAP, Exchange) |
| **Auto-configuration** | ✅ ISPDB + local XML configs + provider HTTPS/HTTP autoconfig | ✅ OAuth discovery + manual config |
| **OAuth2** | ✅ Gmail, Outlook, Yahoo, custom providers | ✅ Google + Microsoft PKCE (localhost callback server) |
| **Multiple accounts** | ✅ Unlimited | ✅ Supported |
| **Unified inbox** | ✅ Smart Mailboxes (unified across accounts) | ✅ Thread list (per-account or unified) |
| **Account export (QR)** | ✅ `QRExport.sys.mjs` → mobile setup | ❌ Not implemented |
| **Account color coding** | ✅ `AccountColorUtils.sys.mjs` | ✅ Implicit in UI (favicon/color) |

**Verdict**: Both are solid for account setup. Thunderbird has more provider coverage and auto-config depth. Kylins has a more modern OAuth flow.

---

## 3. Mail Features

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **Three-pane layout** | ✅ Classic (folder pane + thread list + preview) | ✅ Modern (react-resizable-panels) |
| **Message list views** | ✅ Cards View + Table View (new in 140) | ✅ Table-based thread list |
| **Multi-tab interface** | ✅ Tabs for mail, calendar, settings, etc. | ❌ Single-window (pop-out composer/viewer instead) |
| **Virtual folders / Saved searches** | ✅ Full implementation | ❌ Not implemented |
| **Message tags/labels** | ✅ User-definable + colors | 🔶 Classification labels (gov/military focus, not general tagging) |
| **Message filters/rules** | ✅ Full rules engine (auto-apply on receive, periodic, manual) | ❌ Not implemented |
| **Quick filter bar** | ✅ `QuickFilterManager.sys.mjs` — real-time filter toggles | 🔶 Basic search only |
| **Threading** | ✅ Full thread support (by subject, references) | ✅ Thread store with grouping |
| **Offline mode** | ✅ Full offline with auto-sync | ✅ Offline queue with SQLite-backed retry |
| **Message archiving** | ✅ `MessageArchiver.sys.mjs` — batch archiving | 🔶 Move to folder (no dedicated archive) |
| **MDN / Read receipts** | ✅ `mdn/` extension | ❌ Not implemented |
| **Send later** | ✅ Via add-ons or `nsMsgSendLater.cpp` | ✅ Built-in `ScheduleSendDialog` |
| **Templates** | ✅ Per-account folder templates | ✅ Built-in `TemplatePicker` |
| **Signatures** | ✅ Per-identity HTML/plain text | ✅ Per-account with `SignatureEditor` |
| **Send-as aliases** | ✅ Identities per account | ✅ `AliasManager` |
| **Large file linking** | ✅ CloudFile / Filelink providers | ❌ Not implemented |

**Verdict**: Thunderbird is more feature-complete for traditional email workflows (filters, virtual folders, tags, read receipts). Kylins has a solid core with some modern touches (scheduled send, rich composer).

---

## 4. Composer / Editor

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **Rich text (HTML)** | ✅ WYSIWYG editor (Gecko contenteditable) | ✅ **Tiptap** (ProseMirror-based, 49KB component) |
| **Plain text** | ✅ Auto-detect | ✅ Supported |
| **Spell check** | ✅ Multi-language | 🔶 Spell check setting defined, not fully wired |
| **Tables, images, fonts, colors** | ✅ Basic support | ✅ **Extensive** (Tiptap extensions) |
| **Markdown** | Via add-ons | ❌ |
| **Draft auto-save** | ✅ Built-in | ✅ `draftAutoSave.ts` |
| **Attachment handling** | ✅ Open, save, detach | ✅ `AttachmentPicker` |
| **Inline images** | ✅ | ✅ |
| **Classification labels** | ❌ | ✅ **Enterprise-grade** (badges, banners, watermarks, security chips) |
| **Pop-out composer** | ❌ (tabs instead) | ✅ Dedicated window mode |
| **Undo send** | ❌ | ✅ `UndoSendToast` |

**Verdict**: Kylins has a **more modern, extensible composer** via Tiptap. Thunderbird's is mature but based on aging Gecko editor. Kylins also uniquely has enterprise classification markings.

---

## 5. Security & Encryption

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **OpenPGP** | ✅ **Built-in since TB 78** (RNP library, key manager, encrypt/sign/decrypt) | ❌ Not implemented |
| **S/MIME** | ✅ Built-in (X.509 certificates) | ❌ Not implemented |
| **E2E account settings** | ✅ `am-e2e/` — unified PGP + S/MIME config | ❌ Not implemented |
| **PGP Key Expiry Warnings** | ✅ New in v141 (31-day alerts) | ❌ |
| **Junk/Spam filtering** | ✅ **Bayesian filter** (`nsBayesianFilter.cpp`) + SpamAssassin + server-side | ❌ Not implemented |
| **Phishing protection** | ✅ `PhishingDetector.sys.mjs` | ✅ `phishingDetector.ts` (10 heuristic rules) |
| **Remote content blocking** | ✅ Default off (prevents tracking pixels) | ✅ `imageBlocker.ts` (blocks remote images, strips trackers) |
| **Credential encryption** | ✅ Master Password (OS keyring optional) | ✅ **AES-256-GCM + OS keyring** (auto-generated master key) |
| **Antivirus integration** | ✅ Option to quarantine attachments | ❌ |
| **TLS/SSL** | ✅ Full | ✅ Full (IMAP, SMTP, EAS) |
| **Smartcard support** | ✅ Via extensions | ❌ |

**Verdict**: Thunderbird is **dramatically ahead** on email encryption (PGP + S/MIME) and spam filtering. Kylins has only credential-level encryption. This is the **biggest feature gap**.

---

## 6. Search

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **Full-text search** | ✅ **Gloda** (global database, FTS3/4 tokenizers, background indexing, faceted search) | ✅ **SQLite FTS5** with trigram tokenizer |
| **Quick filter** | ✅ Real-time filter toggles (unread, starred, attachment, from, etc.) | ❌ |
| **Advanced search operators** | ✅ `from:`, `to:`, `subject:`, `body:`, date ranges, boolean logic | ❌ (planned: "A richer query parser … is a follow-up") |
| **Saved searches** | ✅ Virtual folders | ❌ |
| **Desktop search integration** | ✅ Windows Search + macOS Spotlight | ❌ |
| **Search across accounts** | ✅ Gloda indexes all messages globally | 🔶 Per-account FTS5 (no global index) |
| **Calendar search** | ✅ Unifinder / event search | 🔶 Basic event list |

**Verdict**: Thunderbird's Gloda search is more mature with faceting, operators, and desktop integration. Kylins has a solid FTS5 foundation but lacks the UX layer.

---

## 7. Calendar

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **Calendar views** | ✅ Month, multi-day (week/day), agenda, today pane, task tree | ✅ Month, week, day, agenda |
| **CalDAV sync** | ✅ Full CalDAV client (ctag, sync-token, WebDAV-Sync) | ❌ Not implemented |
| **ICS/WebDAV** | ✅ Remote ICS file calendar | 🔶 Local ICS parsing via `ical.js` |
| **Local calendar** | ✅ SQLite-backed | ✅ SQLite `calendar_events` table |
| **EAS calendar** | ❌ (EWS calendar on roadmap) | 🔶 **Stub** — `easItemToEvent()` returns null; MS-ASCAL properties not parsed |
| **Event creation** | ✅ Full dialog with recurrence, reminders, attendees, attachments | ✅ `EventCreateModal` |
| **iTIP/iMIP (invitations)** | ✅ Full invitation handling + email delivery | 🔶 RSVP card + ICS reply generation |
| **Free/busy** | ✅ `CalFreeBusyService` | ❌ |
| **Alarms/Reminders** | ✅ Full alarm service with snooze | 🔶 Basic (planned) |
| **Recurrence** | ✅ Full recurrence rules engine | 🔶 ICS `ical-expander` supports RRULE parsing |
| **Calendar print** | ✅ Print view | ❌ |
| **Multiple calendars** | ✅ Composite calendar view across providers | ✅ Multiple calendars supported |
| **EAS GAL** | ❌ | 🔶 Phase 4 stub |

**Verdict**: Thunderbird's calendar is **production-ready with CalDAV sync**. Kylins has a nice UI but EAS calendar data parsing is blocked on Rust-side MS-ASCAL implementation, and there's no CalDAV.

---

## 8. Contacts / Address Book

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **Local contacts** | ✅ SQLite + legacy Mork | ✅ Full CRUD with groups, multiple fields, avatars |
| **CardDAV sync** | ✅ **Native since TB 102** (SQLite cache + bidirectional sync) | 🔶 Phase 3 stub |
| **LDAP directory** | ✅ Full (auto-complete + browsing) | ❌ |
| **macOS Contacts** | ✅ Native integration (`nsAbOSXDirectory.mm`) | ❌ |
| **Windows/Outlook Contacts** | ✅ MAPI + Outlook integration (`nsAbOutlookDirectory.cpp`) | ❌ |
| **Google People API** | Via add-ons | 🔶 Phase 4 stub |
| **EAS GAL** | ❌ | 🔶 Phase 4 stub |
| **vCard** | ✅ vCard-native storage (RFC 6350) since TB 102 | ✅ `vcard.ts` for import/export |
| **LDIF import/export** | ✅ `nsAbLDIFService.cpp` | ❌ |
| **Auto-complete** | ✅ LDAP + local + autoconfig domain | 🔶 Local contacts only |
| **Contact groups** | ✅ Mailing lists | ✅ Group management |
| **Import/Export** | ✅ Multiple formats | ✅ CSV/VCARD |

**Verdict**: Thunderbird has comprehensive contact sync (CardDAV, LDAP, OS-native). Kylins has great local contact management but all remote sync adapters are stubs.

---

## 9. Tasks

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **Task management** | ✅ Via Lightning (integrated with calendar) | ✅ Full UI (Create, List, Detail, toolbar) |
| **Categories** | ✅ Anniversary, Birthday, Business, Calls, etc. | 🔶 Custom tags/labels |
| **Recurrence** | ✅ Full recurrence | ❌ |
| **Calendar integration** | ✅ Tasks appear in calendar | 🔶 Separate view |
| **EAS tasks** | ❌ | 🔶 Not yet (EAS task sync not wired) |
| **AI task extraction** | ❌ | 🔶 **Stub** — keyword heuristics, not real AI |

**Verdict**: Thunderbird tasks are mature and integrated with calendar. Kylins has a modern task UI independent of calendar. AI task extraction is a planned differentiator but still a stub.

---

## 10. Chat / Instant Messaging

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **IRC** | ✅ Full JS impl | ❌ |
| **XMPP (Jabber)** | ✅ Full JS impl | ❌ |
| **Matrix** | ✅ Native since TB 102 | ❌ |
| **OTR Encryption** | ✅ `OTR.sys.mjs` (libotr) | ❌ |
| **Chat logging** | ✅ JSON logs indexed by Gloda | ❌ |
| **Chat UI** | ✅ Conversation browser + themes (Adium-compatible) | ❌ |
| **Unified contacts** | ✅ `imIContact` — one person across networks | ❌ |

**Verdict**: Thunderbird integrates full chat with 3 active protocols + OTR encryption. Kylins has **zero chat capability**. This is an intentional scope difference — Kylins is a mail client, not a PIM suite.

---

## 11. RSS / News

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **RSS/Atom reader** | ✅ Built-in feed subscriptions + parsing | ❌ |
| **NNTP / Usenet** | ✅ Full newsreader | ❌ |

**Verdict**: Thunderbird includes RSS and NNTP. Kylins does not (intentionally out of scope).

---

## 12. Plugin / Extension System

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **Extension API** | ✅ **WebExtensions + MailExtensions** (27 APIs, MV2 + MV3 support) | 🔶 Custom PluginManager (slot injection + message/composer extensions) |
| **Component slots** | ✅ Spaces toolbar, compose actions, message display actions, cloudFile | ✅ `InjectedComponent` / `InjectedComponentSet` (header, folder-pane, reading-pane, toolwindow) |
| **Theme support** | ✅ Full static + dynamic themes (WebExtensions `theme` API) | 🔶 CSS variable theming (light/dark/system + accent skins) |
| **Add-on ecosystem** | ✅ 1000+ add-ons on ATN | ❌ None (2 built-in plugins only) |
| **Manifest V3** | ✅ Supported since TB 128 | N/A (custom system) |
| **Experiment APIs** | ✅ Direct access to internal XPCOM | N/A |
| **Built-in add-ons** | ✅ Shipped with Thunderbird | ✅ 2 built-in plugins (TaskActionButton, TaskThreadSidebar) |

**Verdict**: Thunderbird has a **massive, standardized extension ecosystem** with 1000+ add-ons. Kylins has a well-designed plugin infrastructure but it's unused except for 2 internal plugins. Thunderbird's extension API is a key competitive moat.

---

## 13. UI & Customization

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **UI framework** | Gecko/XUL → HTML migration (custom elements) | ✅ React 19 + Tailwind CSS v4 |
| **Theme system** | ✅ Dark/Light/Auto + add-on themes | ✅ CSS custom properties + light/dark/system + skin palettes |
| **Density** | ✅ Compact/Normal/Touch | ✅ `UIDensity` setting |
| **Font customization** | ✅ Full interface + message fonts | ✅ Settings (UI fonts configurable) |
| **Toolbar customization** | ✅ Unified Toolbar (flexible) | 🔶 Ribbon-style toolbar (Outlook-inspired) |
| **Spaces toolbar** | ✅ App-level navigation (Mail, Calendar, Chat, AB) | ✅ Left/right ToolWindowBars |
| **i18n / Localization** | ✅ 65 languages (Fluent) | 🔶 English only currently |
| **Accessibility** | ✅ Extensive ARIA + screen reader support | 🔶 Active branch (`a11y-contrast-touch-targets`) — work in progress |
| **Dark message mode** | ✅ Adaptive dark rendering (new in 140) | 🔶 Theme-based only |

**Verdict**: Thunderbird has broader customization, localization, and accessibility. Kylins has a more modern React/Tailwind stack that's easier to develop for but less mature.

---

## 14. Backend / Storage

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **Mail store** | ✅ mbox (default) + Maildir (experimental) | ✅ SQLite (`messages` table with BLOB body) |
| **Metadata DB** | ✅ Mork (legacy) → SQLite (MozStorage) | ✅ SQLite (via `sqlx`, 37 tables, FTS5, migrations) |
| **Sync engine** | ✅ Per-protocol auto-sync + offline managers | ✅ **Centralized sync engine** (`engine.rs` 145KB) with delta sync, mutation replay, rate limiting, circuit breaker |
| **Offline queue** | ✅ Protocol-specific | ✅ **SQLite-backed with exponential backoff** (`offlineQueue.ts`) |
| **Database migrations** | ✅ MozStorage schema management | ✅ **Version-tracked SQL migrations** (`migrations.ts`) |
| **Attachment storage** | ✅ MIME parts in mbox | ✅ SQLite `attachments` table |

**Verdict**: Kylins has a more modern, centralized sync architecture with SQLite as the sole storage layer. Thunderbird carries legacy (Mork, mbox) but is more battle-tested with decades of edge cases.

---

## 15. AI / Smart Features

| Feature | Thunderbird | Kylins |
|---------|------------|--------|
| **AI assistant** | 🔶 Planned (Thunderbird Pro) | 🔶 **Stub** — `AIService` with cache, OpenAI + Ollama providers are TODO |
| **Summarize** | ❌ | 🔶 Planned |
| **Categorize / classify** | ❌ | 🔶 Planned |
| **Smart reply** | ❌ | 🔶 Planned |
| **Smart compose** | ❌ | ❌ |
| **Task extraction** | ❌ | 🔶 Placeholder (keyword heuristics) |
| **AI cache** | ❌ | ✅ SQLite `ai_cache` table |

**Verdict**: Neither has functional AI yet. Kylins has more AI infrastructure laid down (cache, service abstraction, provider stubs) but no real integration. Thunderbird Pro services (Thundermail, Appointment, Send) are in early stages.

---

## 16. Platform & Architecture

| Aspect | Thunderbird | Kylins |
|--------|------------|--------|
| **Platform** | Mozilla Gecko (Firefox platform) | Tauri v2 (Rust + webview) |
| **Frontend** | XUL → HTML custom elements + JS ESMs | React 19 + TypeScript + Vite |
| **Backend language** | C++ (majority) + JavaScript + Rust (growing) | Rust (Tauri commands + business logic) |
| **IPC model** | XPCOM (in-process) | Tauri `invoke()` (IPC across process boundary) |
| **Storage** | MozStorage (SQLite) + mbox files | SQLite (sqlx) |
| **Build system** | Mozilla `mach` + `moz.build` + Cargo | Vite + Cargo |
| **Codebase age** | 20+ years | ~1-2 years |
| **Lines of code** | ~2M+ | ~100K (rough estimate) |
| **Contributors** | 300+ core contributors | Small team |
| **Desktop platforms** | Windows, macOS, Linux, FreeBSD | Windows, macOS, Linux |
| **Mobile** | Android (K-9 Mail rebranded), iOS (in dev) | None |

---

## 17. Gap Analysis: What Kylins Should Prioritize

### Critical Gaps (Missing from Kylins, Present in Thunderbird)

| Gap | Priority | Effort | Notes |
|-----|----------|--------|-------|
| **Email encryption (PGP/SMIME)** | 🔴 High | Large | Biggest security gap. Entirely absent. |
| **Spam filtering** | 🔴 High | Large | No spam detection whatsoever. |
| **Message filters/rules** | 🟡 Medium | Large | Auto-sort, auto-tag, auto-delete on receive. |
| **CalDAV contact sync** | 🟡 Medium | Medium | Phase 3 stub needs implementation. |
| **CardDAV contact sync** | 🟡 Medium | Medium | Phase 3 stub needs implementation. |
| **Advanced search operators** | 🟡 Medium | Medium | from:/is:/since: parser planned but not built. |
| **Virtual folders / Saved searches** | 🟡 Medium | Medium | Search folders across accounts. |
| **POP3 support** | 🟢 Low | Medium | Legacy, but some enterprises need it. |
| **RSS feeds** | 🟢 Low | Medium | May be out of scope for the project. |
| **Chat/IM** | 🟢 Low | Large | Likely out of scope — Kylins is a mail client. |

### Kylins Advantages Over Thunderbird

| Advantage | Significance |
|-----------|-------------|
| **EAS first-class support** | Kylins has the most complete EAS implementation outside of Outlook. Thunderbird has zero EAS. |
| **Modern React UI** | React 19 + Tailwind + Tiptap is more maintainable and extensible than Gecko/XUL. |
| **Centralized sync engine** | Cohesive Rust sync engine with delta sync, mutation replay, and circuit breaking. Thunderbird has per-protocol sync code. |
| **SQLite-only storage** | No legacy formats (Mork, mbox). Clean, modern, queryable storage. |
| **Enterprise classification** | Built-in sensitivity labels (gov/military). Not present in Thunderbird. |
| **Tauri advantage** | Smaller binary, per-process isolation, modern Rust ecosystem. |
| **Clean architecture** | 1-2 years of technical debt vs 20+ years in Thunderbird. |

### Features at Parity

- IMAP/SMTP email (both solid)
- OAuth2 (both solid, Kylins has nicer PKCE flow)
- Three-pane layout
- Calendar UI (Kylins UI is nicer, Thunderbird data sync is real)
- Contacts UI (Kylins UI is nicer, Thunderbird sync is real)
- Tasks UI
- Drafts, templates, signatures, aliases
- Desktop notifications
- Offline support
- Theme system (light/dark)
- Keyboard shortcuts

---

## 18. Key Architectural Differences

### Component Model
- **Thunderbird**: XPCOM (in-process, language-agnostic interface definition in IDL)
- **Kylins**: Tauri IPC (process boundary, JSON-serialized command invocations)

### Protocol Implementation
- **Thunderbird**: Protocol-specific classes implementing `nsIMsgProtocol` + `nsIChannel`. Each protocol (IMAP, POP3, NNTP, EWS) has its own folder, service, and server classes.
- **Kylins**: Centralized Rust sync engine with protocol-specific "sources" (`ImapSource`, `EasSource`) that plug into a unified `SyncEngine`.

### UI Architecture
- **Thunderbird**: Mozilla custom elements + ES modules, XUL→HTML migration in progress
- **Kylins**: React component tree + Zustand stores, single-page app pattern

### Extension Model
- **Thunderbird**: Standardized WebExtensions API (27 APIs) with 1000+ add-on ecosystem
- **Kylins**: Custom slot-based injection model (simpler, no ecosystem)

### Storage Strategy
- **Thunderbird**: Mixed (mbox files for mail, SQLite for metadata, Mork legacy)
- **Kylins**: Pure SQLite (messages, metadata, FTS5, everything in one database)

### Rust Adoption
- **Thunderbird**: Growing Rust use (EWS, Graph API, HTTP, system tray — 11 crates in workspace)
- **Kylins**: Rust-first backend (all mail logic, sync engine, crypto, DB — pure Rust core)

---

## 19. Recommendations

### Short-term (Phase 3/4 completion)
1. **Finish EAS calendar parsing** — unblock `easItemToEvent()` by implementing MS-ASCAL property deserialization
2. **Implement CardDAV adapter** — replace the Phase 3 stub with actual CardDAV sync
3. **Add advanced search operators** — build the `from:/is:/since:` query parser
4. **Wire up at least one AI provider** — make OpenAI or Ollama functional

### Medium-term (differentiation)
1. **Add OpenPGP encryption** — this is the biggest missing security feature; consider integrating the `rnp` crate (same library Thunderbird uses, already in `third_party/rnp/`)
2. **Build the plugin ecosystem** — ship 3-5 real plugins, document the API, attract developers
3. **Add spam filtering** — start with a simple Bayesian classifier
4. **Implement message filters/rules** — auto-sort on receive

### Long-term (competitive position)
1. **Microsoft Graph API support** — for Microsoft 365 customers who are moving off EWS
2. **Mobile companion app** — Thunderbird is here with Android/iOS
3. **CalDAV calendar sync** — complete the calendar story beyond EAS

---

## Sources

- Thunderbird source code: `D:\Projects\mailclient\opensource\thunderbird-desktop\`
- Kylins source code: `D:\Projects\mailclient\kylins\`
- [Thunderbird Developer Docs](https://developer.thunderbird.net)
- [Thunderbird Code Layout (Mozilla Wiki)](https://wiki.mozilla.org/Thunderbird:Code_Layout)
- [Thunderbird Email Protocol Architecture](https://source-docs.thunderbird.net/en/latest/architecture/email_protocols.html)
- [Thunderbird Chat Core Protocols](https://developer.thunderbird.net/thunderbird-development/codebase-overview/chat/chat-core-protocols)
- [Thunderbird Address Book Architecture](https://developer.thunderbird.net/thunderbird-development/codebase-overview/address-book)
- [Thunderbird WebExtensions API](https://developer.thunderbird.net/add-ons/mailextensions/supported-webextension-api)
- [Thunderbird Blog — Release Announcements](https://blog.thunderbird.net)
- [Thunderbird 140 Eclipse Release](https://blog.thunderbird.net/2025/07/welcome-to-thunderbird-140-eclipse/)
- [Thunderbird Native Exchange Support](https://blog.thunderbird.net/2025/11/thunderbird-adds-native-microsoft-exchange-email-support/)
- [Heise: Thunderbird Exchange Rust Implementation](https://www.heise.de/en/news/Sicherheit-und-Performance-Thunderbird-stellt-Exchange-Mail-auf-Rust-um-9696086.html)

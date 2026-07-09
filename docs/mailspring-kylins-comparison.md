# Mailspring vs Kylins — Feature Comparison Report

> Generated 2026-07-08 | Sources: Mailspring source (`app/src/`, `app/internal_packages/`), web research, Kylins codebase analysis

## Executive Summary

**Mailspring** (v1.22.0, ~10 years old) is an open-source (GPLv3) desktop email client built on **Electron + TypeScript + React 17 + Flux**, with a separate **C++ sync engine** (Mailspring-Sync, based on Mailcore2). It pioneered a **plugin-everything architecture** where even core features are installable/removable packages, with 51 built-in plugins and ~30 community themes. It runs on macOS, Windows, and Linux.

**Kylins** (~1-2 years old) is a **Tauri v2 + React 19 + Rust + SQLite** desktop mail client with EAS (Exchange ActiveSync) as a first-class protocol, a centralized Rust sync engine, and an Outlook-inspired UI.

**Key differentiator**: Mailspring is a **mature, feature-rich IMAP client with a plugin ecosystem and Pro-tier monetization**. Kylins is an **EAS-first, modern-stack mail client with enterprise classification** but fewer end-user features and no plugin ecosystem.

---

## 1. Architecture & Platform

| Aspect | Mailspring | Kylins |
|--------|-----------|--------|
| **Platform** | Electron 41 + Node.js | Tauri v2 (Rust + webview) |
| **Frontend** | React 17 + TypeScript 5.7 + LESS | React 19 + TypeScript + Tailwind CSS v4 |
| **State management** | Flux (Reflux) + RxJS | Zustand |
| **Build** | `electron ./app` + `node app/build/build.js` | Vite + Cargo |
| **Backend language** | C++ (separate sync engine binary) | Rust (integrated in-process) |
| **IPC model** | Electron IPC (main ↔ renderer) | Tauri `invoke()` (JSON commands) |
| **Sync engine** | Separate C++ process (Mailspring-Sync / Mailcore2) per account, communicates via stdin/stdout JSON | Integrated Rust `SyncEngine` in-process |
| **Database** | SQLite via `better-sqlite3` (read-only in Electron; writes only by sync engine) | SQLite via `sqlx` (both read/write from Rust backend) |
| **Rich text editor** | Slate (custom fork, React 17 era) | Tiptap (ProseMirror-based, React 19) |
| **Desktop platforms** | macOS, Windows, Linux | Windows, macOS, Linux |
| **Mobile** | None | None |
| **Codebase age** | ~10 years (forked from Nylas Mail) | ~1-2 years |
| **LOC estimate** | ~150K TypeScript + separate C++ sync engine | ~100K Rust + TypeScript |
| **Localization** | **102 locales** (JSON-based, varying completeness) | English only |

**Verdict**: Mailspring is Electron-based (larger binary, more RAM) but has a proven architecture. Kylins is Tauri-based (smaller binary, per-process isolation) and has a more modern stack. Mailspring's localization to 102 locales is a **massive advantage** over Kylins' English-only status.

---

## 2. Protocol Support

| Protocol | Mailspring | Kylins |
|----------|-----------|--------|
| **IMAP** | ✅ Full via C++ Mailspring-Sync (Mailcore2) | ✅ Full Rust impl (`async-imap`, IDLE, CONDSTORE) |
| **SMTP** | ✅ Full via C++ Mailspring-Sync (Mailcore2) | ✅ Full Rust impl (`lettre`, TLS, OAuth2) |
| **EAS (Exchange ActiveSync)** | ❌ Not supported | ✅ **Full WBXML codec + 11 commands** (FolderSync, Sync, SendMail, Ping, etc.) |
| **EWS (Exchange Web Services)** | ❌ Not supported | ❌ Not implemented |
| **Microsoft Graph API** | ❌ Not supported | ❌ Not implemented (mentioned in architecture risk register) |
| **POP3** | ✅ Via Mailcore2 | ❌ Not implemented |
| **Gmail API** | ✅ Gmail-specific labels, categories (via sync engine) | 🔶 IMAP-based Gmail (Gmail API provider planned) |
| **Office 365 / Outlook.com** | ✅ Full support via IMAP/SMTP | ✅ OAuth2 + IMAP/SMTP |
| **Yahoo** | ✅ Full support | ✅ OAuth2 + IMAP/SMTP |
| **iCloud** | ✅ Full support | ❌ (not configured) |
| **OAuth 2.0** | ✅ Gmail, Outlook, Yahoo, custom | ✅ Google + Microsoft PKCE |
| **CardDAV** | ❌ Not built-in (sync engine handles contacts locally) | 🔶 Phase 3 stub |
| **CalDAV** | ❌ Not built-in (calendar is local/ICS) | ❌ Not implemented |
| **LDAP** | ❌ Not supported | ❌ Not present |
| **RSS/NNTP/Chat** | ❌ None | ❌ None |

**Verdict**: Mailspring supports more providers (iCloud, POP3, Gmail labels) through Mailcore2's broad IMAP dialect coverage. Kylins uniquely supports EAS. Neither has EWS, Graph API, or CalDAV.

---

## 3. Account Setup & Management

| Feature | Mailspring | Kylins |
|---------|-----------|--------|
| **Account wizard** | ✅ Built-in (Gmail, Outlook, Office 365, Yahoo, iCloud, IMAP) | ✅ Full wizard with 6 providers |
| **Auto-configuration** | ✅ ISP detection via sync engine | ✅ OAuth discovery + manual config |
| **OAuth2** | ✅ Multiple providers | ✅ Google + Microsoft PKCE |
| **Multiple accounts** | ✅ Unlimited, unified or separate | ✅ Supported |
| **Unified inbox** | ✅ Core feature ("All Accounts" view) | ✅ Thread list (per-account or unified) |
| **Account identity management** | ✅ Per-identity settings, signatures, aliases | ✅ Per-account with signatures + aliases |
| **Account sidebar** | ✅ `account-sidebar` plugin with color bars | 🔶 Folder pane with account grouping |
| **Outlook account fix** | ✅ Fixed in v1.22.0 | ✅ Working OAuth |

**Verdict**: Roughly at parity. Mailspring supports more providers (iCloud) and has a more mature unified inbox. Kylins' OAuth setup is more modern (PKCE).

---

## 4. Email Organization & Workflow

| Feature | Mailspring | Kylins |
|---------|-----------|--------|
| **Thread list** | ✅ `thread-list` plugin (table, columns, quick actions) | ✅ Thread store with grouping |
| **Message view** | ✅ `message-list` plugin (HTML rendering, sidebars) | ✅ `EmailRenderer`, `SafeHtmlFrame` |
| **Three-pane layout** | ✅ Traditional (folders / thread list / message) | ✅ Modern (react-resizable-panels) |
| **Reading pane** | ✅ Off / Horizontal / Vertical (radio buttons) | ✅ Always visible in layout |
| **Tags / Labels** | ✅ Gmail-style `category-mapper` + `category-picker` (important, inbox, sent, drafts, spam, trash) | 🔶 Classification labels (government/military focus, not general tagging) |
| **Folder management** | ✅ Full CRUD via sync engine | ✅ Full CRUD |
| **Favorites / Starred** | ✅ `ChangeStarredTask` | ✅ Starred messages |
| **Archiving** | ✅ Archive button per thread | ✅ Move to folder |
| **Snooze** | ✅ **`thread-snooze` plugin** — pick time, hide from inbox, return later (Pro feature) | ❌ Not implemented |
| **Send Later** | ✅ **`send-later` plugin** — schedule for future date/time | ✅ `ScheduleSendDialog` + Rust backend |
| **Undo Send** | ✅ Via `undo-redo` task system | ✅ `UndoSendToast` |
| **Undo/Redo (general)** | ✅ **Full task-based undo** — `UndoRedoStore`, tasks with `canBeUndone` + `createUndoTask()`, two patterns (toggle + snapshot) | ❌ Not implemented (no general undo) |
| **Mail Rules** | ✅ **`preferences-mail-rules.tsx`** — automated filtering/sorting rules | ❌ Not implemented |
| **Send & Archive** | ✅ **`send-and-archive` plugin** | ❌ Not implemented |
| **Draft management** | ✅ `draft-list` plugin, `composer-signature`, `composer-templates` | ✅ Drafts, templates, signatures |
| **Bulk operations** | ✅ Bulk RFC2822 export (v1.21.0), bulk label/folder change | ✅ Flags, move, delete |

**Verdict**: Mailspring is **dramatically ahead** on email workflow: snooze, mail rules, general undo/redo, send-and-archive. Kylins has solid basics but lacks advanced workflow features.

---

## 5. Composer / Editor

| Feature | Mailspring | Kylins |
|---------|-----------|--------|
| **Rich text (HTML)** | ✅ Slate editor (custom fork, slate-react) | ✅ **Tiptap** (ProseMirror-based, 49KB) |
| **Plain text** | ✅ | ✅ |
| **Grammar check** | ✅ **`composer-grammar-check`** plugin (LanguageTool-compatible) | ❌ |
| **Templates** | ✅ `composer-templates` plugin | ✅ `TemplatePicker` |
| **Signatures** | ✅ `composer-signature` plugin (rich editor) | ✅ `SignatureEditor` (per-account) |
| **Reply-To field** | ✅ Added in v1.21.0 | 🔶 Via identities |
| **Attachments** | ✅ `attachments` plugin | ✅ `AttachmentPicker` |
| **Draft auto-save** | ✅ `composer-signature`, draft system | ✅ `draftAutoSave.ts` |
| **Translation** | ✅ **`translation` plugin** (Yandex API, Pro) | ❌ Not implemented |
| **Markdown** | 🔶 Plugin available (`composer-markdown`, disabled by default) | ❌ |
| **Send reminders** | ✅ **`send-reminders` plugin** (remind if no reply) | ❌ Not implemented |
| **Classification labels** | ❌ | ✅ **Enterprise-grade** (badges, banners, watermarks, security chips) |
| **Pop-out composer** | ✅ `thread-popout` window type support | ✅ Dedicated window mode |

**Verdict**: Kylins has a more modern composer engine (Tiptap) and unique enterprise classification. Mailspring has more composer features (grammar check, translation, send reminders, markdown support).

---

## 6. Pro Features (Mailspring Unique)

Mailspring has a **Pro tier ($8/mo)** with features Kylins doesn't have at all:

| Pro Feature | Description | Kylins Status |
|-------------|-------------|---------------|
| **Link Tracking** | Track when recipients click links in emails. Server at `link.getmailspring.com`. | ❌ Not implemented |
| **Open Tracking / Read Receipts** | Track when emails are opened. Inserts tracking pixels. | ❌ Not implemented |
| **Mailbox Analytics** | Insights into email habits, response times, volume trends | ❌ Not implemented |
| **Contact Profiles** | Rich profiles with social media + company info (`participant-profile` plugin) | ❌ Not implemented |
| **Company Profiles** | Business intelligence on companies you correspond with | ❌ Not implemented |
| **Thread Sharing** | Share threads via web link (`share.getmailspring.com`) | ❌ Not implemented |
| **Personal Level Indicators** | Chevrons showing if you're direct/only recipient (`personal-level-indicators`) | ❌ Not implemented |
| **Github Contact Card** | GitHub integration in contact sidebar | ❌ Not implemented |

**Critical privacy note**: All Pro features run client-side — Mailspring does **not** send credentials to the cloud. Tracking pixels and link redirects use Mailspring's servers. Kylins intentionally does not do any tracking.

---

## 7. Calendar

| Feature | Mailspring | Kylins |
|---------|-----------|--------|
| **Calendar views** | ✅ Mini-month + Quick Event popover (`main-calendar` plugin) | ✅ Month, week, day, agenda (full views) |
| **Event creation** | ✅ Quick event popover | ✅ `EventCreateModal` |
| **Recurring events** | 🔶 ICS parsing support (`ical.js`, `ical-expander`) | 🔶 ICS RRULE via `ical-expander` |
| **CalDAV sync** | ❌ Not built-in | ❌ Not implemented |
| **EAS calendar** | ❌ | 🔶 Stub — `easItemToEvent()` returns null |
| **iTIP/iMIP (invitations)** | ✅ `event-rsvp-task.ts` — RSVP via IMAP | 🔶 RSVP card + ICS reply |
| **Calendar drag-and-drop** | 🔶 Plan exists (`calendar-event-dragging-plan.md` 20KB) | ❌ |
| **Multiple calendars** | ✅ | ✅ |
| **Calendar database** | ✅ SQLite via sync engine | ✅ SQLite `calendar_events` table |

**Verdict**: Kylins has a richer calendar UI (month/week/day views). Mailspring has minimal calendar (popover + mini-month). Neither has CalDAV sync. Mailspring has a detailed accessibility plan for calendar.

---

## 8. Contacts

| Feature | Mailspring | Kylins |
|---------|-----------|--------|
| **Contact management** | ✅ `contacts` plugin (list, detail, edit, VCF import/export) | ✅ Full CRUD with groups, avatars, multiple fields |
| **VCF / vCard** | ✅ Full VCF import/export (`VCFImportExport.ts`, `VCFHelpers.ts`) | ✅ `vcard.ts` for import/export |
| **Contact auto-complete** | ✅ `account-contact-field.tsx` in composer | 🔶 Local contacts only |
| **Google Contacts** | ✅ `GoogleSupport.ts` integration | 🔶 Phase 4 stub |
| **CardDAV sync** | ❌ Not built-in | 🔶 Phase 3 stub |
| **LDAP** | ❌ | ❌ |
| **Contact groups** | ✅ `contact-group.ts` model + CRUD | ✅ Group management |
| **Contact profiles** | ✅ `participant-profile` plugin (Pro) | ❌ |
| **GitHub integration** | ✅ `github-contact-card` plugin | ❌ |
| **Source badge** | ❌ | ✅ `SourceBadge` (shows data source per contact) |

**Verdict**: Roughly at parity for local contacts. Kylins has a better contact detail view and source badges. Mailspring has more remote integrations (Google, GitHub) and Pro-tier contact profiles.

---

## 9. Search & Filtering

| Feature | Mailspring | Kylins |
|---------|-----------|--------|
| **Full-text search** | ✅ `thread-search` plugin (via sync engine's indexed search) | ✅ SQLite FTS5 with trigram tokenizer |
| **Search operators** | ✅ Gmail-style queries (`from:`, `to:`, `subject:`) | ❌ Planned ("A richer query parser … is a follow-up") |
| **Quick filter** | 🔶 Category-based filtering (inbox, unread, starred, etc.) | ❌ |
| **Saved searches** | 🔶 Via mail rules | ❌ |
| **Search across accounts** | ✅ Via sync engine index | 🔶 Per-account FTS5 |
| **Desktop search integration** | ❌ | ❌ |

**Verdict**: Mailspring has a richer search UX (Gmail-style operators). Kylins has a solid FTS5 backend but minimal search UI.

---

## 10. Security & Privacy

| Feature | Mailspring | Kylins |
|---------|-----------|--------|
| **Email encryption (PGP/SMIME)** | 🔶 Community plugin available (not built-in) | ❌ Not implemented |
| **Phishing detection** | ✅ `phishing-detection` plugin (disabled by default) | ✅ `phishingDetector.ts` (10 heuristic rules) |
| **Remote content blocking** | ✅ `message-autoload-images` plugin (configurable) | ✅ `imageBlocker.ts` |
| **Tracking pixel removal** | ✅ `remove-tracking-pixels` plugin | ✅ `imageBlocker.ts` (neutralizes 1x1 trackers) |
| **Credential encryption** | ✅ OS keychain (via Electron `safeStorage`) | ✅ AES-256-GCM + OS keyring |
| **Spam filtering** | ✅ Spam detection via sync engine + `SpamMessage` indicator | ❌ Not implemented |
| **TLS/SSL** | ✅ Full (via Mailcore2) | ✅ Full (IMAP, SMTP, EAS) |
| **Master Password** | 🔶 OS-level credential storage | ✅ Auto-generated master key |
| **Link confirmation** | ✅ Click tracking links warn before navigation | 🔶 Basic link handling |
| **Secret leak prevention** | ✅ Added in v1.21.1 (prevents secrets in error modals) | ❌ Not specifically addressed |

**Verdict**: Roughly at parity for basic security. Neither has built-in PGP/SMIME (Mailspring has community plugin). Kylins has credential-level encryption; Mailspring has spam detection.

---

## 11. Themes & Customization

| Feature | Mailspring | Kylins |
|---------|-----------|--------|
| **Built-in themes** | ✅ **7 themes**: ui-light, ui-dark, ui-darkside, ui-taiga, ui-ubuntu, ui-less-is-more, ui-automatic | ✅ CSS custom properties + light/dark/system + skin palettes |
| **Community themes** | ✅ **~30 themes** (Catppuccin, Dracula, Nord, Matcha, etc.) | ❌ None |
| **Theme system** | ✅ Plugin-based (LESS variables: `ui-variables.less`, `theme-colors.less`) | ✅ CSS custom property overrides |
| **Auto light/dark** | ✅ `ui-automatic` theme (v1.22.0) | ✅ `system` theme option |
| **Custom fonts** | ✅ `custom-fonts` plugin | 🔶 Settings for UI fonts |
| **Custom sounds** | ✅ `custom-sounds` plugin | 🔶 Placeholder in notification manager |
| **Density** | 🔶 Fixed spacing | ✅ `UIDensity` setting |
| **Toolbar customization** | ✅ Customizable via keymaps + component injection | 🔶 Ribbon-style toolbar |
| **Font size** | 🔶 System | ✅ UI font size settings |
| **Screenshot mode** | ✅ `screenshot-mode` plugin (cleans UI for screenshots) | ❌ |

**Verdict**: Mailspring has a **much richer theme ecosystem** (7 built-in + ~30 community themes). Kylins has a clean CSS variable system but no community themes. Kylins has better density/font controls.

---

## 12. Plugin / Extension System

| Feature | Mailspring | Kylins |
|---------|-----------|--------|
| **Plugin architecture** | ✅ **First-class** — 51 built-in plugins, all features are packages | 🔶 Custom PluginManager (infrastructure built, 2 plugins) |
| **Plugin discovery** | ✅ Scans `packages/`, `internal_packages/`, `dev/packages/` | ✅ Dynamic `import()` with path scanning |
| **Component injection** | ✅ `ComponentRegistry` (roles: `Composer:ActionButton`, `ThreadActionsToolbarButton`, `ThreadListIcon`, etc.) | ✅ `InjectedComponent` / `InjectedComponentSet` (header, folder-pane, reading-pane, toolwindow) |
| **Behavioral extensions** | ✅ `ComposerExtension`, `MessageViewExtension`, `ThreadListExtension`, `AccountSidebarExtension` | ✅ `MessageViewExtension` + `ComposerExtension` |
| **Plugin lifecycle** | ✅ `activate()` / `deactivate()` + `serialize()` | ✅ `activate()` / `deactivate()` via PluginAPI |
| **Theme plugins** | ✅ `"theme": "ui"` in package.json | 🔶 CSS variable themes |
| **Keymap contribution** | ✅ Per-plugin `keymaps/` directory | 🔶 Centralized shortcut system |
| **Menu contribution** | ✅ Per-plugin `menus/` directory | ❌ |
| **Styles** | ✅ Per-plugin LESS stylesheets (auto-loaded) | 🔶 Global CSS |
| **Plugin marketplace** | ❌ No marketplace/store yet ("coming soon") | ❌ No ecosystem |
| **Plugin management UI** | ❌ No UI (manual folder copy or config edit) | ❌ No UI |
| **Plugin enable/disable** | 🔶 Config file only (`core.disabledPackages` array) | ❌ |
| **Plugin sandboxing** | ❌ Full API access | ❌ Full API access |
| **Community plugins** | ✅ ~15 plugins (avatars, AI assistant, PGP, calendar sync, etc.) | ❌ None |

**Verdict**: Mailspring's plugin system is **far more mature** — it's been the architectural foundation for 10+ years, with 51 built-in plugins and a growing community. Kylins has a well-designed but barely-used plugin infrastructure. Mailspring's plugin system is one of its strongest competitive advantages.

---

## 13. UI Components & Accessibility

| Feature | Mailspring | Kylins |
|---------|-----------|--------|
| **Accessibility plan** | ✅ **Extensive** — 8 a11y documents (80KB+), covering landmarks, ARIA, icons, keyboard, modals, live regions, form labels | 🔶 Active branch (`a11y-contrast-touch-targets`) |
| **Keyboard shortcuts** | ✅ **Comprehensive** — 4 platform variants + 4 email-client templates (Gmail, Outlook, Apple Mail, Inbox) + per-plugin + user overrides | ✅ Shortcut engine with user overrides |
| **Context menus** | ✅ Full context menus per component | ✅ `ContextMenu` component |
| **Modal system** | ✅ Focus-trapped modals (a11y plan complete) | ✅ `Modal` component |
| **Drag and drop** | ✅ Folder/thread DND (calendar DND planned) | ✅ Composer + attachment DND |
| **Virtualized lists** | ✅ `LazyRenderedList` + `MultiselectList` + `ObservableListDataSource` | ✅ React rendering (no virtualization) |
| **Notifications** | ✅ `notifications` plugin (OS-native) | ✅ `notificationManager.ts` with dedupe |
| **System tray** | ✅ `system-tray` plugin (unread count) | ✅ `traySync.ts` (unread tooltip) |
| **Activity feed** | ✅ `activity` plugin (operations in progress) | ❌ |
| **E2E testing** | ✅ Playwright tests (v1.21.1+) | ❌ |

**Verdict**: Mailspring has invested heavily in accessibility planning and testing. Kylins has started a11y work but it's much less mature. Mailspring's keyboard shortcut system with email-client templates is a standout feature.

---

## 14. Sync Engine & Data Architecture

| Feature | Mailspring | Kylins |
|---------|-----------|--------|
| **Sync architecture** | **Separate C++ process per account** (Mailspring-Sync / Mailcore2), stdin/stdout JSON protocol | **Integrated Rust engine** (`engine.rs` 145KB) in-process |
| **Sync engine language** | C++ (Mailcore2) | Rust |
| **Delta updates** | ✅ Live deltas streamed from sync enginer to Electron | ✅ Delta sync with mutation replay |
| **Offline support** | ✅ Full — sync engine maintains local SQLite | ✅ Full — SQLite-backed offline queue |
| **Task system** | ✅ **Persisted Tasks** (local → remote → complete lifecycle, undoable tasks, `onSuccess`/`onError` callbacks) | ✅ Tauri commands (no persisted task model) |
| **Database writes** | ❌ **Read-only in UI** (only sync engine writes, enforced by `DatabaseStore.inTransaction()` throwing) | ✅ Both read and write from Rust backend |
| **Connection pooling** | ✅ Mailcore2 manages per-account connections | ✅ Session manager with auto-reconnect |
| **Rate limiting** | ✅ Via sync engine | ✅ Circuit breaker in sync engine |
| **IDLE support** | ✅ Via Mailcore2 | ✅ IMAP IDLE |
| **CONDSTORE/QRESYNC** | ✅ Via Mailcore2 | ✅ Rust IMAP client |

**Verdict**: Both have solid sync architectures. Kylins' in-process Rust engine is cleaner architecturally, while Mailspring's separate C++ process per account provides better isolation and leverages Mailcore2's 10+ years of IMAP edge-case handling.

---

## 15. Windows-Specific Features

| Feature | Mailspring | Kylins |
|---------|-----------|--------|
| **Windows taskbar** | ✅ `windows-taskbar-manager.ts` (jump lists, progress) | 🔶 Basic only |
| **Windows updater** | ✅ Squirrel-based (`windows-updater.js`) | ✅ Tauri updater |
| **Focus assist** | ✅ `windows-focus-assist` optional dep | ❌ |
| **MAPI** | ❌ | ❌ |
| **Tray** | ✅ Custom system tray | ✅ Tauri system tray |

---

## 16. Developer Experience

| Feature | Mailspring | Kylins |
|---------|-----------|--------|
| **Dev mode** | ✅ Data stored separately (`Mailspring-dev/`) | ✅ Standard `npm run dev` |
| **Hot reload** | ✅ `CTRL+R` / `CMD+R` | ✅ Vite HMR |
| **DevTools** | ✅ Chrome DevTools in Electron | ✅ Tauri DevTools |
| **TypeScript** | ✅ 5.7.3 with strict checking | ✅ Strict mode (noUnusedLocals, noUncheckedIndexedAccess) |
| **Linting** | ✅ ESLint + Prettier | 🔶 Basic |
| **Testing** | ✅ Jasmine (unit) + Playwright (E2E) | ✅ Vitest + jsdom |
| **CI/CD** | ✅ GitHub Actions | 🔶 Not configured |
| **Storybook** | ❌ | ❌ |
| **Plugin dev tooling** | ✅ Plugin starter kit + Theme starter kit | ❌ |

---

## 17. Feature Gap Summary

### Mailspring Advantages (Missing in Kylins)

| Feature | Priority | Complexity |
|---------|----------|------------|
| **Snooze** | 🟡 Medium | Medium |
| **Mail rules / filters** | 🔴 High | Large |
| **Undo/redo (general)** | 🟡 Medium | Large |
| **Gmail-style search operators** | 🟡 Medium | Medium |
| **Translation** | 🟢 Low | Medium |
| **Grammar check** | 🟢 Low | Medium |
| **Send reminders** | 🟢 Low | Medium |
| **Plugin ecosystem + themes** | 🟡 Medium | Large |
| **Localization (i18n)** | 🟡 Medium | Very Large |
| **Accessibility** | 🟡 Medium | Large |
| **Read receipts / tracking** | 🟢 Low | Medium |
| **POP3 support** | 🟢 Low | Medium |
| **iCloud support** | 🟢 Low | Small |
| **E2E testing (Playwright)** | 🟡 Medium | Medium |

### Kylins Advantages (Missing in Mailspring)

| Feature | Significance |
|---------|-------------|
| **EAS first-class support** | Largest differentiator. Mailspring has zero Exchange/ActiveSync support. |
| **Modern React 19 + Tailwind** | Cleaner, more maintainable codebase than React 17 + LESS |
| **Tauri (smaller, faster)** | vs Electron (larger binary, higher RAM) |
| **Tiptap composer** | vs aging Slate fork |
| **Enterprise classification** | Unique — government/military sensitivity labels |
| **Centralized Rust sync engine** | Cleaner architecture than separate C++ process per account |
| **AES-256-GCM credential encryption** | Stronger than Electron safeStorage |
| **Pure SQLite storage** | Simpler than read-only-in-UI constraint |

### Features at Parity

- IMAP/SMTP email (both solid)
- OAuth2 (both working)
- Three-pane layout
- Drafts, templates, signatures
- Send later / scheduled send
- Desktop notifications
- System tray
- Keyboard shortcuts
- Dark/light themes
- Remote content blocking / tracking pixel removal
- Phishing detection

---

## 18. Key Architectural Differences

### UI → Backend Communication
- **Mailspring**: Flux architecture. UI dispatches Tasks → `MailsyncBridge` serializes to JSON → sends via stdin to separate C++ sync process → sync process emits deltas via stdout → `DatabaseStore.trigger()` → `QuerySubscription` updates React components.
- **Kylins**: Direct Tauri `invoke()` calls from React to Rust commands → Rust processes synchronously or spawns background sync → results returned as JSON → Zustand stores update React.

### Plugin Architecture
- **Mailspring**: Plugins ARE the application. 51 built-in packages, each with `activate()`/`deactivate()`. Component injection via `ComponentRegistry` roles. Extension registries for behavioral hooks.
- **Kylins**: PluginManager is infrastructure, not the architecture itself. Only 2 plugins exist. Same slot-based injection pattern but unused.

### Data Flow
- **Mailspring**: UI is read-only with respect to SQLite. All writes go through sync engine stdin/stdout. Reactive queries (RxJS) for live UI updates.
- **Kylins**: Rust backend reads/writes SQLite directly. Frontend calls Tauri commands. Zustand stores reflect state.

### Storage
- **Mailspring**: SQLite via `better-sqlite3` (read-only in renderer). Writes only by separate C++ sync process.
- **Kylins**: SQLite via `sqlx` (both read/write from Rust). 37 tables + FTS5 + migrations.

---

## 19. Recommendations for Kylins

### Short-term (low-hanging fruit from Mailspring)
1. **Add Gmail-style search operators** — `from:`, `to:`, `subject:`, `is:unread`, date ranges. Mailspring shows this can be done client-side.
2. **Build a mail rules/filters system** — this is the #1 missing workflow feature. Auto-sort, auto-tag, auto-archive on receive.
3. **Improve the plugin story** — ship 3-5 real plugins, document the API, create a plugin starter template (like Mailspring's `Mailspring-Plugin-Starter`).
4. **Add i18n infrastructure** — even if translations come later, design for it now. Mailspring's JSON locale files are a proven pattern.

### Medium-term
5. **Implement snooze** — Mailspring's snooze model (hide from inbox, return at set time) is well-understood and highly requested.
6. **Build general undo/redo** — Mailspring's task-based undo pattern (`canBeUndone` + `createUndoTask()` + `UndoRedoStore`) is elegant and could be adapted.
7. **Add POP3 support** — low effort via `async-pop` or similar Rust crate; enables legacy enterprise accounts.
8. **Improve accessibility** — Mailspring has 8 detailed a11y spec documents. Adapt their approach.
9. **Add E2E testing** — Mailspring added Playwright in v1.21.1. Kylins has no E2E.

### Long-term (differentiation)
10. **Build a theme marketplace** — neither Mailspring nor Thunderbird have solved this well.
11. **Consider Mailspring's plugin monetization model** — Pro features as paid plugins is a proven path.
12. **Mobile companion** — neither Mailspring nor Kylins has mobile.

---

## Sources

- Mailspring source code: `D:\Projects\mailclient\opensource\Mailspring\`
- Kylins source code: `D:\Projects\mailclient\kylins\`
- [Mailspring GitHub](https://github.com/Foundry376/Mailspring)
- [Mailspring-Sync GitHub](https://github.com/Foundry376/Mailspring-Sync)
- [Mailspring Plugin Architecture](https://github.com/Foundry376/Mailspring/blob/master/PLUGIN_SYSTEM_ARCHITECTURE.md)
- [Mailspring Community Plugins](https://github.com/Foundry376/Mailspring/blob/master/docs/community-plugins.md)
- [Mailspring Community Themes](https://github.com/Foundry376/Mailspring/blob/master/docs/community-themes.md)
- [Mailspring Website](https://getmailspring.com)
- [Mailcore2 GitHub](https://github.com/MailCore/mailcore2)
- Kylins architecture: `docs/architecture.md`

# Desktop Mail Client — Core Platform Architecture Design

**Date:** 2026-06-22  
**Scope:** Core platform subsystem for a Tauri-based desktop email client.  
**Status:** Draft pending implementation planning.

---

## 1. Purpose

Design the foundational architecture for a desktop email client built on Velo's technical stack (Tauri v2 + React 19 + TypeScript + Vite + Tailwind CSS + SQLite) that supports:

1. JavaScript/TypeScript plugins and customized themes.
2. AI-native features (generative writing, categorization, semantic search, agents).
3. Better performance than typical Electron-based clients.
4. An Outlook-like layout using Adobe React Aria Components + Tailwind CSS.
5. Exchange ActiveSync via a custom TypeScript EAS library.

---

## 2. Design Goals

| Goal | How the core platform satisfies it |
|---|---|
| **Plugin support** | Runtime dynamic ES-module loading with a `PluginRegistry` API. |
| **Customized themes** | CSS custom-property token system with runtime theme switching. |
| **AI native** | LLM provider abstraction and AI hooks exposed to plugins. |
| **Better performance** | SQLite + FTS5, Web Workers for sync, virtualized lists, Rust for native I/O. |
| **Outlook-like UI** | React Aria Components + Tailwind, three-pane layout. |
| **Exchange ActiveSync** | TypeScript EAS library wrapped behind a `MailProvider` interface. |
| **Cross-platform** | Tauri v2 targeting Windows, macOS, and Linux. |

---

## 3. High-Level Architecture

We adopt **Option A: Velo-style monolithic Tauri + TypeScript service layer**.

```
┌─────────────────────────────────────────────────────────────┐
│                        React UI Layer                        │
│   React Aria Components + Tailwind + Zustand stores         │
│   Plugin-injected components + themes                        │
└──────────────────────┬──────────────────────────────────────┘
                       │  service calls, events
┌──────────────────────▼──────────────────────────────────────┐
│                  TypeScript Service Layer                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐   │
│  │  Account    │ │    Sync     │ │  AI Provider Mgr    │   │
│  │  Service    │ │  Engine     │ │  (cloud + local)    │   │
│  └─────────────┘ └──────┬──────┘ └─────────────────────┘   │
│  ┌─────────────┐        │         ┌─────────────────────┐   │
│  │   Plugin    │        │         │   Search / Rules    │   │
│  │  Registry   │        │         │   / Offline Queue   │   │
│  └─────────────┘        │         └─────────────────────┘   │
└───────────────────────┬─┴──────────────────────────────────┘
                        │  Tauri IPC invoke / events
┌───────────────────────▼──────────────────────────────────────┐
│                      Rust Native Layer                       │
│  Windowing · Tray · Notifications · Shortcuts · Deep Links   │
│  SQLite (tauri-plugin-sql) · Credential Encryption · IMAP/SMTP│
└─────────────────────────────────────────────────────────────┘
```

### Why Option A

- Reuses the custom TypeScript EAS library directly without FFI complexity.
- Supports the requested JS/TS plugin model.
- Velo proves this architecture works for a desktop email client.
- Plugin authors write plain React/TypeScript.
- Performance risks can be mitigated with Web Workers, SQLite FTS5, and virtualized lists.

---

## 4. Layer Breakdown

### 4.1 Rust Native Layer (`src-tauri/`)

**Responsibilities:**

- Application lifecycle: startup, splash screen, main window, multi-window support.
- System integration: tray, notifications, global shortcuts, autostart, deep links (`mailto:`), badge count.
- Security-sensitive I/O: encrypted credential storage (AES-256-GCM), with OS keychain fallback.
- Network protocols implemented in Rust: IMAP (`async-imap`), SMTP (`lettre`), OAuth PKCE localhost server.
- SQLite access: expose `tauri-plugin-sql` commands only to the service layer.

**Key files:**

- `src-tauri/src/lib.rs` — plugin registration, tray, window events, command routing.
- `src-tauri/src/commands/` — IMAP/SMTP/OAuth Tauri commands.
- `src-tauri/src/crypto.rs` — token/password encryption.
- `src-tauri/capabilities/default.json` — capability-based permissions.

**Reference implementations:**

- Velo `src-tauri/src/lib.rs`
- Velo `src-tauri/capabilities/default.json`

---

### 4.2 TypeScript Service Layer (`src/services/`)

**Responsibilities:**

- Business logic: account CRUD, sync orchestration, search, rules, offline queue.
- Mail provider abstraction: `MailProvider` interface with implementations for Gmail API, IMAP/SMTP, and the custom EAS library.
- AI service: provider-agnostic LLM calls, prompt templates, result caching.
- Plugin registry: discover, load, activate, and deactivate JS plugins.
- Theme manager: load theme CSS and update CSS custom properties.

**Key files:**

- `src/services/db/connection.ts` — SQLite singleton + transaction helper.
- `src/services/db/migrations.ts` — version-tracked migrations.
- `src/services/mail/provider.ts` — `MailProvider` interface.
- `src/services/mail/easProvider.ts` — wrapper for the custom EAS library.
- `src/services/ai/aiService.ts` — LLM abstraction.
- `src/services/plugins/pluginManager.ts` — plugin discovery & lifecycle.
- `src/services/theme/themeManager.ts` — theme loading & switching.

**Reference implementations:**

- Velo `src/services/db/connection.ts`
- Velo `src/services/db/migrations.ts`
- Velo `services/gmail/providerFactory.ts`
- Velo `services/ai/aiService.ts`

---

### 4.3 React UI Layer (`src/components/`)

**Layout design references:**

- **IntelliJ IDEA New UI** for the header bar, left/right/bottom tool-window bars, compact toolbars, and icon-only navigation.
- **Outlook 2024** for the folder tree pane, message list, reading pane, and optional inspector pane.
- **Primary/accent color scheme** from `D:\Projects\maschat\CMMP.Outlook.AIChat\cmmp.outlook.aichat.frontend\src\app\globals.css`.
- **Icons:** `@hugeicons/react-free-icons` (Hugeicons stroke icon family).

**Responsibilities:**

- Desktop-app shell: header bar, command ribbon, tool-window bars, resizable panes, status bar.
- Outlook layout: folder pane, message list, reading pane (right/bottom/off), inspector pane.
- Components built with React Aria Components + Tailwind CSS.
- State via Zustand stores.
- Plugin injection points via `<InjectedComponent>` / `<InjectedComponentSet>` at defined roles/locations.

**Key files:**

- `src/components/layout/AppShell.tsx` — root shell with header, ribbon, tool-window bars, resizable panes, status bar.
- `src/components/layout/HeaderBar.tsx` — simplified main toolbar (IntelliJ-style): identity, search, actions.
- `src/components/layout/CommandRibbon.tsx` — Outlook-style command menubar below the header (New mail, Delete, Archive, Move, Categorize, Quick steps, Read/Unread, Flag, Pin, Undo/Redo, More).
- `src/components/layout/ToolWindowBar.tsx` — left/right/bottom icon bars.
- `src/components/layout/PaneHeader.tsx` — pane chrome with title and actions.
- `src/components/layout/PaneDivider.tsx` — resizable divider.
- `src/components/layout/StatusBar.tsx` — bottom status bar.
- `src/components/layout/FolderPane.tsx` — Outlook folder tree with Favorites and account sections.
- `src/components/layout/MessageList.tsx` — Outlook 2024 message list with avatar, sender, subject, time, and Thread Ribbon.
- `src/components/layout/ReadingPane.tsx` — reading pane with subject, header shortcuts, sender meta, action toolbar, and body.
- `src/components/layout/InspectorPane.tsx` — optional right-side peek/inspector.
- `src/stores/*Store.ts`

**Reference implementations:**

- Velo `src/App.tsx` startup sequence.
- Velo store organization.
- Mailspring `InjectedComponent` / `InjectedComponentSet` plugin injection pattern.
- IntelliJ IDEA New UI: https://www.jetbrains.com/help/idea/2024.2/new-ui.html
- Prototype: `docs/superpowers/design/prototype/main-page.html`

---

## 5. Storage & Database

### 5.1 SQLite via `tauri-plugin-sql`

Use a single SQLite database (`mailclient.db`).

**Core tables:**

| Table | Purpose |
|---|---|
| `accounts` | Email accounts, tokens, provider config. |
| `folders` | Mail folders (Inbox, Sent, etc.). |
| `threads` | Conversation threads. |
| `messages` | Individual emails and headers. |
| `attachments` | Attachment metadata + local cache paths. |
| `contacts` | Contact index. |
| `settings` | Key-value app settings. |
| `ai_cache` | Cached LLM results. |
| `pending_operations` | Offline action queue. |
| `_migrations` | Migration tracking. |

### 5.2 Full-Text Search

Add an FTS5 virtual table on messages:

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_name, from_address, body_text, snippet,
  content='messages', content_rowid='rowid', tokenize='trigram'
);
```

**Reference:** Velo migration v2.

### 5.3 Migrations

Version-tracked migrations in a single `migrations.ts` file, applied transactionally on startup.

**Reference:** Velo `src/services/db/migrations.ts`.

---

## 6. Plugin & Theme Framework

### 6.1 Plugin Package Structure

```
plugins/
└── my-plugin/
    ├── package.json
    ├── main.ts
    └── styles/
        └── index.css
```

`package.json`:

```json
{
  "name": "my-plugin",
  "main": "./main.ts",
  "enabledByDefault": true
}
```

### 6.2 Plugin API

Plugins export:

```ts
export function activate(api: PluginAPI): void;
export function deactivate(): void;
```

`PluginAPI` exposes:

- `registerComponent(role, component)` — inject UI components.
- `registerAction(id, handler)` — add menu/command actions.
- `registerMailProvider(name, factory)` — add custom sync providers.
- `registerTheme(theme)` — contribute theme tokens.
- `onEvent(event, handler)` — subscribe to app events.

**Component roles (mapped to layout regions):**

| Role | Layout Region |
|---|---|
| `header:left` / `header:center` / `header:right` | HeaderBar sections |
| `toolwindow:left` / `toolwindow:right` / `toolwindow:bottom` | Tool-window icon bars |
| `folder-pane:header` / `folder-pane:footer` | Folder pane chrome |
| `message-list:header` / `message-list:item-action` | Message list chrome and inline actions |
| `reading-pane:toolbar` / `reading-pane:footer` | Reading pane chrome |
| `status-bar` | Bottom status bar |

### 6.3 Theme System

- **Base tokens:** CSS custom properties in `src/styles/theme.css`.
- **Reference palette:** primary/accent colors are taken from `D:\Projects\maschat\CMMP.Outlook.AIChat\cmmp.outlook.aichat.frontend\src\app\globals.css` using `oklch()`:
  - Light primary: `oklch(0.546 0.245 262.881)`
  - Dark primary: `oklch(0.707 0.165 254.624)`
- **Semantic desktop tokens:** header, toolbar, pane-header, pane-divider, status-bar, focus-ring, selected-item tokens.
- **Theme package:** a folder with `theme.json` + `theme.css` that overrides tokens.
- **Theme manager:** on theme change, swap the active CSS file and update `<html>` class names.

**Reference:** Mailspring `ThemeManager` and `ui-variables.less` pattern, adapted to CSS custom properties.

### 6.4 Layout Design

**IntelliJ IDEA New UI principles:**

- Simplified main toolbar: one header bar with grouped actions and overflow menus.
- Icon-first tool-window bars on left, right, and bottom; labels via tooltips.
- Compact density with optional comfortable mode.
- Draggable, repositionable panes.

**Outlook 2024 principles:**

- Folder pane: Favorites, account sections, collapsible folder groups.
- Message list: avatar, sender, subject snippet, time, unread/flag/attachment indicators, date grouping.
- Reading pane: header with subject/participants/time, action toolbar, sanitized body.
- Inspector pane: optional right-side peek for contact/card/details.
- Reading pane position: right (default), bottom, or off.
- Resizable pane dividers between all major panes.

**Layout state in `uiStore`:**

- `folderPaneWidth`, `messageListWidth`
- `readingPanePosition: 'right' | 'bottom' | 'off'`
- `inspectorPaneVisible`
- `activeToolWindow`
- `density: 'compact' | 'comfortable'`

**Layout libraries:** `react-resizable-panels` for resizable/collapsible panes; React Aria Components for collection behaviors and keyboard navigation.

### 7.1 LLM Provider Abstraction

```ts
interface LLMProvider {
  id: string;
  chat(messages: Message[], options: ChatOptions): AsyncIterable<string>;
  summarize(text: string): Promise<string>;
  categorize(text: string, labels: string[]): Promise<string>;
}
```

**Implementations:**

- `OpenAIProvider`
- `AnthropicProvider`
- `GoogleProvider`
- `OllamaProvider` (local)

### 7.2 AI Features

| Feature | Implementation |
|---|---|
| Smart compose | Composer extension calling `LLMProvider.chat`. |
| Thread summary | AI service caches result in `ai_cache`. |
| Auto-categorize | Rule engine + AI fallback. |
| Natural-language search | Generate SQL/FTS query from NL prompt. |
| Email agents | Agent loop with tools (search, send, draft). |

### 7.3 AI Result Caching

Cache in SQLite `ai_cache(account_id, thread_id, type, content)` to avoid repeated API calls.

**Reference:** Velo `services/db/aiCache.ts` and `services/ai/aiService.ts`.

---

## 8. Exchange ActiveSync Integration

The custom TypeScript EAS library lives in the service layer.

```ts
// src/services/mail/easProvider.ts
export class EasProvider implements MailProvider {
  constructor(private account: Account) {}

  async connect(): Promise<void> {
    this.client = createEasClient({
      endpoint: this.account.easEndpoint,
      username: this.account.email,
      password: await decrypt(this.account.password),
      device: { id: this.deviceId, type: 'Desktop' },
    });
  }

  async syncFolder(folderId: string): Promise<SyncResult> { /* ... */ }
  async sendMessage(draft: Draft): Promise<void> { /* ... */ }
}
```

The `syncManager` treats EAS identically to Gmail API or IMAP.

---

## 9. Security Model

| Concern | Approach |
|---|---|
| Credential storage | AES-256-GCM encrypted in SQLite; keys stored in OS keychain via Tauri plugin. |
| OAuth tokens | Same encryption; refresh logic in service layer. |
| Plugin sandbox | Plugins run in the webview with access to `PluginAPI` only; file system access through Tauri capabilities. |
| CSP | Strict Content Security Policy; remote images blocked by default. |
| Email rendering | DOMPurify + sandboxed iframe. |

**Reference:** Velo AES-256-GCM credential encryption and DOMPurify iframe rendering.

---

## 10. Performance Foundations

| Technique | Where |
|---|---|
| Virtualized lists | `react-window` or `@tanstack/react-virtual` for message/thread lists. |
| SQLite FTS5 | Fast full-text search without loading all messages. |
| Web Workers | Heavy sync/AI/indexing off main thread. |
| Attachment lazy loading | Fetch attachments only when opened. |
| Incremental sync | Gmail History API / IMAP UIDVALIDITY / EAS sync key. |
| Prepared statements | Reuse SQLite prepared statements. |
| Debounced registry triggers | Like Mailspring's ComponentRegistry debounce. |

---

## 11. Testing Strategy

| Layer | Tool |
|---|---|
| Unit tests (services, stores) | Vitest + jsdom |
| Component tests | React Testing Library |
| Rust tests | `cargo test` |
| E2E | Playwright for Tauri |

---

## 12. Open Questions

1. **Plugin API scope:** Should plugins be able to add entirely new mail providers, or only UI/actions/rules?
2. **Local LLM runtime:** Should Ollama be bundled or require users to install it separately?
3. **EAS details:** Does the custom EAS library expose provisioning + sync, or do we need to wrap provisioning ourselves?

---

## 13. References

- Velo `CLAUDE.md` and `src-tauri/`, `src/services/`
- Mailspring `app/src/package-manager.ts`, `app/src/registries/component-registry.ts`, `app/src/theme-manager.ts`
- Inbox Zero `apps/web/package.json`, `AGENTS.md`
- Zero `README.md`, `apps/server/package.json`

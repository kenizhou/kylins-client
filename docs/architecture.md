# Desktop Email Client — System Architecture Design

> Based on Velo technical stack (Tauri v2 + React 19 + Rust + SQLite + Tailwind CSS + Zustand)
>
> Research date: 2026-06-22
>
> Reference projects analyzed: [Velo](https://github.com/avihaymenahem/velo), [Mailspring](https://github.com/Foundry376/Mailspring), [Inbox Zero](https://github.com/elie222/inbox-zero), [Zero (0.email)](https://github.com/Mail-0/Zero), [Mustang](https://github.com/mustang-im/mustang)

---

## Source Reuse Strategy

> **Principle**: For every architectural component, reuse the best proven implementation from the 4 reference projects. The table below maps each component to exactly which project to pull from, with specific file paths.

| # | Component | Primary Source | Specific Files to Reuse/Adapt | % Reused |
|---|---|---|---|---|
| 1 | **Tauri Shell + Rust Backend** | **Velo** | `src-tauri/src/lib.rs`, `commands.rs`, `imap/client.rs`, `smtp/client.rs`, `oauth.rs`, `crypto/` | ~95% |
| 2 | **Email Provider Abstraction** | **Velo** | `src/services/email/types.ts`, `providerFactory.ts`, `emailActions.ts` | ~90% |
| 3 | **Gmail API Provider** | **Velo** | `src/services/gmail/sync.ts`, `syncManager.ts`, `tokenManager.ts`, `client.ts` | ~90% |
| 4 | **IMAP/SMTP Provider** | **Velo** | `src/services/imap/imapSync.ts`, `tauriCommands.ts`, `folderMapper.ts`, `autoDiscovery.ts` | ~95% |
| 5 | **EAS Provider** | **User's own TS library** | Wrap in `EmailProvider` interface; reference Velo's `gmailProvider.ts` for adapter pattern | New |
| 6 | **Plugin System** | **Mailspring** (adapt) | `app/src/package-manager.ts`, `package.ts`, `registries/component-registry.ts`, `keymap-manager.ts`, `config.ts` — adapt Electron→Tauri, Reflux→Zustand, LESS→CSS vars | ~40% |
| 7 | **Theme System** | **Velo** (CSS) + **Mailspring** (concept) | Velo: `src/styles/globals.css`, `src/constants/themes.ts`. Mailspring: `theme-manager.ts` (reference only) | ~85% |
| 8 | **AI Pipeline** | **Velo** (base) + **Inbox Zero** (depth) | Velo: `src/services/ai/` (providerFactory, aiService, prompts, cache). IZ: `apps/web/utils/ai/choose-rule/`, `apps/web/utils/ai/reply/` | ~70% |
| 9 | **Database** | **Velo** | `src/services/db/` — connection.ts, migrations.ts, messages.ts, threads.ts, contacts.ts, attachments.ts, settings.ts, search.ts, folderSyncState.ts, pendingOperations.ts, aiCache.ts + 20 more | ~95% |
| 10 | **Sync Engine** | **Velo** | `src/services/sync/`, `src/services/queue/queueProcessor.ts`, `src/services/threading/threadBuilder.ts`, `src/services/backgroundCheckers.ts` | ~95% |
| 11 | **Composer (Tiptap)** | **Velo** | `src/components/composer/Composer.tsx`, `AddressInput.tsx`, `EditorToolbar.tsx`, `AiAssistPanel.tsx`; `src/services/composer/draftAutoSave.ts`; `src/stores/composerStore.ts` | ~90% |
| 12 | **Search (FTS5 + operators)** | **Velo** (+ Mailspring AST) | Velo: `src/services/search/searchParser.ts`, `searchQueryBuilder.ts`. Mailspring: `services/search/search-query-ast.ts` (reference) | ~85% |
| 13 | **State Management (Zustand)** | **Velo** | `src/stores/accountStore.ts`, `threadStore.ts`, `composerStore.ts`, `labelStore.ts`, `uiStore.ts`, `shortcutStore.ts`, `contextMenuStore.ts` | ~95% |
| 14 | **Routing** | **Velo** | `src/router/` (routeTree.tsx, navigate.ts, index.ts) | ~90% |
| 15 | **Settings/Preferences** | **Velo** | `src/components/settings/SettingsPage.tsx`, 9 setting editors; `src/services/db/settings.ts` | ~90% |
| 16 | **Security** | **Velo** | `src/utils/crypto.ts`, `imageBlocker.ts`; `src/services/phishing/phishingScanner.ts`; `src/components/email/PhishingBanner.tsx`, `AuthBadge.tsx`, `EmailRenderer.tsx` | ~95% |
| 17 | **Notifications** | **Velo** | `src/services/notifications/notificationManager.ts`, `badgeManager.ts`; `src/services/db/notificationVips.ts` | ~90% |
| 18 | **Calendar** | **Velo** | `src/components/calendar/` (9 components); `src/services/google/calendar.ts`; `src/services/db/calendarEvents.ts` | ~90% |
| 19 | **Contacts** | **Velo** | `src/services/contacts/gravatar.ts`; `src/services/db/contacts.ts`; `src/components/email/ContactSidebar.tsx` | ~90% |
| 20 | **Keyboard Shortcuts** | **Velo** (+ Mailspring merge) | Velo: `src/hooks/useKeyboardShortcuts.ts`, `src/constants/shortcuts.ts`, `src/stores/shortcutStore.ts`. Mailspring: `keymap-manager.ts` (layered merge reference) | ~80% |
| 21 | **Layout/UI Components** | **Velo** | `src/components/layout/` (Sidebar, EmailList, ReadingPane, MailLayout); `src/components/email/` (ThreadView, ThreadCard, MessageItem, ActionBar, etc.); `src/components/ui/` (ContextMenu, EmptyState, Skeleton, etc.) | ~85% |
| 22 | **Drag-and-Drop** | **Velo** | `src/components/dnd/DndProvider.tsx` (threads → sidebar labels via @dnd-kit) | ~95% |
| 23 | **Account Setup** | **Velo** | `src/components/accounts/AddAccount.tsx`, `AddImapAccount.tsx`, `AccountSwitcher.tsx`, `SetupClientId.tsx` | ~90% |
| 24 | **Offline Queue** | **Velo** | `src/services/queue/queueProcessor.ts`, `src/services/email/emailActions.ts`, `src/services/db/pendingOperations.ts` | ~95% |

### Key Reuse Decisions

**Velo (~85% of codebase)** — Start by forking Velo. It's the only Tauri v2 project among the 4, sharing our exact tech stack. Its IMAP/SMTP Rust backend, SQLite schema (37 tables), FTS5 search, JWZ threading, offline queue, Zustand stores, TipTap composer, calendar, contacts, phishing detection, notifications, and 60+ UI components are all production-tested and directly reusable with Tauri.

**Mailspring (~10% — plugin system architecture)** — The plugin system concepts (ComponentRegistry, slot-based injection, lifecycle management, config namespacing, keymap layering) are proven across 51 internal packages. But the IMPLEMENTATION must be rewritten: Electron→Tauri, Reflux→Zustand, LESS→CSS vars, `require()`→dynamic `import()`, class components→function components. Use Mailspring as the architectural blueprint, not as copy-paste source.

**Inbox Zero (~5% — AI rule depth)** — Velo has solid AI provider + caching infrastructure. Inbox Zero contributes deeper AI patterns: the choose-rule engine for AI-driven email handling, reply drafting with context, sender categorization, and meeting briefs. Reference these patterns to enrich the AI feature set beyond Velo's current scope.

**Zero (negligible)** — Zero's Cloudflare Workers/Durable Objects architecture shares almost nothing with a Tauri desktop app. Its tRPC API pattern and React Router setup are web-specific.

**EAS** — User provides their own TypeScript EAS library. Wrap it in Velo's `EmailProvider` interface (reference `gmailProvider.ts` for the adapter pattern).

---

## 1. Requirements

| # | Requirement | Description |
|---|---|---|
| 1 | **Plugin system + custom themes** | Extensible like Mailspring — third-party plugins can inject UI components, add features, and ship custom themes |
| 2 | **AI-native** | LLM deeply integrated into every email workflow: compose, reply, summarize, categorize, search, task extraction |
| 3 | **Better performance** | Rust backend for heavy I/O, SQLite for local data, virtualized lists, efficient delta sync |
| 4 | **MS Outlook-like UI** | Three-panel resizable layout, ribbon toolbar, data-dense design using React Aria Components + Tailwind CSS |
| 5 | **Exchange ActiveSync** | Full EAS 16.1 protocol support for email, calendar, contacts, and tasks sync with Exchange servers |

### Key Technology Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Desktop shell | **Tauri v2** (not Electron) | Rust-based, smaller binaries, less memory, no Chromium bloat |
| UI components | **React Aria Components** (not React Spectrum) | Headless accessible components + full visual control via Tailwind. Spectrum enforces Adobe's visual design — cannot style to look like Outlook |
| EAS implementation | **User's own TypeScript EAS library** | Wrap in `EmailProvider` interface. Reference Velo's `gmailProvider.ts` for adapter pattern (~150 lines of glue code) |
| Theming | **CSS custom properties** (not LESS) | Simpler, faster, no runtime compiler needed. Tailwind v4 natively supports CSS vars |
| Plugin system | **Slot-based component injection** (Mailspring pattern) | Proven across 51 Mailspring plugins. Slot system maps naturally to React 19 |
| State management | **Zustand** (from Velo) | Simpler and smaller than Reflux/RxJS. Already proven in Velo |

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                 Tauri Desktop Shell (Rust)                        │
│  System tray · Notifications · Global shortcuts · Auto-start     │
│  Deep links (mailto:) · Window management · Auto-update           │
│  Credential encryption (AES-256-GCM) · SQLite connection pool     │
├─────────────────────────────────────────────────────────────────┤
│  Rust Backend                                                    │
│  ┌────────────────┐ ┌────────────────┐ ┌──────────────────────┐ │
│  │ IMAP Client     │ │ SMTP Client    │ │ OAuth Server (PKCE)  │ │
│  │ (async-imap)    │ │ (lettre)       │ │ (localhost axum)     │ │
│  └────────────────┘ └────────────────┘ └──────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  React 19 + TypeScript Frontend (Vite 7)                         │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │                     Plugin System                             ││
│  │  PluginLoader · ComponentRegistry · CommandRegistry            ││
│  │  ConfigRegistry · ThemeManager · Extension Pipelines          ││
│  ├──────────────────────────────────────────────────────────────┤│
│  │  Service Layer                                                ││
│  │  ┌──────────────────────────────────────────────────────────┐ ││
│  │  │              EmailProvider Abstraction                    │ ││
│  │  │  ┌───────────┐ ┌─────────────┐ ┌───────────────────────┐ │ ││
│  │  │  │   Gmail   │ │  IMAP/SMTP  │ │    EAS Provider       │ │ ││
│  │  │  │ Provider  │ │  Provider   │ │  (re-implemented)     │ │ ││
│  │  │  │ (REST)    │ │  (Tauri)    │ │  (WBXML + OAuth 2.0)  │ │ ││
│  │  │  └───────────┘ └─────────────┘ └───────────────────────┘ │ ││
│  │  └──────────────────────────────────────────────────────────┘ ││
│  │  AI Pipeline · Sync Engine · Search (FTS5) · Offline Queue    ││
│  ├──────────────────────────────────────────────────────────────┤│
│  │  SQLite (Tauri SQL plugin)                                    ││
│  │  messages · threads · folders · contacts · events · tasks     ││
│  │  ai_cache · settings · plugin_config · FTS5 virtual table     ││
│  └──────────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────┤
│  UI Layer                                                        │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  @window-splitter/react  ← Three-panel resizable layout       ││
│  │  React Aria Components   ← Accessible unstyled widgets        ││
│  │  Tailwind CSS v4         ← Outlook-like visual design         ││
│  │  Tiptap v3               ← Rich text email composer           ││
│  └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Technology Stack Detail

### 3.1 Desktop Shell (Tauri v2)

| Component | Technology | Version |
|---|---|---|
| Rust runtime | tokio (async) | 1.x |
| WebView | WebView2 (Win) / WKWebView (Mac) / WebKitGTK (Linux) | Platform-native |
| Package size | ~5MB (vs ~150MB Electron) | — |
| Memory baseline | ~50MB (vs ~200MB Electron) | — |

**Tauri plugins used:** SQL, notification, opener, dialog, fs, single-instance, autostart, global-shortcut, deep-link, updater, process, os, http, log, shell

**Rust commands (ported from Velo, extended for EAS):**
```
IMAP:   test_connection, list_folders, fetch_messages, fetch_message_body,
        set_flags, move_messages, delete_messages, get_folder_status,
        fetch_attachment, append_message, sync_folder, delta_check
SMTP:   send_email, test_connection
OAuth:  start_oauth_server, exchange_token, refresh_token
System: close_splashscreen, set_tray_tooltip, open_devtools
```

### 3.2 Frontend

| Category | Technology | Rationale |
|---|---|---|
| Framework | React 19 | Function components + hooks + compiler optimizations |
| Build | Vite 7 | Fast HMR, ESM-native |
| Language | TypeScript 5.9+ | Strict mode |
| Styling | Tailwind CSS v4 | Utility-first, CSS custom properties, `@theme` directive |
| UI Components | React Aria Components (`react-aria-components`) | Headless + accessible + full visual control |
| Layout | `@window-splitter/react` | ARIA-compliant resizable panels |
| Rich text | Tiptap v3 (ProseMirror) | Extensible, AI-compatible editor |
| Routing | TanStack Router v1 | Type-safe, file-based, lazy routes |
| State | Zustand 5 | Minimal, hook-based, selectors for performance |
| Forms | React Hook Form + Zod | Type-safe validation |
| Icons | Lucide React | Consistent, tree-shakable |
| Testing | Vitest 4 + Testing Library + Playwright | Unit + integration + E2E |

### 3.3 AI Stack

| Layer | Technology |
|---|---|
| Provider SDK | `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `ollama-ai-provider`, `@openrouter/ai-sdk-provider` |
| Local models | Ollama (sidecar or remote), llama.cpp (future) |
| Caching | SQLite `ai_cache` table (hash-based, TTL per feature) |
| Prompt management | Versioned prompt templates in plugin-compatible format |
| Observability | Axiom / PostHog (optional, user opt-in) |

---

## 4. Plugin System Design

### 4.1 Plugin Package Structure

```
my-plugin/
├── package.json          # name, version, main, engines.velomail, theme?
├── src/
│   └── main.ts           # activate(context: PluginContext) / deactivate()
├── styles/
│   └── plugin.css        # Optional styles (auto-injected on activate)
├── keymaps/
│   └── plugin.json       # Optional keyboard shortcuts
└── settings/
    └── schema.ts         # Optional Zod config schema → auto-generated settings UI
```

### 4.2 Plugin Lifecycle

```
App.startRootWindow()
  │
  └─ PluginManager.activateAll()
       │
       ├─ Discover: Scan /plugins/ (built-in), <app-data>/plugins/ (user)
       ├─ Validate: Check engines.velomail, dependencies
       │
       ├─ syncInit: true  → Activate IMMEDIATELY (critical plugins)
       └─ syncInit: false → Activate after 2500ms (prevents startup jank)
                              │
                              └─ For each plugin:
                                   ├─ Load stylesheets
                                   ├─ Load keymaps (merge into keymap stack)
                                   ├─ Dynamic import(plugin.main)
                                   ├─ Call plugin.activate(context)
                                   │   ├─ context.components.register(MyComponent, { role, location, modes })
                                   │   ├─ context.commands.register('my-plugin:action', handler)
                                   │   ├─ context.composerPipeline.registerMiddleware(...)
                                   │   ├─ context.aiPipeline.registerHook('beforeAI', ...)
                                   │   └─ context.config.register(zodSchema)
                                   │
                                   └─ On failure: deactivate, log error
```

### 4.3 Plugin Context API

```typescript
interface PluginContext {
  // === UI Injection ===
  components: ComponentRegistry;          // Register React components into named slots

  // === Commands & Shortcuts ===
  commands: CommandRegistry;              // Register keyboard-triggered actions

  // === Extension Pipelines ===
  composerPipeline: ComposerPipeline;     // Middleware: beforeSend, afterSend, warnings
  messageViewPipeline: MessageViewPipeline; // Middleware: transformBody, postRender
  aiPipeline: AIPipeline;                 // Hook: beforeAI, afterAI. Register: AIFeature

  // === Configuration ===
  config: ConfigRegistry;                 // Per-plugin settings, Zod schema, auto-namespaced

  // === Cross-Plugin Dependencies ===
  services: ServiceRegistry;              // Lazy DI — request services before they're registered

  // === Data Access ===
  db: DatabaseAccess;                     // Read-only SQLite access (messages, threads, etc.)

  // === App Utilities ===
  app: {
    showNotification(opts: NotificationOptions): void;
    openDialog(component: ReactNode): void;
    getCurrentAccount(): Account;
    getActiveTheme(): string;
  };
}
```

### 4.4 Component Registry — Slot-Based Injection

The most-used extension point. Plugins register React components into **named slots** spread across the UI:

```typescript
// Plugin registers its component:
ComponentRegistry.register(MyTrackingButton, {
  role: 'Composer:ActionButton',
  location: 'composer-toolbar',
  modes: ['compose', 'reply'],
});

// App renders the slot — first match:
<InjectedComponent matching={{ role: 'Composer:ActionButton' }} />

// Or all matches:
<InjectedComponentSet matching={{ location: 'ribbon-home-tab' }} maxItems={20} />
```

**Matching:** A registered component matches if ANY of its `roles`/`locations`/`modes` overlap with the query. Components without a `displayName` are rejected on registration.

### 4.5 Slot Map (Outlook-Inspired Layout)

```
┌──────────────────────────────────────────────────────────────────┐
│ TitleBar                                                          │
│ [slot: titlebar-left] .............. [title] .............. [slot: titlebar-right] │
├──────────────────────────────────────────────────────────────────┤
│ Ribbon Tabs: Home · View · [slot: ribbon-tab]                     │
│ ┌────────────────────────────────────────────────────────────────┐│
│ │ Home: [New] [Reply] [Fwd] [Delete] ... [slot: ribbon-home]     ││
│ │ View: [Density] [Pane] ... [slot: ribbon-view]                  ││
│ └────────────────────────────────────────────────────────────────┘│
├────────────┬───────────────────────┬──────────────────────────────┤
│ SIDEBAR    │ MESSAGE LIST           │ READING PANE                │
│            │                        │                              │
│ Folder     │ [slot: msg-list-       │ [slot: reading-pane-toolbar] │
│ Tree       │  toolbar]             │                              │
│ (React     │                        │ Message Body                  │
│  Aria      │ Message Table          │                              │
│  Tree)     │ (React Aria Table)     │ [slot: message-body-header]  │
│            │                        │                              │
│ [slot:     │ [slot: msg-list-       │ [slot: message-body-after]   │
│  sidebar-  │  after]               │                              │
│  bottom]   │                        │ Attachments                   │
│            │                        │ [slot: reading-pane-bottom]  │
├────────────┴───────────────────────┴──────────────────────────────┤
│ StatusBar: Connected · 2,345 unread · [slot: statusbar]            │
└──────────────────────────────────────────────────────────────────┘
```

### 4.6 Extension Pipelines

**Composer Pipeline:**
```typescript
interface ComposerMiddleware {
  beforeSend(draft: DraftMessage): Promise<DraftMessage>;     // Modify before sending
  afterSend(message: SentMessage): Promise<void>;             // Post-send actions
  warningsForSending(draft: DraftMessage): Promise<string[]>; // Validation warnings
}
```

**Message View Pipeline:**
```typescript
interface MessageViewMiddleware {
  transformBody(html: string, message: Message): Promise<string>;
  postRender(container: HTMLElement, message: Message): Promise<void>;
}
```

**AI Pipeline:**
```typescript
interface AIHook {
  beforeAI(context: AIContext): Promise<AIContext>;    // Modify prompt, add context
  afterAI(result: AIResult): Promise<AIResult>;        // Post-process, validate
}
```

### 4.7 Extension Points Summary

| Extension Point | Type | Description |
|---|---|---|
| Component slots | ComponentRegistry | Inject React components into ~20 named UI slots |
| Commands | CommandRegistry | Register keyboard-shortcut-triggered actions |
| Composer pipeline | Middleware chain | Transform drafts before/after sending |
| Message view pipeline | Middleware chain | Transform message body before/after render |
| AI pipeline | Feature + hooks | Add AI features, intercept AI calls |
| Theme packages | CSS variables | Register CSS custom property overrides |
| Settings tabs | SettingsRegistry | Add tabs to Settings dialog |
| Context menus | MenuRegistry | Add items to right-click menus |
| Quick Steps | ActionRegistry | Register custom action chains |
| Search providers | SearchRegistry | Add custom search scopes |

---

## 5. Theme System (CSS Custom Properties)

### 5.1 Why Not Mailspring's LESS Approach

| Aspect | Mailspring (LESS) | New Client (CSS Vars) |
|---|---|---|
| Compiler needed | LESS (~450KB bundled) | None (native browser) |
| Theme switch speed | Recompiles all stylesheets | Instant — CSS vars cascade |
| Build integration | Complex (compile cache) | Zero — works with Tailwind |
| Debugging | Compiled CSS opaque | Live in DevTools |
| Plugin themes | Must provide .less files | Must provide .css file |

### 5.2 How It Works

**Step 1 — Base tokens defined in `src/globals.css`:**
```css
:root {
  --mail-bg-primary: #ffffff;
  --mail-bg-secondary: #f5f5f5;
  --mail-bg-tertiary: #e8e8e8;
  --mail-text-primary: #1a1a1a;
  --mail-text-secondary: #5a5a5a;
  --mail-accent: #0078d4;           /* Outlook blue */
  --mail-accent-hover: #106ebe;
  --mail-accent-light: #deecf9;
  --mail-border: #d1d1d1;
  --mail-sidebar-bg: #f0f0f0;
  --mail-sidebar-hover: #e0e0e0;
  --mail-sidebar-active: #c7e0f4;
  --mail-unread-indicator: #0078d4;
  --mail-flag-color: #c43e2c;
  --mail-ribbon-bg: #f0f0f0;
  --mail-ribbon-button-hover: #d5d5d5;
  /* ... ~50 semantic tokens */
}
```

**Step 2 — Theme package overrides tokens:**
```css
/* plugins/theme-outlook-dark/styles/theme.css */
[data-theme="outlook-dark"] {
  --mail-bg-primary: #1e1e1e;
  --mail-bg-secondary: #2d2d2d;
  --mail-text-primary: #e0e0e0;
  --mail-accent: #4da3e0;
  --mail-border: #404040;
  /* ... override all tokens */
}
```

**Step 3 — Theme switching (instant, no compiler):**
```typescript
class ThemeManager {
  async setActiveTheme(themeName: string) {
    document.querySelector('[data-theme]')?.remove();
    const style = document.createElement('style');
    style.dataset.theme = themeName;
    style.textContent = await readThemeCSS(themeName);
    document.head.appendChild(style);
    // All CSS custom properties cascade instantly
  }
}
```

---

## 6. Email Provider Abstraction

### 6.1 Unified Interface

```typescript
interface EmailProvider {
  // Connection
  testConnection(config: ServerConfig): Promise<ConnectionResult>;
  getProfile(): Promise<UserProfile>;

  // Folders
  listFolders(): Promise<Folder[]>;

  // Sync
  initialSync(folderId: string, options: SyncOptions): Promise<SyncResult>;
  deltaSync(folderId: string, syncState: string): Promise<SyncDelta>;

  // Messages
  fetchMessage(id: string): Promise<Message>;
  fetchAttachment(messageId: string, attachmentId: string): Promise<Uint8Array>;

  // Mutations
  applyActions(actions: EmailAction[]): Promise<void>;
  sendMessage(draft: DraftMessage): Promise<SentMessage>;

  // Calendar
  listCalendars(): Promise<Calendar[]>;
  syncEvents(calendarId: string, syncState?: string): Promise<EventSyncResult>;

  // Contacts
  syncContacts(syncState?: string): Promise<ContactSyncResult>;

  // Tasks
  syncTasks(syncState?: string): Promise<TaskSyncResult>;

  // Protocol metadata
  getCapabilities(): ProviderCapabilities;
}
```

### 6.2 Provider Comparison

| | GmailApiProvider | ImapSmtpProvider | EasProvider |
|---|---|---|---|
| **Implementation** | TypeScript, HTTP fetch | Rust via Tauri commands | TypeScript, HTTP fetch |
| **Protocol** | Gmail REST API | IMAP + SMTP | Exchange ActiveSync 16.1 |
| **Auth** | OAuth 2.0 (PKCE) | Password / OAuth 2.0 | OAuth 2.0 (Modern Auth) |
| **Email** | ✅ Full | ✅ Full | ✅ Full |
| **Calendar** | Google Calendar API | iCal parsing | ✅ EAS Calendar |
| **Contacts** | Google People API | CardDAV | ✅ EAS Contacts + GAL |
| **Tasks** | Google Tasks API | ✗ | ✅ EAS Tasks |
| **Push/Ping** | Pub/Sub | IDLE | Ping command |
| **Delta sync** | history.list + historyId | UIDVALIDITY + UIDNEXT | SyncKey state machine |

### 6.3 Provider Factory

```typescript
export function getEmailProvider(account: Account): EmailProvider {
  switch (account.provider) {
    case 'gmail_api': return new GmailApiProvider(account);
    case 'imap':      return new ImapSmtpProvider(account);
    case 'eas':       return new EasProvider(account);
  }
}
```

---

## 7. Exchange ActiveSync Provider

### 7.1 Strategy: Wrap User's Own EAS Library

The user provides a TypeScript EAS library with full protocol support. We wrap it in the `EmailProvider` interface using Velo's `gmailProvider.ts` as the adapter pattern reference.

**Effort**: ~150 lines of adapter/glue code (vs ~1,830 lines to re-implement from scratch).

### 7.2 Adapter Pattern (Reference: Velo `gmailProvider.ts`)

```typescript
// src/services/eas/easProvider.ts
import { MyEASClient } from 'my-eas-library';  // User's library
import type { EmailProvider } from '../email/types';

export class EasProvider implements EmailProvider {
  private client: MyEASClient;

  constructor(account: Account) {
    this.client = new MyEASClient({
      server: account.serverConfig.url,
      username: account.email,
      accessToken: account.credentials.accessToken,
      deviceId: this.getOrCreateDeviceId(),
      protocolVersion: '16.1',
    });
  }

  // Delegate all EmailProvider methods to user's EAS library:
  async listFolders(): Promise<Folder[]> { return this.client.folderSync(); }
  async initialSync(folderId: string, opts: SyncOptions): Promise<SyncResult> {
    return this.client.sync(folderId, { syncKey: '0', ...opts });
  }
  async deltaSync(folderId: string, syncState: string): Promise<SyncDelta> {
    return this.client.sync(folderId, { syncKey: syncState });
  }
  // ... remaining EmailProvider methods
}
```

### 7.3 Module Structure

```
src/services/eas/
├── provider.ts        # EasProvider class (~150 lines of adapter code)
└── types.ts           # EAS-specific type extensions (if needed)
```

### 7.4 Provider Registration

```typescript
// src/services/email/providerFactory.ts — extend the switch:
case 'eas':
  return new EasProvider(account);
```

---

## 8. AI Pipeline

## 8. AI Pipeline

### 8.1 Provider Abstraction

```typescript
interface AIProvider {
  id: string;
  chat(messages: Message[], opts?: ChatOptions): Promise<ChatResponse>;
  streamChat(messages: Message[], opts?: ChatOptions): AsyncIterable<ChatChunk>;
  supportsFeature(feature: AIFeature): boolean;
}
```

**Built-in providers:** OpenAI, Anthropic, Google Gemini, Ollama (local), OpenRouter (aggregator)

### 8.2 AI Features

| Feature | Trigger | Description |
|---|---|---|
| **Summarize** | Button / auto | Summarize thread or single message |
| **Categorize** | Auto on sync | Classify emails into categories (rules → AI fallback) |
| **Compose** | Prompt input | Generate full email draft from natural language |
| **Quick Reply** | Inline suggestions | Suggest 3 short replies (like Gmail Smart Reply) |
| **Smart Search** | Search bar | Natural language: "emails from John about Q4 budget" |
| **Task Extract** | Auto / button | Extract action items from email text |
| **Writing Style** | Settings | Analyze writing style, match tone in AI replies |
| **Meeting Brief** | Before meetings | Summarize calendar event + related emails |

### 8.3 AI Caching

```
SQLite ai_cache:
  provider | feature  | input_hash | output          | created_at | expires_at
  ──────────────────────────────────────────────────────────────────────────
  openai   | summarize| a3f21b...  | "This thread..." | 1719000000 | 1719604800
  anthropic| compose  | b7c92d...  | "Dear John,..."  | 1719000000 | 1719003600

Cache key: SHA256(provider + feature + input_content)
TTL per feature: summarize=7d, quickReply=1h, categorize=30d, compose=1h
```

---

## 9. Database Schema (SQLite)

### 9.1 Core Tables

```sql
-- Accounts
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  provider TEXT NOT NULL,  -- 'gmail_api', 'imap', 'eas'
  display_name TEXT,
  server_config TEXT,      -- JSON blob: IMAP/SMTP/EAS server details
  credentials_encrypted TEXT,  -- AES-256-GCM encrypted
  created_at INTEGER,
  updated_at INTEGER
);

-- Messages
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  thread_id TEXT,
  message_id_header TEXT,
  subject TEXT,
  from_json TEXT,
  to_json TEXT,
  cc_json TEXT,
  bcc_json TEXT,
  date INTEGER,
  body_html TEXT,
  body_text TEXT,
  snippet TEXT,
  is_read INTEGER DEFAULT 0,
  is_starred INTEGER DEFAULT 0,
  is_flagged INTEGER DEFAULT 0,
  has_attachments INTEGER DEFAULT 0,
  labels TEXT,         -- JSON array
  raw_size INTEGER,
  server_uid TEXT
);
CREATE INDEX idx_msg_account_folder ON messages(account_id, folder_id);
CREATE INDEX idx_msg_thread ON messages(thread_id);

-- FTS5 full-text search
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, body_text, from_names, to_names,
  content=messages, content_rowid=rowid
);

-- Threads (denormalized for display)
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  subject TEXT,
  snippet TEXT,
  message_count INTEGER DEFAULT 1,
  unread_count INTEGER DEFAULT 0,
  has_attachment INTEGER DEFAULT 0,
  last_message_date INTEGER,
  last_message_from TEXT,
  labels TEXT
);

-- Folders
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT,  -- inbox, sent, drafts, trash, spam, archive, custom
  parent_id TEXT,
  server_id TEXT,
  sync_enabled INTEGER DEFAULT 1
);

-- Attachments
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  content_id TEXT,
  cached_path TEXT
);

-- Contacts
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT,
  email TEXT,
  phone TEXT,
  company TEXT,
  title TEXT,
  avatar_url TEXT,
  server_uid TEXT
);

-- Calendar Events
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  calendar_id TEXT,
  subject TEXT,
  location TEXT,
  start_time INTEGER,
  end_time INTEGER,
  is_all_day INTEGER DEFAULT 0,
  recurrence TEXT,     -- JSON: RRULE-like structure
  attendees_json TEXT,
  body_text TEXT,
  server_uid TEXT
);

-- Tasks
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  subject TEXT,
  due_date INTEGER,
  priority TEXT,
  status TEXT,
  body_text TEXT,
  server_uid TEXT
);

-- AI cache
CREATE TABLE ai_cache (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  feature TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output TEXT,
  created_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX idx_ai_cache_lookup ON ai_cache(provider, feature, input_hash);

-- Sync state (per-account per-folder)
CREATE TABLE sync_state (
  account_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  sync_key TEXT,
  sync_token TEXT,
  last_sync_at INTEGER,
  PRIMARY KEY (account_id, folder_id)
);

-- App settings
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Plugin config
CREATE TABLE plugin_config (
  plugin_name TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (plugin_name, key)
);

-- Offline queue
CREATE TABLE offline_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload TEXT,       -- JSON
  created_at INTEGER,
  retry_count INTEGER DEFAULT 0,
  next_retry_at INTEGER
);
```

### 9.2 Migration Strategy

- Version-tracked: `001_init.sql`, `002_add_tasks.sql`, ...
- Run at startup before any data access
- Each migration wrapped in a transaction

---

## 10. Sync Engine

### 10.1 Sync Flow

```
App startup
  → Load all accounts
  → For each account:
    → getEmailProvider(account)
    → SyncManager.sync(provider, account):
      1. listFolders() — diff with local → add/remove folders
      2. For each synced folder:
        a. Read last sync_token from sync_state table
        b. No token → initialSync(folder) — full fetch, paginated
        c. Has token → deltaSync(folder, token) — changes only
        d. Upsert messages + threads + update FTS5 index
        e. Save new sync_token
      3. Emit 'sync-complete' event to notify UI + plugins
  → Start background sync:
    - Gmail: 60s polling (history.list with historyId)
    - IMAP: 120s polling (IDLE where supported)
    - EAS: Ping command (60s heartbeat) or 120s polling
  → Start background checkers:
    - Snooze checker (every 60s)
    - Scheduled send checker (every 30s)
    - Follow-up reminder checker (every 5min)
```

### 10.2 Offline Queue

```
All mutations via centralized emailActions service:
  1. Optimistic: Update local SQLite immediately (UI feels instant)
  2. Enqueue: Add to offline_queue with action type + payload
  3. Process: queueProcessor runs every 30s
     → Try: provider.applyActions(queuedActions)
     → Success: dequeue
     → Failure: Exponential backoff (60s → 300s → 900s → 3600s)
  4. Compact: Deduplicate redundant operations (e.g., markRead → markUnread → markRead)
```

---

## 11. UI Design (Outlook-Like)

### 11.1 Component-to-Library Mapping

| UI Element | Library | Notes |
|---|---|---|
| Three-panel layout | `@window-splitter/react` | Resizable, keyboard-accessible, ARIA-compliant |
| Folder tree | React Aria `<Tree>` | Drag-and-drop reparenting |
| Message list | React Aria `<Table>` + `ResizableTableContainer` | Column resize, sort, multi-select |
| Ribbon toolbar | React Aria `<Toolbar>` + `<TabList>` | Outlook-style grouped buttons |
| Composer | Tiptap (ProseMirror) | Rich text editing with AI assist |
| Context menus | React Aria `<Menu>` + `<Popover>` | Position at click coordinates |
| Address input | React Aria `<ComboBox>` + `<TagGroup>` | Recipient autocomplete with pills |
| Dialogs | React Aria `<Dialog>` + `<Modal>` | Settings, compose pop-out |
| Forms | React Aria form components | All settings UI |
| Search bar | React Aria `<SearchField>` | Gmail-style operator search |
| Command palette | React Aria `<ComboBox>` + `<Popover>` | Quick actions (Ctrl+K) |
| Virtual scrolling | `@tanstack/react-virtual` (primary) / `@react-aria/virtualizer` (when stable) | Large lists at 60fps |

### 11.2 React Aria + Tailwind Styling Pattern

```tsx
// Example: Outlook-styled folder tree
import { Tree, TreeItem, TreeItemContent } from 'react-aria-components';

<Tree selectionMode="single" className="flex flex-col gap-0.5 p-2">
  <TreeItem id="inbox">
    <TreeItemContent
      className={({ isSelected, isFocused }) =>
        `flex items-center gap-2 px-3 py-1.5 rounded-md text-sm cursor-pointer
         ${isSelected
           ? 'bg-[var(--mail-sidebar-active)] text-[var(--mail-text-primary)] font-semibold'
           : ''}
         ${isFocused && !isSelected ? 'bg-[var(--mail-sidebar-hover)]' : ''}
         hover:bg-[var(--mail-sidebar-hover)]`
      }
    >
      {({ hasChildItems, isExpanded }) => (
        <>
          {hasChildItems && (
            <Chevron className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
          )}
          <InboxIcon className="w-4 h-4 text-[var(--mail-accent)]" />
          <span className="flex-1">Inbox</span>
          <span className="text-xs text-[var(--mail-text-secondary)]">2.3k</span>
        </>
      )}
    </TreeItemContent>
  </TreeItem>
</Tree>
```

---

## 12. State Management (Zustand)

| Store | Responsibility | Key State |
|---|---|---|
| `uiStore` | UI preferences | theme, density, readingPanePosition, sidebarNavConfig, fontScale, accent, reduceMotion |
| `accountStore` | Email accounts | accounts[], activeAccountId |
| `mailboxStore` | Current mailbox | threads[], selectedThreadIds, searchQuery, isLoading, sortOrder |
| `messageStore` | Active message | activeMessage, body, attachments |
| `composerStore` | Email composition | isOpen, mode, to/cc/bcc, subject, body, draftId |
| `folderStore` | Folder hierarchy | folders[], unreadCounts |
| `calendarStore` | Calendar data | events[], currentView, selectedDate |
| `contactStore` | Contacts | contacts[], searchQuery |
| `taskStore` | Tasks | tasks[], groupBy, filter |
| `pluginStore` | Plugin state | plugins[], activePlugins, themeName |
| `shortcutStore` | Keybinds | keyMap (layered: base → plugin → user) |

**Pattern (from Velo):** Zustand `create()` with manual persistence via `setSetting(key, value)` → SQLite.

---

## 13. Security

| Concern | Implementation |
|---|---|
| Credential storage | AES-256-GCM encrypted in SQLite |
| OAuth tokens | Encrypted, auto-refreshed 5min before expiry |
| HTML sanitization | DOMPurify on all email bodies |
| Remote images | Blocked by default, per-sender allowlist |
| Phishing detection | 10 heuristic rules (from Velo) |
| SPF/DKIM/DMARC | Badge display in reading pane |
| Plugin sandboxing | PluginContext API only — no direct DOM/DB/filesystem access |
| CSP headers | Strict Content-Security-Policy in Tauri config |
| Update signing | Tauri updater with signed binaries |

---

## 14. Performance Strategy

| Strategy | Detail |
|---|---|
| Rust backend | All IMAP/SMTP I/O in Rust — no Node.js bottleneck |
| SQLite WAL mode | Concurrent reads, single writer (sync engine) |
| FTS5 search | Sub-millisecond full-text queries |
| Virtualized lists | React Aria or `@tanstack/react-virtual` — render only visible rows |
| Deferred plugins | Non-critical plugins load after 2.5s (Mailspring pattern) |
| AI caching | SQLite `ai_cache` — avoids redundant LLM API calls |
| Attachment cache | Local filesystem with LRU eviction |
| Delta sync | Sync tokens — transfer only changes, not full folders |
| Code splitting | Lazy routes for Settings, Calendar, Help, Tasks |
| Bundle optimization | React Aria sub-path imports + locale plugin |

---

## 15. Project Structure

```
velomail/
├── src-tauri/                     # Rust backend (Tauri)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── imap.rs
│   │   │   ├── smtp.rs
│   │   │   ├── oauth.rs
│   │   │   └── system.rs
│   │   ├── imap/
│   │   │   ├── mod.rs
│   │   │   ├── client.rs
│   │   │   └── types.rs
│   │   ├── smtp/
│   │   │   ├── mod.rs
│   │   │   └── client.rs
│   │   └── crypto/
│   │       └── mod.rs
│   └── icons/
├── src/                           # Frontend (React + TypeScript)
│   ├── main.tsx
│   ├── App.tsx
│   ├── globals.css                # Tailwind + base theme tokens
│   ├── router/
│   │   ├── index.ts
│   │   ├── routeTree.tsx
│   │   └── navigate.ts
│   ├── stores/                    # Zustand stores (~10)
│   ├── services/
│   │   ├── email/                 # EmailProvider abstraction
│   │   │   ├── types.ts
│   │   │   ├── providerFactory.ts
│   │   │   ├── gmailProvider.ts
│   │   │   ├── imapSmtpProvider.ts
│   │   │   └── easProvider.ts
│   │   ├── eas/                   # EAS adapter (wraps user's library)
│   │   │   ├── provider.ts        # ~150 lines — implements EmailProvider
│   │   │   └── types.ts           # EAS-specific type extensions
│   │   ├── sync/
│   │   │   ├── syncManager.ts
│   │   │   └── queueProcessor.ts
│   │   ├── ai/
│   │   │   ├── provider.ts
│   │   │   ├── openaiProvider.ts
│   │   │   ├── anthropicProvider.ts
│   │   │   ├── googleProvider.ts
│   │   │   ├── ollamaProvider.ts
│   │   │   ├── cache.ts
│   │   │   ├── features/
│   │   │   └── pipeline.ts
│   │   ├── db/                    # SQLite queries + migrations
│   │   ├── plugins/               # Plugin system
│   │   │   ├── pluginLoader.ts
│   │   │   ├── pluginManager.ts
│   │   │   ├── componentRegistry.ts
│   │   │   ├── commandRegistry.ts
│   │   │   ├── configRegistry.ts
│   │   │   ├── themeManager.ts
│   │   │   └── pipelines/
│   │   ├── search/
│   │   ├── composer/
│   │   ├── notifications/
│   │   ├── calendar/
│   │   ├── contacts/
│   │   ├── tasks/
│   │   └── utils/
│   ├── components/
│   │   ├── layout/                # AppShell, Sidebar, MessageList, ReadingPane
│   │   ├── ribbon/                # Ribbon, tabs, buttons
│   │   ├── composer/              # Composer, AddressInput, AIAssist
│   │   ├── folders/               # FolderTree, FolderContextMenu
│   │   ├── messages/              # MessageTable, MessageRow, MessageView
│   │   ├── calendar/
│   │   ├── contacts/
│   │   ├── tasks/
│   │   ├── settings/
│   │   ├── search/
│   │   └── shared/                # InjectedComponent, ContextMenu, SplitPanel, ErrorBoundary
│   ├── hooks/
│   └── types/
├── plugins/                       # Built-in plugins
│   ├── theme-outlook-classic/
│   │   ├── package.json
│   │   └── styles/theme.css
│   └── theme-outlook-dark/
│       ├── package.json
│       └── styles/theme.css
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.ts
```

---

## 16. Development Roadmap

### Phase 1: Foundation (Weeks 1-4)
- Scaffold Tauri + React + Vite project
- Port IMAP/SMTP Rust backend from Velo
- Set up SQLite schema + version-tracked migrations
- Implement EmailProvider interface + Gmail + IMAP providers
- Build three-panel layout (sidebar | message list | reading pane)
- Basic message list + reading pane with IMAP data
- Custom titlebar + system tray

### Phase 2: Plugin System (Weeks 5-6)
- PluginLoader: discovery from /plugins/ and user data dir
- PluginManager: lifecycle (validate → activate → deactivate)
- ComponentRegistry + InjectedComponent/InjectedComponentSet renderers
- ConfigRegistry: per-plugin Zod schemas, persistence
- CommandRegistry + layered keymap merge
- ThemeManager: CSS custom property injection, live switching
- 2-3 example plugins + 2 theme packages

### Phase 3: AI Integration (Weeks 7-8)
- AI provider abstraction (OpenAI, Anthropic, Google, Ollama)
- AI pipeline with plugin-registerable hooks
- Features: summarize, categorize, compose, quick reply, smart search
- AI cache layer (SQLite)
- Composer with AI assist
- "Ask My Inbox" natural language search

### Phase 4: EAS + Full Sync (Weeks 7-8) — Reduced from 3 weeks to 2
- **Week 7**: Wrap user's EAS library in `EmailProvider` interface. Adapter pattern from Velo `gmailProvider.ts`. Device provisioning + AutoDiscover integration. SyncKey persistence in SQLite `sync_state`.
- **Week 8**: EAS mail + calendar + contact + task sync integration. Calendar UI. Contact + Task pages. End-to-end test against Exchange server.

### Phase 5: Polish (Weeks 9-11)
- Outlook-like Ribbon toolbar with grouped actions
- Rich text composer (Tiptap) with full formatting
- Offline queue with exponential backoff
- FTS5 search with Gmail-style operator parser
- Settings pages (General, Accounts, Notifications, AI, Shortcuts, Appearance)
- Performance optimization + bundle analysis
- Testing (unit + integration + E2E)

---

## 17. Risk Register

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| EAS library compatibility with Tauri fetch | Low | Low | User's library is TypeScript HTTP-based — compatible with Tauri webview `fetch()`. If issues: use `tauri-plugin-http` as bridge. |
| React Aria Table/Tree lacks stable virtualization | Medium | Medium-High | `@tanstack/react-virtual` as primary. React Aria `Virtualizer` when stable. |
| Plugin system adds startup latency | Medium | Low | Deferred loading + `syncInit` flag pattern proven in Mailspring. |
| React Aria mono-package tree-shaking | Low | Medium | Sub-path imports (`react-aria-components/Table`) + locale plugin. |
| Tauri cross-platform compatibility | Low | Low | Test on all 3 platforms from Phase 1. Velo already validates the Tauri stack. |
| AutoDiscover reliability across Exchange versions | Medium | Medium | Support V1 (POX) + V2 (JSON). Fallback to manual server config. |
| Microsoft deprecates EAS for Exchange Online | Medium | Low | Graph API provider can be added as additional backend. EAS needed for on-prem. |

---

## 18. Open Questions

1. **Project name?** — TBD. Suggestions: "Velomail", "Outlook Zero", "SpectraMail"
2. **License?** — Recommend Apache-2.0 (same as Velo) or AGPL-3.0 (if SaaS protection desired)
3. **Mac App Store?** — Tauri supports it but requires additional entitlements + notarization
4. **Mobile?** — Tauri v2 has mobile support (Android/iOS). Architecture supports it but NOT in initial scope
5. **EAS library integration** — Does the user's EAS library support OAuth 2.0 Modern Auth for Exchange Online, or only Basic/NTLM? Need to confirm before Phase 4.
6. **Total roadmap** — With EAS simplified to adapter-only (~150 lines), the total development timeline reduces from 14 weeks to ~11 weeks (Phase 4 shrinks from 3 weeks to 2).

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Kylins Client is a Tauri v2 desktop email client (codename `mailclient`) inspired by MS Outlook. The codebase is currently a **skeleton** — services, stores, and UI shells exist but most backend logic (EAS, IMAP, AI providers, plugin loading) is stubbed with `TODO` comments. The intended tech stack and architecture draw on open-source references available locally under `D:\Projects\mailclient\opensource` — Velo (`opensource/velo`) is the primary reference; `imapflow`, `Mailspring`, `thunderbird-desktop`, `ews-rs`, `google-apis-rs`, `graph-rs-sdk`, `jmap-client`, and `inbox-zero` are also consulted for protocol/provider patterns. See `docs/architecture.md` for the full design document.

## Repository Layout

This is a **split-package monorepo**, not a single Tauri project:

- `kylins.client.backend/` — Rust crate + Tauri config (`tauri.conf.json`, `Cargo.toml`, `src/`, `capabilities/`)
- `kylins.client.frontend/` — Vite + React 19 + TypeScript SPA (`package.json`, `src/`, `tests/`, `vite.config.ts`)
- `docs/architecture.md` — Full system design doc (source-reuse strategy from Velo/Mailspring/Inbox Zero)
- `screens/` — UI reference screenshots (Outlook, IntelliJ)
- `plugins/example-plugin/` lives under the frontend and is loaded via dynamic `import()` (see `services/plugins/pluginManager.ts`)

`tauri.conf.json` in the backend references the frontend via relative paths:
- `beforeDevCommand`: `cd ../kylins.client.frontend && npm run dev`
- `beforeBuildCommand`: `cd ../kylins.client.frontend && npm run build`
- `devUrl`: `http://localhost:5173`
- `frontendDist`: `../kylins.client.frontend/dist`

## Commands

**There is no top-level package.json.** Run commands inside the sub-packages.

### Frontend (`cd kylins.client.frontend`)

```bash
npm install
npm run dev          # Vite dev server on :5173 (matches tauri.conf.json devUrl)
npm run build        # tsc (type-check, noEmit) + vite build
npm run test         # Vitest in watch mode (note: NOT vitest run)
npm run preview      # Preview production build

# Run a single test file
npx vitest run tests/services/accounts.test.ts

# Type-check only
npx tsc --noEmit
```

### Backend (`cd kylins.client.backend`)

```bash
cargo build
cargo test

# Full Tauri dev app (also starts frontend via beforeDevCommand)
cargo tauri dev
# OR if tauri-cli is installed globally / via cargo install tauri-cli:
tauri dev

# Production bundle
cargo tauri build
```

`cargo tauri dev` is the canonical way to launch the full app during development. It spawns the Vite dev server itself, so you do **not** need to run `npm run dev` separately.

## Architecture

### Three-layer data flow

1. **Rust backend** (`kylins.client.backend/src/`)
   - `lib.rs` — Tauri `Builder` setup. Registers all plugins and the three IPC commands. `tauri_plugin_single_instance` must remain first (it is).
   - `commands.rs` — IPC handlers: `close_splashscreen`, `encrypt_secret`, `decrypt_secret`.
   - `crypto.rs` — AES-256-GCM encryption for secrets. Master key lives in the OS keyring (`keyring` crate, service `mailclient`, user `master-key`), auto-generated on first run. Nonce (12B) is prepended to ciphertext and the whole blob is hex-encoded.
   - Tauri plugins: single-instance, autostart (with `--hidden`), deep-link, global-shortcut, sql (sqlite), notification, opener, fs, dialog, process, os, log.
   - Two windows declared in `tauri.conf.json`: a splashscreen (400×300, undecorated, always-on-top) at URL `/splashscreen`, and the main window (1200×800, hidden until `close_splashscreen` is invoked).

2. **Service layer** (`kylins.client.frontend/src/services/`)
   - `db/connection.ts` — `getDb()` singleton (lazy `Database.load('sqlite:mailclient.db')`). Also exports `withTransaction()` which serializes transactions through a promise chain — use it for any multi-statement atomic write, since the SQL plugin does not guarantee serialize-by-default across concurrent callers.
   - `db/migrations.ts` — Version-tracked migrations (`_migrations` table). Each migration runs in a manual BEGIN/COMMIT. Add new migrations to the `MIGRATIONS` array; do not edit applied ones.
   - `accounts.ts`, `settings.ts` — Thin async wrappers over `db.select` / `db.execute`. `settings` is a key-value store.
   - `crypto.ts` — Frontend façade over the Rust `encrypt_secret` / `decrypt_secret` commands.
   - `plugins/pluginManager.ts` — Singleton `PluginManager`. Components, event handlers, and actions are registered into `Map`s. Dynamic `import(/* @vite-ignore */ path)` is used to load plugin modules; Vite requires the comment.
   - `plugins/pluginAPI.ts` — `PluginAPI` interface handed to a plugin's `activate(api)`.
   - `queue/offlineQueue.ts` — SQLite-backed retry queue (`pending_operations` table). Exponential backoff: `60 * (1 << retry_count)` seconds.
   - `ai/aiService.ts` — Wraps an `LLMProvider` and caches results in `ai_cache` (keyed by account+thread+type).
   - `ai/providers/{base,ollamaProvider,openaiProvider}.ts` — Provider interface + two stubs (both `TODO`).
   - `mail/provider.ts` — `MailProvider` interface. `mail/easProvider.ts` is a stub (`TODO: integrate custom EAS library`).
   - `theme/themeManager.ts` — Applies `light` / `dark` / `system` by toggling `<html>` class. Subscribes to `prefers-color-scheme` when in `system`.

3. **UI layer** (`src/components/`, `src/stores/`, `src/App.tsx`)
   - `App.tsx` runs the startup sequence: `runMigrations` → restore `theme` setting → `pluginManager.loadPlugins` / `activatePlugins` → `invoke('close_splashscreen')`. Until ready it shows a loading screen; on error a reload screen.
   - `components/layout/AppShell.tsx` — Three resizable panes via `react-resizable-panels` (`FolderPane` / `MessageList` / `ReadingPane`), plus `HeaderBar`, `CommandRibbon`, `ToolWindowBar` (left/right), `StatusBar`. This is the Outlook-style shell.
   - `components/email/SafeHtmlFrame.tsx` — Sandboxed `<iframe sandbox="">` (no `allow-same-origin`). DOMPurify sanitizes HTML, force-adds `target=_blank rel=noopener noreferrer` to anchors, injects CSS variable-derived theme styles into the iframe document.
   - `components/plugins/InjectedComponent.tsx` / `InjectedComponentSet.tsx` — Slot-based plugin injection. Subscribes to a synthetic `__registry_changed__` event emitted by the plugin manager whenever a component is registered/unregistered.
   - Two Zustand stores: `uiStore` (theme, pane widths, density, etc.) and `accountStore`.

### Plugin contract

A plugin module exports `activate(api: PluginAPI)` and optionally `deactivate()`. `api` exposes `registerComponent(role, Component)`, `onEvent`, `registerAction`, `unregisterAction`. See `plugins/example-plugin/main.ts`. The slot `role` strings (e.g. `header:right`, `folder-pane:header`, `reading-pane:footer`, `toolwindow:left`) are spread across the layout components and resolved at render time.

### Secrets handling

OAuth tokens, refresh tokens, and IMAP passwords go through `crypto.ts` → Rust `encrypt_secret`. Plaintext must never be written to SQLite. The `accounts` table stores `access_token` / `refresh_token` as hex-encoded `nonce || ciphertext` blobs.

## Styling

Tailwind CSS v4 via `@import "tailwindcss"` in `src/styles/globals.css`, paired with CSS custom properties in `src/styles/theme.css` (light + `.dark` overrides using `oklch()` colors). Components reference tokens via arbitrary value syntax (e.g. `bg-[var(--surface)]`, `text-[var(--muted-text)]`). The `@theme inline` block in `globals.css` maps Tailwind's `--color-*` names to the CSS vars.

## Testing

Vitest 4 + jsdom + Testing Library. Setup file: `src/test/setup.ts` (imports `@testing-library/jest-dom/vitest`). `globals: true` — no need to import `describe`/`it`/`expect`.

Tests live under `tests/` mirroring `src/` (not colocated like Velo). Tests mock `getDb()` and `@tauri-apps/api/core` / `@tauri-apps/plugin-sql` — they never hit a real database or Tauri runtime.

## Key Gotchas

- **Working directory for `cargo tauri dev`**: must be `kylins.client.backend/`. `tauri.conf.json` paths are relative to the backend crate.
- **No global `tauri` CLI installed.** Either run `cargo install tauri-cli --version "^2.5"` (or `cargo binstall tauri-cli`) once, or use the project-local `@tauri-apps/cli` (in frontend `devDependencies`) via `cd kylins.client.frontend && npm run tauri -- dev`. The latter needs the config path flag because of the split-package layout, so `cargo tauri dev` from the backend is the smoother path.
- **`react-resizable-panels` API**: `Group` / `Panel` / `Separator` are imported directly in `AppShell.tsx`. Check the installed version's exports if you see component-not-found errors — the v4 API has shifted between minor versions.
- **TypeScript strictness**: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess` are all on. Indexing into an array produces `T | undefined`, which trips many naive accesses.
- **Path alias**: `@/*` → `src/*`, wired in both `tsconfig.json` and `vite.config.ts` `resolve.alias`. New imports should prefer `@/` over deep relative paths.
- **Plugin loading is dynamic** — Vite must be able to resolve plugin paths at build time. The `/* @vite-ignore */` comment in `pluginManager.ts` is load-bearing; removing it breaks the build.
- **CSP** in `tauri.conf.json` allows `connect-src: 'self' https:` — broad, fine for dev. Tighten before release.
- **No `@tauri-apps/plugin-sql` preload** in `tauri.conf.json` (Velo uses `plugins.sql.preload: ["sqlite:velo.db"]`). Here the DB is opened lazily on first `getDb()` call. If you want it preloaded at startup, add the `preload` key.
- **Single instance plugin must be registered first** in `lib.rs` (it already is). It forwards argv to the existing instance via the `single-instance-args` event for deep-link handling.
- **Multi-page Vite build**: `index.html` (main app) and `splashscreen.html` are both rollup inputs. The splash window in `tauri.conf.json` points at `/splashscreen.html`. When adding a new top-level HTML entry, also add it to `vite.config.ts` `build.rollupOptions.input`.

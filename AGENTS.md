# AGENTS.md

Guidance for AI coding agents working in this repository. Assumes no prior
knowledge of the project. `CLAUDE.md` exists alongside this file but is partly
out of date — where they disagree, this file reflects the **current** code.

## Project Overview

Kylins Mail (Tauri identifier `com.mailclient.app`, codename `mailclient`) is a
Tauri v2 desktop email client inspired by MS Outlook. It is **not** a skeleton:
IMAP/SMTP, Exchange ActiveSync (EAS), OAuth, a Rust-owned SQLite store, a
background sync engine, contacts/calendar/tasks, a TipTap composer, a plugin
system, theming, and notifications are all implemented. Large parts of the
backend were ported from Velo (Apache-2.0); the EAS/WBXML codec was ported from
`mailkit_arkts`. See `ATTRIBUTIONS.md` and `docs/architecture.md`.

It targets Windows, macOS, and Linux. UI chrome (title bar, tray) is custom.

## Repository Layout (split-package monorepo)

There is **no top-level `package.json` / workspace manifest**. Work inside the
two sub-packages:

- `kylins.client.backend/` — Rust crate (`kylins-client-backend` / lib
  `kylins_client_lib`), Tauri config (`tauri.conf.json`), `Cargo.toml`,
  `src/`, `migrations/`, `capabilities/`, `tests/`.
- `kylins.client.frontend/` — Vite + React 19 + TypeScript SPA
  (`package.json`, `src/`, `tests/`, `plugins/example-plugin/`).
- `docs/` — design docs (architecture, sync-engine phases, RFC/, Exchange/
  protocol PDFs — large PDFs/zips are gitignored).
- `screens/` — UI reference screenshots.
- `assets/design-tokens.css` — shared design tokens.
- `.superpowers/` — **local-only, gitignored** brainstorming/SDD scratch. Do not
  read it as project truth and do not commit it.

The backend `tauri.conf.json` wires the frontend by relative path:
`beforeDevCommand`/`beforeBuildCommand` run npm in `../kylins.client.frontend`,
`devUrl` is `http://localhost:5173`, `frontendDist` is
`../kylins.client.frontend/dist`.

## Build & Test Commands

Run commands **inside the relevant sub-package**.

### Frontend (`cd kylins.client.frontend`)

```bash
npm install
npm run dev           # Vite dev server on :5173 (strictPort; matches tauri devUrl)
npm run build         # tsc (type-check, noEmit) + vite build
npm run preview       # preview the production build
npm run test          # Vitest in WATCH mode (note: not "run")
npm run lint          # eslint .
npm run lint:fix      # eslint . --fix
npm run format        # prettier --write .
npm run format:check  # prettier --check .

npx vitest run                        # run the whole suite once (what CI does)
npx vitest run tests/path/to.test.ts  # run a single file
npx tsc --noEmit                      # type-check only
npm run tauri -- dev                  # tauri CLI via local @tauri-apps/cli
```

### Backend (`cd kylins.client.backend`)

```bash
cargo check
cargo build
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings

cargo tauri dev     # canonical full-app dev launch (spawns the Vite server itself)
cargo tauri build   # production bundle
```

`cargo tauri dev` must be run from `kylins.client.backend/` (config paths are
relative to the crate) and it starts the frontend for you — do **not** run
`npm run dev` separately. If `cargo tauri` is unavailable, install it once with
`cargo install tauri-cli --version "^2.10"` (or `cargo binstall tauri-cli`), or
use the frontend's local CLI via `npm run tauri -- dev` (which needs a config
path flag because of the split layout).

## Runtime Architecture

### Three layers

1. **Rust backend** (`kylins.client.backend/src/`) is the source of truth for
   mail I/O, the database, secrets, and background sync.
   - `lib.rs` — Tauri `Builder`. Registers plugins and every IPC command in one
     `invoke_handler!`. `tauri_plugin_single_instance` is registered **first**
     (must stay first; it re-emits argv as `single-instance-args`). The `setup`
     hook installs the log plugin, a panic→log hook, opens the SQLite pool, and
     constructs the `SyncEngine`. A system tray is built (Tauri tray on
     Windows/macOS; `tray-item`/KSNI on Linux). Closing the main window hides it
     to tray instead of quitting; `--hidden` (autostart) starts it hidden. On
     Windows it sets the AUMID `com.mailclient.app` so toasts attribute
     correctly.
   - `commands.rs` — app/fs/notification/autostart/cache commands plus the IMAP
     (`imap_*`) and SMTP (`smtp_*`) command surface.
   - `crypto.rs` — AES-256-GCM. The 32-byte master key is stored in the OS
     keyring (service `mailclient`, user `master-key`) and auto-generated on
     first run. Output is `hex(nonce[12] || ciphertext)`.
   - `oauth.rs` — localhost loopback callback server + token exchange/refresh
     (`start_oauth_server`, `oauth_exchange_token`, `oauth_refresh_token`).
   - `mail/imap/` (`client.rs`, `session_manager.rs`, `types.rs`) and
     `mail/smtp/` — async-imap + lettre clients; `mail/builder.rs` builds
     outbound MIME (mail-builder).
   - `eas/` — ActiveSync: `wbxml/` codec (serializer/deserializer/code pages),
     `client.rs`, `service.rs` (`eas_*` commands), `auth`, `autodiscover`,
     `provision`, `status`, `types`.
   - `sync/contacts/` — CardDAV, Google People, EAS GAL, vCard parse/export.
   - `sync_engine/` — the background mail-sync engine (see below).
   - `db/` — the SQLite layer (see below).

2. **Service layer** (`kylins.client.frontend/src/services/`) — thin TypeScript
   over `invoke(...)`. Notable: `accounts.ts`, `settings.ts`, `crypto.ts`
   (façade over `encrypt_secret`/`decrypt_secret`), `db/*.ts` (one wrapper per
   table), `mail/{provider,imapProvider,easProvider,smtpSender}.ts`,
   `composer/*` (draft autosave, send, juice CSS inlining, sanitize),
   `calendar/*`, `ai/*` (provider + cache + task extraction),
   `plugins/{pluginManager,pluginAPI,builtInPlugins,extensions}.ts`,
   `queue/offlineQueue.ts`, `shortcuts/*`, `theme/themeManager.ts`,
   `notifications/notificationManager.ts`, `tray/traySync.ts`.

3. **UI layer** (`src/components/`, `src/features/`, `src/stores/`,
   `src/App.tsx`) — React 19 + Zustand. `App.tsx` runs the startup sequence
   (restore theme/skin → hydrate shortcut/preferences stores → load + activate
   plugins → `refreshAccounts` → `invoke('sync_start')`). It shows a loading
   screen until ready and a reload screen on error. It also detects pop-out
   windows via URL params (`readComposeWindowParams` / `readViewerWindowParams`)
   and renders a lightweight `<Composer windowed>` or `<MessageViewerWindow>`
   instead of the full shell.

### Database: Rust is the sole writer

The frontend **`@tauri-apps/plugin-sql` dependency has been removed** on both
sides. Rust owns every table read and write through `sqlx`; the frontend reaches
data only by `invoke('db_*')` (see `backend/src/db/commands.rs` and the
passthrough wrappers in `frontend/src/services/db/*.ts`). The four secret
account fields are encrypted by Rust inside those commands, so the frontend
never handles secret plaintext and never writes it to SQLite.

- Pool/config (`db/mod.rs::init_db`): `mailclient.db` in the OS app-data dir,
  WAL mode, `foreign_keys=ON`, `busy_timeout=30s`, `max_connections=5`,
  `acquire_timeout=5s`.
- Migrations live in `kylins.client.backend/migrations/` and are embedded at
  compile time via `sqlx::migrate!("./migrations")`; sqlx tracks them in its own
  `_sqlx_migrations` table. The baseline is one consolidated, idempotent
  snapshot (`IF NOT EXISTS` everywhere) so it applies cleanly over DBs created
  by the legacy frontend migration runner (whose `_migrations` table is kept for
  compatibility).
- `db/` has one module per table/area: `accounts`, `settings`, `labels`
  (folders), `threads`, `messages`, `message_bodies`, `attachments`, `mutations`,
  `queue` (`pending_operations`), `contacts` (+ groups), `signatures`, `drafts`,
  `send_as_aliases`, `calendar_events`, `calendars`, `tasks`, `scheduled_emails`,
  `templates`, `ai_cache`, `contact_sync_state`, `image_allowlist`,
  `rate_limit`, `sync_state`, `search` (FTS5). Dynamic UPDATE/SELECT helpers
  (`exec_dynamic_update`, `exec_dynamic_select_filter`, `BindValue`) live in
  `db/mod.rs`.

Gotcha: `tauri.conf.json` still declares `plugins.sql.preload:
["sqlite:mailclient.db"]`, but `tauri-plugin-sql` is **not** a Cargo dependency
and is **not** registered in `lib.rs`, so that preload is inert at runtime. DB
access goes through the sqlx pool managed as Tauri `State`.

### Sync engine

`sync_engine/engine.rs` is a process singleton (Tauri-managed state) that owns
one `AccountWorker` (Tokio task) per active account. Each worker runs a wakeable
loop: list folders → upsert labels → per-folder `sync_folder(cursor)` →
`apply_folder_delta` → advance cursor → emit `sync:*` events. Cadence is
IDLE-aware: 60s poll-only, 300s backstop when an IMAP IDLE watcher covers INBOX.
A per-account circuit breaker backs off on consecutive `list_folders` failures
(15s at 3 failures, 60s at 5; resets on success). `MailSource`
(`imap_source.rs`, `eas_source.rs`) is the provider abstraction; `EventSink`
(`TauriEmitter` in prod, `TestSink` in tests) is the test seam so the engine is
drivable without a WebView. IPC surface: `sync_start`, `sync_stop`,
`sync_account_now`, `sync_request_bodies`, `sync_fetch_attachment`,
`sync_fetch_inline_images`, `sync_apply_mutation`, `reconcile_attachment_cache`.

### Frontend state and UI

- **Stores** (Zustand, `src/stores/`): `uiStore`, `accountStore`,
  `accountSetupStore`, `folderStore`, `threadStore`, `composerStore`,
  `contactStore`, `calendarStore`, `taskStore`, `preferencesStore`,
  `shortcutStore`, `toastStore`. Plus feature stores under `src/features/`
  (e.g. `view/viewStore.ts`).
- **Shell**: `components/layout/AppShell.tsx` is the Outlook-style three-pane
  layout (`react-resizable-panels` v4 — `Group`/`Panel`/`Separator`) with a
  custom title bar, command ribbon, tool-window bars, and status bar.
- **Safe HTML**: `components/email/SafeHtmlFrame.tsx` renders message bodies in a
  sandboxed `<iframe sandbox="">` (no `allow-same-origin`); DOMPurify sanitizes,
  anchors are forced to `target=_blank rel=noopener noreferrer`, and
  theme-derived CSS is injected into the iframe.
- **Plugins**: slot-based injection (`InjectedComponent` /
  `InjectedComponentSet`). A plugin module exports `activate(api)` (and optional
  `deactivate`); `api` exposes `registerComponent(role, …)`, `onEvent`,
  `registerAction`, `unregisterAction`. `pluginManager.ts` loads modules with
  `import(/* @vite-ignore */ path)` — the `/* @vite-ignore */` comment is
  load-bearing; do not remove it. Slot roles (e.g. `header:right`,
  `reading-pane:footer`) are resolved at render time. The example plugin lives
  at `frontend/plugins/example-plugin/`.

## Windows, Entries, and Splash

`tauri.conf.json` declares a **single** window (`main`, 1200×800, `decorations:
false`, `visible: true`, `maximized: true`, `dragDropEnabled: false`); the title
bar is rendered in React. Vite still builds **two** rollup inputs — `index.html`
and `splashscreen.html` (`vite.config.ts → build.rollupOptions.input`). Composer
and message-viewer pop-outs are the same SPA entry, switched by URL params (not
separate Tauri windows). When adding a new top-level HTML entry, register it in
both the Vite inputs and any window that points at it.

## Code Style & Conventions

- **TypeScript**: `strict` plus `noUnusedLocals`, `noUnusedParameters`,
  `noUncheckedIndexedAccess` (indexing yields `T | undefined`). Path alias
  `@/* → src/*` is wired in `tsconfig.json`, `vite.config.ts`, and
  `vitest.config.ts` — prefer `@/` over deep relative paths.
- **ESLint 10** flat config (`eslint.config.mjs`): JS + TS recommended, React
  Hooks rules enforced, `react-refresh/only-export-components` warn,
  `no-undef` off for TS, unused vars allowed when `_`-prefixed, Prettier-compat
  last. **Prettier**: 2-space, single quotes, semicolons, trailing commas,
  `printWidth: 100`, LF. ESLint owns correctness; Prettier owns formatting.
- **Rust**: `cargo fmt` and `cargo clippy --all-targets -- -D warnings` are
  gates (CI fails on warnings). Edition 2021, `rust-version = 1.77.2`.
- **Git hooks**: Husky pre-commit runs `lint-staged` (ESLint --fix on TS/JS,
  Prettier on the rest). The PR checklist (`.github/pull_request_template.md`)
  requires `cargo check`, `cargo test`, `npx tsc --noEmit`, `npx vitest run`,
  no new `any`/`@ts-ignore`, a new migration for any schema change (never edit
  an applied one), and secrets routed through Rust crypto.
- Comments and docs are in English; many ported files carry a
  `// Ported from velo … See ATTRIBUTIONS.md` header — preserve it.

## Testing

- **Frontend**: Vitest 4 + jsdom + Testing Library (`vitest.config.ts`;
  `globals: true` — no need to import `describe/it/expect`; setup file
  `src/test/setup.ts` adds jest-dom and a `ResizeObserver` mock). Tests live
  under `tests/` mirroring `src/`. They mock `@tauri-apps/api/core` `invoke` and
  stores — never a real DB or Tauri runtime. `npm test` is watch mode; CI uses
  `npx vitest run`.
- **Backend**: `cargo test`. Unit tests are colocated in modules (e.g.
  `db/mod.rs` migration-idempotency tests). Integration tests in
  `backend/tests/` (`imap_smtp_integration`, `imap_condstore_integration`,
  `imap_persistent_session_integration`, `eas_integration`) hit **live** mail
  servers and are `#[ignore]`d by default; they read credentials from env vars
  (`KYLINS_IMAP_*`, `KYLINS_SMTP_*`, `KYLINS_EMAIL`, `KYLINS_PASSWORD`, …) and
  must run serialized: `cargo test --test imap_smtp_integration -- --ignored
  --nocapture --test-threads=1`. CI runs `cargo test -- --skip accounts`
  (skips the `#[ignore]`d/live set). `Test-ImapLogin.ps1` is a standalone
  PowerShell STARTTLS/LOGIN probe for an on-prem Exchange.

## CI / CD

- `.github/workflows/ci.yml` (PRs to `main`): frontend `npm ci` → `tsc --noEmit`
  → `eslint .` → `vitest run`; backend `cargo check` → `cargo fmt --check` →
  `cargo clippy --all-targets -- -D warnings` → `cargo test -- --skip accounts`
  on `ubuntu-latest` (installs `libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev`).
- `.github/workflows/release-please.yml` drives `release-please` on pushes to
  `main`; when a release is created it calls `release.yml`.
- `.github/workflows/release.yml` builds via `tauri-apps/tauri-action@v0`
  (`projectPath: kylins.client.backend`) on Windows + Ubuntu 22.04 and a
  universal-2 (unsigned) macOS build, uploading to the GitHub release.

## Security Considerations

- **Secrets**: OAuth tokens, refresh tokens, and IMAP/SMTP passwords go through
  `services/crypto.ts` → Rust `encrypt_secret` (AES-256-GCM, keyring-backed
  master key). The `accounts` table stores them as `hex(nonce||ciphertext)`.
  Never write secret plaintext to SQLite; never log it.
- **CSP** (`tauri.conf.json`) is an explicit allowlist: `default-src 'self'`,
  inline styles allowed, `connect-src` limited to `'self' https:` plus the local
  Ollama/LM Studio ports (`11434`, `1234`), `img-src` includes
  `data: blob: https: asset:`, `frame-src 'self'`. Tighten further before
  release rather than loosening.
- **Asset protocol** scope is restricted to
  `$APPDATA/attachment-cache/**` and `$APPDATA/outbox-attachments/**`.
- **Capabilities** (`capabilities/default.json`) grant only the app-data fs
  scopes plus the used plugins. The frontend fs plugin cannot reach arbitrary
  disk paths, so attachment staging/saving crosses the app-data↔disk boundary
  via Rust commands (`stage_picked_attachment`, `copy_cached_attachment`,
  `write_binary_file`) that sanitize filenames and run as `std::fs`.
- **HTML rendering** is sandboxed (DOMPurify + `sandbox=""` iframe, no
  `allow-same-origin`); remote images are gated by the `image_allowlist` table.
- **Migrations**: additive-only. Never edit an applied migration; add a new
  `YYYYMMDDHHMMSS_<name>.sql` file. The baseline is idempotent by design.

## Key Gotchas

- Run `cargo tauri dev` from `kylins.client.backend/`; config paths are relative
  to the crate.
- `tauri-plugin-single-instance` must stay first in `lib.rs`.
- Do not delete the `/* @vite-ignore */` comment in `pluginManager.ts`.
- The `plugins.sql.preload` key in `tauri.conf.json` is vestigial — Rust owns
  the DB via sqlx; frontend data access is `invoke('db_*')`, not plugin-sql.
- `noUncheckedIndexedAccess` means array/record access is `T | undefined`;
  handle the `undefined` case explicitly.
- Tests must not require a real Tauri runtime or live mail server (those are
  `#[ignore]`d / mocked).
- `.superpowers/` and the large `docs/Exchange/*.pdf|zip` are gitignored/local
  only — don't treat them as authoritative and don't commit them.

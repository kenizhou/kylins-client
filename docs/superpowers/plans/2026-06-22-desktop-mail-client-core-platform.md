# Desktop Mail Client — Core Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the core platform for a Tauri-based desktop email client with SQLite, credential encryption, plugin/theme hooks, AI provider skeleton, EAS provider skeleton, and an Outlook-style three-pane shell.

**Architecture:** Velo-style monolithic Tauri + TypeScript service layer. Rust handles native shell, security, and IMAP/SMTP commands. TypeScript service layer handles business logic, account management, migrations, plugins, themes, AI abstraction, and EAS integration. React UI uses React Aria Components + Tailwind + Zustand.

**Tech Stack:** Tauri v2, React 19, TypeScript 5.x, Vite 6+, Tailwind CSS v4, React Aria Components, Zustand, SQLite via `tauri-plugin-sql`, Vitest, Playwright.

## Global Constraints

- Tauri v2 with capability-based permissions.
- Single SQLite database (`mailclient.db`) via `tauri-plugin-sql`.
- AES-256-GCM credential encryption in Rust; key in OS keychain.
- Plugins are dynamic ES modules loaded from `plugins/` at runtime.
- Themes override CSS custom properties (`--color-*`).
- React Aria Components + Tailwind for UI; no Adobe Spectrum styling required.
- Cross-platform: Windows, macOS, Linux.
- TDD: write tests before implementation for service-layer logic.

---

## File Structure Overview

```
mailclient/
├── src/
│   ├── main.tsx                 # React entry point
│   ├── App.tsx                  # Root app component + initialization
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AppShell.tsx     # IntelliJ + Outlook layout shell
│   │   │   ├── HeaderBar.tsx    # IntelliJ simplified main toolbar
│   │   │   ├── CommandRibbon.tsx # Outlook-style command menubar
│   │   │   ├── ToolWindowBar.tsx # IntelliJ icon bars
│   │   │   ├── PaneHeader.tsx   # Pane chrome
│   │   │   ├── PaneDivider.tsx  # Resizable divider
│   │   │   ├── StatusBar.tsx    # Bottom status bar
│   │   │   ├── FolderPane.tsx
│   │   │   ├── MessageList.tsx  # With Thread Ribbon
│   │   │   ├── ReadingPane.tsx  # With header shortcuts
│   │   │   └── InspectorPane.tsx
│   │   └── plugins/
│   │       ├── InjectedComponent.tsx
│   │       └── InjectedComponentSet.tsx
│   ├── services/
│   │   ├── db/
│   │   │   ├── connection.ts
│   │   │   └── migrations.ts
│   │   ├── settings.ts
│   │   ├── accounts.ts
│   │   ├── crypto.ts            # TypeScript wrapper for Rust crypto commands
│   │   ├── mail/
│   │   │   ├── provider.ts      # MailProvider interface
│   │   │   └── easProvider.ts   # EAS skeleton
│   │   ├── ai/
│   │   │   ├── aiService.ts
│   │   │   └── providers/
│   │   │       ├── openaiProvider.ts
│   │   │       └── ollamaProvider.ts
│   │   ├── plugins/
│   │   │   ├── pluginManager.ts
│   │   │   └── pluginAPI.ts
│   │   ├── theme/
│   │   │   └── themeManager.ts
│   │   └── queue/
│   │       └── offlineQueue.ts
│   ├── stores/
│   │   ├── uiStore.ts
│   │   └── accountStore.ts
│   ├── styles/
│   │   ├── globals.css
│   │   └── theme.css            # CSS custom property tokens
│   └── types/
│       └── index.ts
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs               # Tauri app builder + plugins
│   │   ├── commands.rs          # Tauri commands
│   │   └── crypto.rs            # AES-256-GCM encrypt/decrypt
│   └── capabilities/
│       └── default.json
├── plugins/
│   └── example-plugin/
│       ├── package.json
│       ├── main.ts
│       └── styles.css
├── tests/
│   └── services/
│       ├── db.test.ts
│       ├── settings.test.ts
│       └── accounts.test.ts
├── package.json
├── vite.config.ts
├── tsconfig.json
└── vitest.config.ts
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/styles/globals.css`
- Create: `src/main.tsx`

**Interfaces:**
- Produces: React app entry point and build configuration.

- [ ] **Step 1: Initialize npm project with dependencies**

Run:
```bash
npm init -y
npm install react react-dom @tauri-apps/api @tauri-apps/plugin-sql zustand @tanstack/react-router tailwindcss@4 react-resizable-panels
npm install -D @types/react @types/react-dom typescript vite @vitejs/plugin-react vitest jsdom @testing-library/react @testing-library/jest-dom
```

- [ ] **Step 2: Write `package.json` scripts**

Modify `package.json`:
```json
{
  "name": "mailclient",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest",
    "tauri": "tauri"
  }
}
```

- [ ] **Step 3: Write `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
```

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
});
```

- [ ] **Step 6: Write `src/styles/globals.css`**

```css
@import "tailwindcss";
@import "./theme.css";

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

- [ ] **Step 7: Write `src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "chore: scaffold Tauri + React + Tailwind project"
```

---

## Task 2: Tauri Rust App Shell

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/commands.rs`
- Create: `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: Tauri v2 plugin APIs.
- Produces: Tauri app with single-instance, tray, autostart, deep-link, global-shortcut, notification, and SQL plugins.

- [ ] **Step 1: Initialize Tauri app**

Run:
```bash
npx tauri init --app-name mailclient --window-title Mailclient --dist-dir ../dist --dev-path http://localhost:5173
```

- [ ] **Step 2: Configure `src-tauri/Cargo.toml`**

```toml
[package]
name = "mailclient"
version = "0.1.0"
edition = "2021"

[lib]
name = "mailclient_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2.2.0", features = [] }

[dependencies]
tauri = { version = "2.5.0", features = ["tray-icon"] }
tauri-plugin-single-instance = "2.2.0"
tauri-plugin-autostart = "2.3.0"
tauri-plugin-deep-link = "2.2.0"
tauri-plugin-global-shortcut = "2.3.0"
tauri-plugin-notification = "2.2.0"
tauri-plugin-sql = { version = "2.2.0", features = ["sqlite"] }
tauri-plugin-log = "2.3.0"
tauri-plugin-os = "2.2.0"
tauri-plugin-process = "2.2.0"
tauri-plugin-opener = "2.2.0"
tauri-plugin-fs = "2.2.0"
tauri-plugin-dialog = "2.2.0"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
log = "0.4"
tokio = { version = "1", features = ["macros", "rt"] }
```

- [ ] **Step 3: Write `src-tauri/src/lib.rs`**

```rust
mod commands;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit("single-instance-args", argv);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![commands::close_splashscreen])
        .setup(|app| {
            let level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };
            app.handle().plugin(
                tauri_plugin_log::Builder::default().level(level).build(),
            )?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: Write `src-tauri/src/commands.rs`**

```rust
use tauri::Manager;

#[tauri::command]
pub fn close_splashscreen(app: tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
```

- [ ] **Step 5: Write capability manifest `src-tauri/capabilities/default.json`**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default permissions for mailclient",
  "windows": ["main", "splashscreen"],
  "permissions": [
    "core:default",
    "core:window:default",
    "sql:default",
    "sql:allow-load",
    "sql:allow-execute",
    "sql:allow-select",
    "sql:allow-close",
    "notification:default",
    "core:event:default",
    "core:event:allow-listen",
    "core:event:allow-emit",
    "opener:default",
    "fs:default",
    "fs:allow-appdata-read-recursive",
    "fs:allow-appdata-write-recursive",
    "dialog:default",
    "autostart:default",
    "global-shortcut:default",
    "deep-link:default"
  ]
}
```

- [ ] **Step 6: Configure `src-tauri/tauri.conf.json` windows**

Add to `tauri.conf.json` under `app > windows`:
```json
{
  "label": "splashscreen",
  "url": "/splashscreen",
  "width": 400,
  "height": 300,
  "decorations": false,
  "alwaysOnTop": true,
  "center": true,
  "visible": true
},
{
  "label": "main",
  "title": "Mailclient",
  "width": 1200,
  "height": 800,
  "minWidth": 800,
  "minHeight": 600,
  "visible": false
}
```

- [ ] **Step 7: Build Rust to verify**

Run:
```bash
cd src-tauri && cargo check
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/
git commit -m "feat: add Tauri Rust app shell with plugins"
```

---

## Task 3: SQLite Connection and Migrations

**Files:**
- Create: `src/services/db/connection.ts`
- Create: `src/services/db/migrations.ts`
- Create: `tests/services/db.test.ts`

**Interfaces:**
- Produces: `getDb(): Promise<Database>`, `withTransaction(fn)`, `runMigrations(): Promise<void>`.

- [ ] **Step 1: Write failing test for migrations**

Create `tests/services/db.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from '../../src/services/db/connection';
import { runMigrations } from '../../src/services/db/migrations';

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: vi.fn().mockResolvedValue({
      execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
      select: vi.fn().mockResolvedValue([]),
    }),
  },
}));

describe('runMigrations', () => {
  it('creates the migrations table', async () => {
    const db = await getDb();
    await runMigrations();
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS _migrations'),
      [],
    );
  });
});
```

Run:
```bash
npm test -- tests/services/db.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 2: Implement `src/services/db/connection.ts`**

```ts
import Database from '@tauri-apps/plugin-sql';

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load('sqlite:mailclient.db');
  }
  return db;
}

let txQueue: Promise<void> = Promise.resolve();

export async function withTransaction(
  fn: (db: Database) => Promise<void>,
): Promise<void> {
  const prev = txQueue;
  let resolve!: () => void;
  txQueue = new Promise<void>((r) => {
    resolve = r;
  });
  try {
    await prev;
  } catch {
    // ignore previous errors
  }
  const database = await getDb();
  try {
    await database.execute('BEGIN TRANSACTION', []);
    try {
      await fn(database);
      await database.execute('COMMIT', []);
    } catch (err) {
      try {
        await database.execute('ROLLBACK', []);
      } catch {
        // already rolled back
      }
      throw err;
    }
  } finally {
    resolve();
  }
}
```

- [ ] **Step 3: Implement `src/services/db/migrations.ts`**

```ts
import { getDb } from './connection';

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema',
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        display_name TEXT,
        provider TEXT NOT NULL DEFAULT 'eas',
        provider_config TEXT,
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at INTEGER,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        description TEXT,
        applied_at INTEGER DEFAULT (unixepoch())
      );
    `,
  },
];

export async function runMigrations(): Promise<void> {
  const db = await getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      description TEXT,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);

  const applied = await db.select<{ version: number }[]>(
    'SELECT version FROM _migrations ORDER BY version',
  );
  const appliedVersions = new Set(applied.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;

    await db.execute('BEGIN TRANSACTION', []);
    try {
      await db.execute(migration.sql, []);
      await db.execute(
        'INSERT INTO _migrations (version, description) VALUES ($1, $2)',
        [migration.version, migration.description],
      );
      await db.execute('COMMIT', []);
    } catch (err) {
      await db.execute('ROLLBACK', []).catch(() => {});
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/services/db.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/db tests/services/db.test.ts
git commit -m "feat: add SQLite connection and migration system"
```

---

## Task 4: Rust Credential Encryption

**Files:**
- Create: `src-tauri/src/crypto.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Create: `src/services/crypto.ts`
- Create: `tests/services/crypto.test.ts`

**Interfaces:**
- Produces: Tauri commands `encrypt_secret` and `decrypt_secret`.
- Produces: TypeScript functions `encryptSecret(plaintext: string): Promise<string>` and `decryptSecret(ciphertext: string): Promise<string>`.

- [ ] **Step 1: Add crypto dependencies**

Modify `src-tauri/Cargo.toml`:
```toml
[dependencies]
# ... existing deps
aes-gcm = "0.10"
rand = "0.8"
keyring = { version = "3", features = ["async-secret-service"] }
hex = "0.4"
```

- [ ] **Step 2: Implement `src-tauri/src/crypto.rs`**

```rust
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use rand::RngCore;
use std::sync::OnceLock;

static KEY: OnceLock<[u8; 32]> = OnceLock::new();

fn get_or_create_key() -> Result<&'static [u8; 32], String> {
    KEY.get_or_try_init(|| {
        let entry = keyring::Entry::new("mailclient", "master-key")
            .map_err(|e| format!("keyring entry: {e}"))?;
        match entry.get_password() {
            Ok(hex_key) => {
                let mut key = [0u8; 32];
                hex::decode_to_slice(hex_key, &mut key)
                    .map_err(|e| format!("decode key: {e}"))?;
                Ok(key)
            }
            Err(_) => {
                let mut key = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut key);
                let hex_key = hex::encode(key);
                entry
                    .set_password(&hex_key)
                    .map_err(|e| format!("store key: {e}"))?;
                Ok(key)
            }
        }
    })
}

pub fn encrypt(plaintext: &str) -> Result<String, String> {
    let key = get_or_create_key()?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;

    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut combined = nonce_bytes.to_vec();
    combined.extend_from_slice(&ciphertext);
    Ok(hex::encode(combined))
}

pub fn decrypt(ciphertext_hex: &str) -> Result<String, String> {
    let key = get_or_create_key()?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;

    let combined = hex::decode(ciphertext_hex).map_err(|e| e.to_string())?;
    if combined.len() < 12 {
        return Err("ciphertext too short".to_string());
    }
    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| e.to_string())?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Expose commands**

Modify `src-tauri/src/commands.rs`:
```rust
use tauri::Manager;

#[tauri::command]
pub fn close_splashscreen(app: tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn encrypt_secret(plaintext: String) -> Result<String, String> {
    crate::crypto::encrypt(&plaintext)
}

#[tauri::command]
pub fn decrypt_secret(ciphertext: String) -> Result<String, String> {
    crate::crypto::decrypt(&ciphertext)
}
```

Modify `src-tauri/src/lib.rs` to register commands:
```rust
.invoke_handler(tauri::generate_handler![
    commands::close_splashscreen,
    commands::encrypt_secret,
    commands::decrypt_secret,
])
```

- [ ] **Step 4: Add TypeScript wrapper `src/services/crypto.ts`**

```ts
import { invoke } from '@tauri-apps/api/core';

export async function encryptSecret(plaintext: string): Promise<string> {
  return invoke<string>('encrypt_secret', { plaintext });
}

export async function decryptSecret(ciphertext: string): Promise<string> {
  return invoke<string>('decrypt_secret', { ciphertext });
}
```

- [ ] **Step 5: Write integration test**

Create `tests/services/crypto.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { encryptSecret, decryptSecret } from '../../src/services/crypto';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string, args: { plaintext?: string; ciphertext?: string }) => {
    if (cmd === 'encrypt_secret') return Promise.resolve(`enc:${args.plaintext}`);
    if (cmd === 'decrypt_secret') return Promise.resolve(args.ciphertext!.replace('enc:', ''));
    return Promise.reject(new Error('unknown command'));
  }),
}));

describe('crypto', () => {
  it('round-trips plaintext through mocked encryption', async () => {
    const secret = 'my-password';
    const encrypted = await encryptSecret(secret);
    const decrypted = await decryptSecret(encrypted);
    expect(decrypted).toBe(secret);
  });
});
```

Run:
```bash
npm test -- tests/services/crypto.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri src/services/crypto.ts tests/services/crypto.test.ts
git commit -m "feat: add AES-256-GCM credential encryption in Rust"
```

---

## Task 5: Settings Service

**Files:**
- Create: `src/services/settings.ts`
- Create: `tests/services/settings.test.ts`

**Interfaces:**
- Produces: `getSetting(key: string): Promise<string | null>`, `setSetting(key: string, value: string): Promise<void>`.

- [ ] **Step 1: Write failing test**

Create `tests/services/settings.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSetting, setSetting } from '../../src/services/settings';
import { getDb } from '../../src/services/db/connection';

vi.mock('../../src/services/db/connection', () => ({
  getDb: vi.fn(),
}));

const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as any);
  mockDb.select.mockReset();
  mockDb.execute.mockReset();
});

describe('settings', () => {
  it('returns a stored value', async () => {
    mockDb.select.mockResolvedValue([{ value: 'dark' }]);
    const value = await getSetting('theme');
    expect(value).toBe('dark');
  });

  it('sets a value', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await setSetting('theme', 'light');
    expect(mockDb.execute).toHaveBeenCalledWith(
      'INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)',
      ['theme', 'light'],
    );
  });
});
```

Run test and verify it fails.

- [ ] **Step 2: Implement `src/services/settings.ts`**

```ts
import { getDb } from './db/connection';

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    'SELECT value FROM settings WHERE key = $1',
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)',
    [key, value],
  );
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- tests/services/settings.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/services/settings.ts tests/services/settings.test.ts
git commit -m "feat: add settings service"
```

---

## Task 6: Account Service

**Files:**
- Create: `src/services/accounts.ts`
- Create: `src/types/index.ts`
- Create: `tests/services/accounts.test.ts`

**Interfaces:**
- Produces: `Account` type, `createAccount`, `getAllAccounts`, `updateAccount`, `deleteAccount`, `getAccountById`.

- [ ] **Step 1: Define `Account` type**

Create `src/types/index.ts`:
```ts
export interface Account {
  id: string;
  email: string;
  displayName?: string;
  provider: 'eas' | 'gmail_api' | 'imap' | string;
  providerConfig?: Record<string, unknown>;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 2: Write failing test**

Create `tests/services/accounts.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAccount, getAllAccounts } from '../../src/services/accounts';
import { getDb } from '../../src/services/db/connection';

vi.mock('../../src/services/db/connection', () => ({
  getDb: vi.fn(),
}));

const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as any);
  mockDb.select.mockReset();
  mockDb.execute.mockReset();
});

describe('accounts', () => {
  it('creates an account', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    const account = await createAccount({
      email: 'test@example.com',
      provider: 'eas',
    });
    expect(account.email).toBe('test@example.com');
    expect(account.provider).toBe('eas');
    expect(account.isActive).toBe(true);
  });

  it('lists all accounts', async () => {
    mockDb.select.mockResolvedValue([
      {
        id: 'acc-1',
        email: 'test@example.com',
        provider: 'eas',
        is_active: 1,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    const accounts = await getAllAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe('test@example.com');
  });
});
```

Run test and verify it fails.

- [ ] **Step 3: Implement `src/services/accounts.ts`**

```ts
import { getDb } from './db/connection';
import type { Account } from '../types';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function rowToAccount(row: any): Account {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    provider: row.provider,
    providerConfig: row.provider_config ? JSON.parse(row.provider_config) : undefined,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    tokenExpiresAt: row.token_expires_at,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createAccount(
  input: Pick<Account, 'email' | 'provider'> & Partial<Account>,
): Promise<Account> {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const account: Account = {
    id: generateId(),
    email: input.email,
    displayName: input.displayName,
    provider: input.provider,
    providerConfig: input.providerConfig,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    tokenExpiresAt: input.tokenExpiresAt,
    isActive: input.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };

  await db.execute(
    `INSERT INTO accounts
      (id, email, display_name, provider, provider_config, access_token, refresh_token, token_expires_at, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      account.id,
      account.email,
      account.displayName ?? null,
      account.provider,
      account.providerConfig ? JSON.stringify(account.providerConfig) : null,
      account.accessToken ?? null,
      account.refreshToken ?? null,
      account.tokenExpiresAt ?? null,
      account.isActive ? 1 : 0,
      account.createdAt,
      account.updatedAt,
    ],
  );

  return account;
}

export async function getAllAccounts(): Promise<Account[]> {
  const db = await getDb();
  const rows = await db.select<any[]>('SELECT * FROM accounts ORDER BY created_at DESC', []);
  return rows.map(rowToAccount);
}

export async function getAccountById(id: string): Promise<Account | null> {
  const db = await getDb();
  const rows = await db.select<any[]>('SELECT * FROM accounts WHERE id = $1', [id]);
  return rows[0] ? rowToAccount(rows[0]) : null;
}

export async function updateAccount(
  id: string,
  updates: Partial<Omit<Account, 'id' | 'createdAt'>>,
): Promise<void> {
  const db = await getDb();
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (updates.email) fields.push(`email = $${idx++}`), values.push(updates.email);
  if (updates.displayName !== undefined) fields.push(`display_name = $${idx++}`), values.push(updates.displayName);
  if (updates.provider) fields.push(`provider = $${idx++}`), values.push(updates.provider);
  if (updates.providerConfig !== undefined) fields.push(`provider_config = $${idx++}`), values.push(JSON.stringify(updates.providerConfig));
  if (updates.accessToken !== undefined) fields.push(`access_token = $${idx++}`), values.push(updates.accessToken);
  if (updates.refreshToken !== undefined) fields.push(`refresh_token = $${idx++}`), values.push(updates.refreshToken);
  if (updates.tokenExpiresAt !== undefined) fields.push(`token_expires_at = $${idx++}`), values.push(updates.tokenExpiresAt);
  if (updates.isActive !== undefined) fields.push(`is_active = $${idx++}`), values.push(updates.isActive ? 1 : 0);

  fields.push(`updated_at = $${idx++}`);
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);

  await db.execute(
    `UPDATE accounts SET ${fields.join(', ')} WHERE id = $${idx}`,
    values,
  );
}

export async function deleteAccount(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM accounts WHERE id = $1', [id]);
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/services/accounts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/accounts.ts src/types/index.ts tests/services/accounts.test.ts
git commit -m "feat: add account service with CRUD"
```

---

## Task 7: MailProvider Interface and EAS Skeleton

**Files:**
- Create: `src/services/mail/provider.ts`
- Create: `src/services/mail/easProvider.ts`
- Create: `tests/services/mail/easProvider.test.ts`

**Interfaces:**
- Produces: `MailProvider` interface and `EasProvider` class.

- [ ] **Step 1: Define `MailProvider` interface**

Create `src/services/mail/provider.ts`:
```ts
export interface SyncResult {
  added: number;
  updated: number;
  deleted: number;
}

export interface MailProvider {
  readonly id: string;
  connect(): Promise<void>;
  syncFolder(folderId: string): Promise<SyncResult>;
  sendMessage?(draft: unknown): Promise<void>;
}
```

- [ ] **Step 2: Write failing test**

Create `tests/services/mail/easProvider.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { EasProvider } from '../../../src/services/mail/easProvider';

describe('EasProvider', () => {
  it('has provider id "eas"', () => {
    const provider = new EasProvider({
      id: 'acc-1',
      email: 'test@example.com',
      provider: 'eas',
      providerConfig: { endpoint: 'https://exchange.example.com/Microsoft-Server-ActiveSync' },
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(provider.id).toBe('eas');
  });
});
```

Run test and verify it fails.

- [ ] **Step 3: Implement `src/services/mail/easProvider.ts`**

```ts
import type { Account } from '../../types';
import type { MailProvider, SyncResult } from './provider';

export class EasProvider implements MailProvider {
  readonly id = 'eas';
  private client: unknown;

  constructor(private account: Account) {}

  async connect(): Promise<void> {
    // TODO: integrate custom EAS library here
    this.client = null;
  }

  async syncFolder(_folderId: string): Promise<SyncResult> {
    // TODO: implement via custom EAS library
    return { added: 0, updated: 0, deleted: 0 };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/services/mail/easProvider.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/mail tests/services/mail
git commit -m "feat: add MailProvider interface and EAS skeleton"
```

---

## Task 8: Plugin Registry

**Files:**
- Create: `src/services/plugins/pluginAPI.ts`
- Create: `src/services/plugins/pluginManager.ts`
- Create: `tests/services/plugins/pluginManager.test.ts`
- Create: `plugins/example-plugin/package.json`
- Create: `plugins/example-plugin/main.ts`

**Interfaces:**
- Produces: `PluginAPI` interface, `PluginManager` class with `loadPlugins()` and `activatePlugins()`.

- [ ] **Step 1: Define `PluginAPI`**

Create `src/services/plugins/pluginAPI.ts`:
```ts
import type { ComponentType } from 'react';

export interface PluginAPI {
  registerComponent(role: string, component: ComponentType<any>): void;
  unregisterComponent(role: string, component: ComponentType<any>): void;
  onEvent(event: string, handler: (payload: unknown) => void): () => void;
  registerAction(id: string, handler: () => void): void;
}

export interface LoadedPlugin {
  name: string;
  path: string;
  main?: {
    activate?: (api: PluginAPI) => void | Promise<void>;
    deactivate?: () => void | Promise<void>;
  };
}
```

- [ ] **Step 2: Implement `PluginManager`**

Create `src/services/plugins/pluginManager.ts`:
```ts
import type { PluginAPI, LoadedPlugin } from './pluginAPI';

export class PluginManager {
  private plugins: LoadedPlugin[] = [];
  private components = new Map<string, Set<React.ComponentType<any>>>();
  private eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  private actions = new Map<string, () => void>();

  get api(): PluginAPI {
    return {
      registerComponent: (role, component) => {
        if (!this.components.has(role)) this.components.set(role, new Set());
        this.components.get(role)!.add(component);
        this.emitEvent('__registry_changed__', { role });
      },
      unregisterComponent: (role, component) => {
        this.components.get(role)?.delete(component);
        this.emitEvent('__registry_changed__', { role });
      },
      onEvent: (event, handler) => {
        if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
        this.eventHandlers.get(event)!.add(handler);
        return () => this.eventHandlers.get(event)?.delete(handler);
      },
      registerAction: (id, handler) => {
        this.actions.set(id, handler);
      },
    };
  }

  async loadPlugins(pluginPaths: string[]): Promise<void> {
    for (const path of pluginPaths) {
      try {
        const mod = await import(/* @vite-ignore */ path);
        this.plugins.push({ name: path, path, main: mod });
      } catch (err) {
        console.error(`Failed to load plugin ${path}:`, err);
      }
    }
  }

  async activatePlugins(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.main?.activate) {
        await plugin.main.activate(this.api);
      }
    }
  }

  getComponentsForRole(role: string): React.ComponentType<any>[] {
    return Array.from(this.components.get(role) ?? []);
  }

  emitEvent(event: string, payload: unknown): void {
    for (const handler of this.eventHandlers.get(event) ?? []) {
      handler(payload);
    }
  }
}

export const pluginManager = new PluginManager();
```

- [ ] **Step 3: Write test**

Create `tests/services/plugins/pluginManager.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pluginManager } from '../../../src/services/plugins/pluginManager';

const TestComponent = () => null;

beforeEach(() => {
  pluginManager.getComponentsForRole('test-role').forEach((c) =>
    pluginManager.api.unregisterComponent('test-role', c),
  );
});

describe('PluginManager', () => {
  it('registers a component via the plugin API', () => {
    pluginManager.api.registerComponent('test-role', TestComponent);
    expect(pluginManager.getComponentsForRole('test-role')).toContain(TestComponent);
  });

  it('emits events to registered handlers', () => {
    const handler = vi.fn();
    pluginManager.api.onEvent('sync-complete', handler);
    pluginManager.emitEvent('sync-complete', { accountId: '1' });
    expect(handler).toHaveBeenCalledWith({ accountId: '1' });
  });
});
```

Run:
```bash
npm test -- tests/services/plugins/pluginManager.test.ts
```

Expected: PASS.

- [ ] **Step 4: Implement `InjectedComponent` and `InjectedComponentSet`**

Create `src/components/plugins/InjectedComponent.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { pluginManager } from '../../services/plugins/pluginManager';

interface InjectedComponentProps {
  role: string;
  fallback?: React.ComponentType | null;
  [key: string]: unknown;
}

export function InjectedComponent({ role, fallback: Fallback, ...props }: InjectedComponentProps) {
  const [components, setComponents] = useState(() => pluginManager.getComponentsForRole(role));

  useEffect(() => {
    return pluginManager.api.onEvent('__registry_changed__', () => {
      setComponents(pluginManager.getComponentsForRole(role));
    });
  }, [role]);

  if (components.length === 0) {
    return Fallback ? <Fallback /> : null;
  }

  const Component = components[0];
  return <Component {...props} />;
}
```

Create `src/components/plugins/InjectedComponentSet.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { pluginManager } from '../../services/plugins/pluginManager';

interface InjectedComponentSetProps {
  role: string;
  containersRequired?: boolean;
  [key: string]: unknown;
}

export function InjectedComponentSet({
  role,
  containersRequired = true,
  ...props
}: InjectedComponentSetProps) {
  const [components, setComponents] = useState(() => pluginManager.getComponentsForRole(role));

  useEffect(() => {
    return pluginManager.api.onEvent('__registry_changed__', () => {
      setComponents(pluginManager.getComponentsForRole(role));
    });
  }, [role]);

  return (
    <>
      {components.map((Component) =>
        containersRequired ? (
          <div key={Component.displayName || Component.name} className="inline-flex">
            <Component {...props} />
          </div>
        ) : (
          <Component key={Component.displayName || Component.name} {...props} />
        ),
      )}
    </>
  );
}
```

Note: `PluginManager` needs to emit `__registry_changed__` after `registerComponent`/`unregisterComponent`. Add this to `pluginManager.ts` in Step 2.

- [ ] **Step 5: Create example plugin**

Create `plugins/example-plugin/package.json`:
```json
{
  "name": "example-plugin",
  "main": "./main.ts",
  "enabledByDefault": true
}
```

Create `plugins/example-plugin/main.ts`:
```ts
import type { PluginAPI } from '../../src/services/plugins/pluginAPI';

export function activate(api: PluginAPI) {
  api.registerAction('example:say-hello', () => {
    console.log('Hello from example plugin');
  });
}

export function deactivate() {
  // cleanup
}
```

- [ ] **Step 6: Commit**

```bash
git add src/services/plugins src/components/plugins tests/services/plugins plugins/example-plugin
git commit -m "feat: add plugin registry with injection components"
```

---

## Task 9: Theme Manager and CSS Tokens

**Files:**
- Create: `src/services/theme/themeManager.ts`
- Create: `src/styles/theme.css`
- Modify: `src/styles/globals.css`
- Create: `tests/services/theme/themeManager.test.ts`

**Interfaces:**
- Produces: `ThemeManager` class with `applyTheme(themeName)`.

- [ ] **Step 1: Define theme tokens**

Create `src/styles/theme.css`:
```css
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.546 0.245 262.881);
  --primary-foreground: oklch(0.97 0.014 254.604);
  --secondary: oklch(0.97 0.014 254.604);
  --secondary-foreground: oklch(0.21 0.034 264.665);
  --muted: oklch(0.97 0.014 254.604);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.97 0.014 254.604);
  --accent-foreground: oklch(0.21 0.034 264.665);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.92 0.004 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.546 0.245 262.881);
  --radius: 0.625rem;

  /* Semantic desktop tokens */
  --header-bg: var(--card);
  --header-border: var(--border);
  --toolbar-button-hover-bg: var(--accent);
  --toolbar-button-active-bg: var(--muted);
  --pane-header-bg: var(--card);
  --pane-header-border: var(--border);
  --pane-header-text: var(--foreground);
  --pane-divider-color: var(--border);
  --pane-divider-hover-color: var(--ring);
  --status-bar-bg: var(--muted);
  --status-bar-text: var(--muted-foreground);
  --focus-ring: var(--ring);
  --selected-bg: var(--accent);
  --selected-text: var(--accent-foreground);
}

.dark {
  --background: oklch(0.141 0.005 285.823);
  --foreground: oklch(0.985 0.001 247.839);
  --card: oklch(0.28 0.03 264.665);
  --card-foreground: oklch(0.985 0.001 247.839);
  --popover: oklch(0.28 0.03 264.665);
  --popover-foreground: oklch(0.985 0.001 247.839);
  --primary: oklch(0.707 0.165 254.624);
  --primary-foreground: oklch(0.28 0.03 264.665);
  --secondary: oklch(0.274 0.058 263.155);
  --secondary-foreground: oklch(0.985 0.001 247.839);
  --muted: oklch(0.274 0.058 263.155);
  --muted-foreground: oklch(0.704 0.04 256.788);
  --accent: oklch(0.274 0.058 263.155);
  --accent-foreground: oklch(0.985 0.001 247.839);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(0.274 0.058 263.155);
  --input: oklch(0.37 0.077 264.155);
  --ring: oklch(0.707 0.165 254.624);
}
```

- [ ] **Step 2: Implement `ThemeManager`**

Create `src/services/theme/themeManager.ts`:
```ts
export interface Theme {
  name: string;
  css: string;
}

export class ThemeManager {
  private activeTheme: string = 'system';

  applyTheme(themeName: 'light' | 'dark' | 'system'): void {
    this.activeTheme = themeName;
    const root = document.documentElement;
    root.classList.remove('light', 'dark');

    if (themeName === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.add(prefersDark ? 'dark' : 'light');
    } else {
      root.classList.add(themeName);
    }
  }

  getActiveTheme(): string {
    return this.activeTheme;
  }
}
```

- [ ] **Step 3: Write test**

Create `tests/services/theme/themeManager.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ThemeManager } from '../../../src/services/theme/themeManager';

describe('ThemeManager', () => {
  it('applies light theme class', () => {
    const manager = new ThemeManager();
    manager.applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
```

Run:
```bash
npm test -- tests/services/theme/themeManager.test.ts
```

Expected: PASS.

- [ ] **Step 4: Update globals.css**

Modify `src/styles/globals.css`:
```css
@import './theme.css';
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 5: Commit**

```bash
git add src/services/theme src/styles tests/services/theme
git commit -m "feat: add theme manager and CSS token system"
```

---

## Task 10: AI Provider Abstraction and Cache

**Files:**
- Create: `src/services/ai/providers/base.ts`
- Create: `src/services/ai/providers/openaiProvider.ts`
- Create: `src/services/ai/providers/ollamaProvider.ts`
- Create: `src/services/ai/aiService.ts`
- Modify: `src/services/db/migrations.ts`

**Interfaces:**
- Produces: `LLMProvider` interface, `AIService` class, `ai_cache` table.

- [ ] **Step 1: Add migration for ai_cache**

Modify `src/services/db/migrations.ts` to add migration v2:
```ts
{
  version: 2,
  description: 'AI result cache',
  sql: `
    CREATE TABLE IF NOT EXISTS ai_cache (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      thread_id TEXT,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(account_id, thread_id, type)
    );
  `,
},
```

- [ ] **Step 2: Define base provider interface**

Create `src/services/ai/providers/base.ts`:
```ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface LLMProvider {
  id: string;
  chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
  summarize(text: string): Promise<string>;
}
```

- [ ] **Step 3: Implement OpenAI provider skeleton**

Create `src/services/ai/providers/openaiProvider.ts`:
```ts
import type { ChatMessage, ChatOptions, LLMProvider } from './base';

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai';

  constructor(private apiKey: string) {}

  async *chat(_messages: ChatMessage[], _options?: ChatOptions): AsyncIterable<string> {
    // TODO: integrate OpenAI SDK
    yield '';
  }

  async summarize(_text: string): Promise<string> {
    // TODO: implement
    return '';
  }
}
```

- [ ] **Step 4: Implement Ollama provider skeleton**

Create `src/services/ai/providers/ollamaProvider.ts`:
```ts
import type { ChatMessage, ChatOptions, LLMProvider } from './base';

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';

  constructor(private baseUrl: string = 'http://localhost:11434') {}

  async *chat(_messages: ChatMessage[], _options?: ChatOptions): AsyncIterable<string> {
    // TODO: integrate Ollama API
    yield '';
  }

  async summarize(_text: string): Promise<string> {
    // TODO: implement
    return '';
  }
}
```

- [ ] **Step 5: Implement `AIService`**

Create `src/services/ai/aiService.ts`:
```ts
import { getDb } from '../db/connection';
import type { LLMProvider } from './providers/base';

export class AIService {
  constructor(private provider: LLMProvider) {}

  async getCachedResult(
    accountId: string | undefined,
    threadId: string,
    type: string,
  ): Promise<string | null> {
    const db = await getDb();
    const rows = await db.select<{ content: string }[]>(
      'SELECT content FROM ai_cache WHERE account_id = $1 AND thread_id = $2 AND type = $3',
      [accountId ?? null, threadId, type],
    );
    return rows[0]?.content ?? null;
  }

  async cacheResult(
    accountId: string | undefined,
    threadId: string,
    type: string,
    content: string,
  ): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT OR REPLACE INTO ai_cache (account_id, thread_id, type, content)
       VALUES ($1, $2, $3, $4)`,
      [accountId ?? null, threadId, type, content],
    );
  }
}
```

- [ ] **Step 6: Run all tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/ai src/services/db/migrations.ts
git commit -m "feat: add AI provider abstraction and cache"
```

---

## Task 11: App Shell UI — IntelliJ + Outlook Layout

**Files:**
- Create: `src/components/layout/AppShell.tsx`
- Create: `src/components/layout/HeaderBar.tsx`
- Create: `src/components/layout/CommandRibbon.tsx`
- Create: `src/components/layout/ToolWindowBar.tsx`
- Create: `src/components/layout/PaneHeader.tsx`
- Create: `src/components/layout/StatusBar.tsx`
- Create: `src/components/layout/FolderPane.tsx`
- Create: `src/components/layout/MessageList.tsx`
- Create: `src/components/layout/ReadingPane.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces: `<AppShell>` component with IntelliJ-style header/tool-window bars, Outlook-style command ribbon, resizable panes, Thread Ribbon in message list, and header shortcuts in reading pane.

- [ ] **Step 1: Implement `HeaderBar`**

Create `src/components/layout/HeaderBar.tsx`:
```tsx
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';

export function HeaderBar() {
  return (
    <header className="h-10 flex items-center gap-3 px-3 border-b bg-[var(--surface)] border-[var(--border)] text-[var(--foreground)]">
      <div className="flex items-center gap-2 min-w-[120px]">
        <button className="icon-btn" aria-label="Menu">
          <MenuIcon />
        </button>
        <span className="font-bold text-sm">Mailclient</span>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <input
          type="text"
          placeholder="Search mail…"
          className="w-full max-w-[480px] h-7 px-3 text-sm rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
        />
      </div>
      <div className="flex items-center gap-1">
        <InjectedComponentSet role="header:right" />
        <button className="btn btn--primary">
          <PlusIcon /> New mail
        </button>
        <button className="icon-btn" aria-label="Notifications">
          <NotificationIcon />
        </button>
        <button className="icon-btn" aria-label="Settings">
          <SettingsIcon />
        </button>
        <button className="icon-btn" aria-label="Profile">
          <UserIcon />
        </button>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Implement `CommandRibbon`**

Create `src/components/layout/CommandRibbon.tsx`:
```tsx
export function CommandRibbon() {
  return (
    <nav className="h-11 flex items-stretch px-2 border-b bg-[var(--background)] border-[var(--border)]" aria-label="Command ribbon">
      <RibbonGroup>
        <RibbonButton primary split>New mail</RibbonButton>
      </RibbonGroup>
      <RibbonGroup>
        <RibbonButton icon={<DeleteIcon />}>Delete</RibbonButton>
        <RibbonButton icon={<ArchiveIcon />}>Archive</RibbonButton>
        <RibbonButton icon={<MoveIcon />} split>Move</RibbonButton>
      </RibbonGroup>
      <RibbonGroup>
        <RibbonButton icon={<TagIcon />} split>Categorize</RibbonButton>
        <RibbonButton icon={<LightningIcon />} split>Quick steps</RibbonButton>
      </RibbonGroup>
      <RibbonGroup>
        <RibbonButton icon={<MailIcon />} split>Read/Unread</RibbonButton>
        <RibbonButton icon={<FlagIcon />}>Flag</RibbonButton>
        <RibbonButton icon={<PinIcon />}>Pin</RibbonButton>
      </RibbonGroup>
      <RibbonGroup>
        <RibbonButton icon={<UndoIcon />} />
        <RibbonButton icon={<RedoIcon />} />
        <RibbonButton icon={<MoreIcon />} />
      </RibbonGroup>
    </nav>
  );
}
```

- [ ] **Step 3: Implement `ToolWindowBar`**

Create `src/components/layout/ToolWindowBar.tsx`:
```tsx
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';

interface ToolWindowBarProps {
  position: 'left' | 'right' | 'bottom';
}

export function ToolWindowBar({ position }: ToolWindowBarProps) {
  const vertical = position === 'left' || position === 'right';
  return (
    <div
      className={`
        ${vertical ? 'w-11 flex-col' : 'h-11 flex-row'}
        flex items-center gap-1 pt-2 px-1 border-[var(--border)] bg-[var(--surface)]
        ${position === 'left' ? 'border-r' : ''}
        ${position === 'right' ? 'border-l' : ''}
        ${position === 'bottom' ? 'border-t' : ''}
      `}
    >
      <InjectedComponentSet
        role={`toolwindow:${position}`}
        containersRequired={false}
      />
    </div>
  );
}
```

- [ ] **Step 4: Implement `PaneHeader`**

Create `src/components/layout/PaneHeader.tsx`:
```tsx
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';

interface PaneHeaderProps {
  title: string;
  role: string;
}

export function PaneHeader({ title, role }: PaneHeaderProps) {
  return (
    <div className="h-8 flex items-center justify-between px-3 border-b bg-[var(--surface)] border-[var(--border)] text-[var(--foreground)]">
      <span className="text-sm font-semibold">{title}</span>
      <InjectedComponentSet role={role} containersRequired={false} />
    </div>
  );
}
```

- [ ] **Step 5: Implement `StatusBar`**

Create `src/components/layout/StatusBar.tsx`:
```tsx
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';

export function StatusBar() {
  return (
    <footer className="h-6 flex items-center justify-between px-3 text-xs bg-[var(--surface)] text-[var(--muted-text)] border-t border-[var(--border)]">
      <span>Synced · 3 accounts · 1 selected</span>
      <InjectedComponentSet role="status-bar" containersRequired={false} />
    </footer>
  );
}
```

- [ ] **Step 6: Implement `FolderPane`**

Create `src/components/layout/FolderPane.tsx`:
```tsx
import { PaneHeader } from './PaneHeader';

export function FolderPane() {
  return (
    <div className="flex flex-col h-full bg-[var(--surface)]">
      <PaneHeader title="Folders" role="folder-pane:header" />
      <div className="flex-1 overflow-auto py-2">
        <div className="folder-group pb-2 border-b border-[var(--border)]">
          <div className="px-3 pb-1.5 text-[11px] font-bold uppercase tracking-wide text-[var(--muted-text)]">Favorites</div>
          <ul className="space-y-0.5">
            <li className="flex items-center gap-2 px-3 h-7 rounded bg-[var(--selected)] text-[var(--primary)] cursor-pointer text-sm">
              <MailIcon /> Inbox <span className="ml-auto text-[11px] font-mono px-1.5 py-0.5 rounded-full bg-[var(--primary)] text-[var(--primary-fg)]">9</span>
            </li>
            <li className="flex items-center gap-2 px-3 h-7 rounded hover:bg-[var(--hover)] text-[var(--muted-text)] hover:text-[var(--text)] cursor-pointer text-sm">
              <SendIcon /> Sent Items
            </li>
            <li className="flex items-center gap-2 px-3 h-7 rounded hover:bg-[var(--hover)] text-[var(--muted-text)] hover:text-[var(--text)] cursor-pointer text-sm">
              <FileTextIcon /> Drafts <span className="ml-auto text-[11px] font-mono px-1.5 py-0.5 rounded-full bg-[var(--border)] text-[var(--text)]">2</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Implement `MessageList` with Thread Ribbon**

Create `src/components/layout/MessageList.tsx`:
```tsx
import { PaneHeader } from './PaneHeader';

interface MessageRowProps {
  sender: string;
  subject: string;
  time: string;
  initials: string;
  state: 'unread' | 'read' | 'flagged' | 'vip';
  selected?: boolean;
}

function MessageRow({ sender, subject, time, initials, state, selected }: MessageRowProps) {
  const ribbonClass = {
    unread: 'bg-[var(--primary)]',
    read: 'bg-[var(--border)]',
    flagged: 'bg-[var(--amber)]',
    vip: 'bg-[var(--green)]',
  }[state];

  return (
    <div className={`flex items-center gap-2.5 min-h-[48px] px-3 py-2 cursor-pointer border-b border-transparent hover:bg-[var(--hover)] ${selected ? 'bg-[var(--selected)]' : ''}`}>
      <div className={`w-[3px] self-stretch rounded-r-[2px] ${ribbonClass}`} />
      <div className="w-7 h-7 rounded-full bg-[var(--border)] grid place-items-center text-[10px] font-bold text-[var(--muted-text)]">{initials}</div>
      <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <span className={`text-sm truncate ${state === 'unread' ? 'font-semibold' : ''}`}>{sender}</span>
          <span className="text-[11px] font-mono text-[var(--muted-text)] shrink-0">{time}</span>
        </div>
        <span className="text-sm text-[var(--muted-text)] truncate">{subject}</span>
      </div>
    </div>
  );
}

export function MessageList() {
  return (
    <div className="flex flex-col h-full bg-[var(--background)]">
      <PaneHeader title="Messages" role="message-list:header" />
      <div className="flex-1 overflow-auto">
        <div className="py-1.5 border-b border-[var(--border)]">
          <div className="px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-[var(--muted-text)]">Today</div>
          <MessageRow sender="Kevin Sturgis" subject="Coral Gables project — revised timeline" time="9:30 AM" initials="KS" state="unread" selected />
          <MessageRow sender="Cecil Folk" subject="Security review passed" time="1:23 PM" initials="CF" state="vip" />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Implement `ReadingPane` with Header Shortcuts**

Create `src/components/layout/ReadingPane.tsx`:
```tsx
import { PaneHeader } from './PaneHeader';
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';

export function ReadingPane() {
  return (
    <div className="flex flex-col h-full bg-[var(--background)]">
      <PaneHeader title="Reading" role="reading-pane:toolbar" />
      <div className="flex-1 overflow-auto">
        <div className="px-5 pt-4 pb-3 border-b border-[var(--border)]">
          <div className="flex items-start justify-between gap-3 mb-3">
            <h1 className="flex-1 min-w-0 font-serif text-[22px] font-semibold leading-tight text-[var(--text)]">
              Coral Gables project — revised timeline
            </h1>
            <div className="flex items-center gap-0.5 shrink-0 mt-0.5">
              <ShortcutButton icon={<SmileIcon />} title="React" />
              <ShortcutButton icon={<ReplyIcon />} title="Reply" />
              <ShortcutButton icon={<ReplyAllIcon />} title="Reply all" />
              <ShortcutButton icon={<ForwardIcon />} title="Forward" />
              <ShortcutButton icon={<MoreIcon />} title="More" />
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm text-[var(--muted-text)]">
            <div className="w-8 h-8 rounded-full bg-[var(--border)] grid place-items-center text-xs font-bold text-[var(--muted-text)]">KS</div>
            <div>
              <div className="font-semibold text-[var(--text)]">Kevin Sturgis &lt;kevin@example.com&gt;</div>
              <div>To: you · Today, 9:30 AM</div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 px-5 py-2 border-b border-[var(--border)]">
          <button className="btn btn--ghost">Reply</button>
          <button className="btn btn--ghost">Forward</button>
          <button className="btn btn--ghost">Archive</button>
          <button className="btn btn--ghost text-[var(--destructive)]">Delete</button>
        </div>
        <main className="flex-1 p-5 leading-relaxed text-[var(--text)]">
          <p>Hi,</p>
          <p>After yesterday's standup I moved the foundation milestone out by two weeks...</p>
        </main>
      </div>
      <InjectedComponentSet role="reading-pane:footer" />
    </div>
  );
}
```

- [ ] **Step 9: Implement `AppShell` with resizable panels**

Create `src/components/layout/AppShell.tsx`:
```tsx
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { HeaderBar } from './HeaderBar';
import { CommandRibbon } from './CommandRibbon';
import { ToolWindowBar } from './ToolWindowBar';
import { FolderPane } from './FolderPane';
import { MessageList } from './MessageList';
import { ReadingPane } from './ReadingPane';
import { StatusBar } from './StatusBar';

export function AppShell() {
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <HeaderBar />
      <CommandRibbon />
      <div className="flex flex-1 overflow-hidden">
        <ToolWindowBar position="left" />
        <PanelGroup direction="horizontal" className="flex-1">
          <Panel defaultSize={20} minSize={15} maxSize={35}>
            <FolderPane />
          </Panel>
          <PanelResizeHandle className="w-1 hover:bg-[var(--ring)] transition-colors" />
          <Panel defaultSize={30} minSize={20} maxSize={50}>
            <MessageList />
          </Panel>
          <PanelResizeHandle className="w-1 hover:bg-[var(--ring)] transition-colors" />
          <Panel defaultSize={50} minSize={25}>
            <ReadingPane />
          </Panel>
        </PanelGroup>
        <ToolWindowBar position="right" />
      </div>
      <StatusBar />
    </div>
  );
}
```

- [ ] **Step 10: Update `App.tsx`**

Create `src/App.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import { runMigrations } from './services/db/migrations';

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    async function init() {
      await runMigrations();
      setReady(true);
    }
    init();
  }, []);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--background)] text-[var(--foreground)]">
        <div>Loading your inbox…</div>
      </div>
    );
  }

  return <AppShell />;
}
```

- [ ] **Step 10: Verify build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 11: Commit**

```bash
git add src/components src/App.tsx package.json package-lock.json
git commit -m "feat: add IntelliJ + Outlook layout shell"
```

- [ ] **Step 7: Verify build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/components src/App.tsx package.json package-lock.json
git commit -m "feat: add Outlook-style three-pane app shell"
```

---

## Task 12: Zustand Stores

**Files:**
- Create: `src/stores/uiStore.ts`
- Create: `src/stores/accountStore.ts`
- Create: `tests/stores/uiStore.test.ts`
- Create: `tests/stores/accountStore.test.ts`

**Interfaces:**
- Produces: `useUIStore`, `useAccountStore` with actions.

- [ ] **Step 1: Implement `uiStore`**

Create `src/stores/uiStore.ts`:
```ts
import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ReadingPanePosition = 'right' | 'bottom' | 'off';
export type Density = 'compact' | 'comfortable';

export interface UIState {
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  folderPaneWidth: number;
  messageListWidth: number;
  readingPanePosition: ReadingPanePosition;
  inspectorPaneVisible: boolean;
  activeToolWindow: string | null;
  density: Density;
  setTheme: (theme: ThemeMode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setFolderPaneWidth: (width: number) => void;
  setMessageListWidth: (width: number) => void;
  setReadingPanePosition: (position: ReadingPanePosition) => void;
  setInspectorPaneVisible: (visible: boolean) => void;
  setActiveToolWindow: (id: string | null) => void;
  setDensity: (density: Density) => void;
}

export const useUIStore = create<UIState>((set) => ({
  theme: 'system',
  sidebarCollapsed: false,
  folderPaneWidth: 240,
  messageListWidth: 320,
  readingPanePosition: 'right',
  inspectorPaneVisible: false,
  activeToolWindow: null,
  density: 'comfortable',
  setTheme: (theme) => set({ theme }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setFolderPaneWidth: (folderPaneWidth) => set({ folderPaneWidth }),
  setMessageListWidth: (messageListWidth) => set({ messageListWidth }),
  setReadingPanePosition: (readingPanePosition) => set({ readingPanePosition }),
  setInspectorPaneVisible: (inspectorPaneVisible) => set({ inspectorPaneVisible }),
  setActiveToolWindow: (activeToolWindow) => set({ activeToolWindow }),
  setDensity: (density) => set({ density }),
}));
```

- [ ] **Step 2: Implement `accountStore`**

Create `src/stores/accountStore.ts`:
```ts
import { create } from 'zustand';
import type { Account } from '../types';

export interface AccountState {
  accounts: Account[];
  activeAccountId: string | null;
  setAccounts: (accounts: Account[]) => void;
  setActiveAccount: (id: string | null) => void;
  addAccount: (account: Account) => void;
}

export const useAccountStore = create<AccountState>((set) => ({
  accounts: [],
  activeAccountId: null,
  setAccounts: (accounts) => set({ accounts }),
  setActiveAccount: (activeAccountId) => set({ activeAccountId }),
  addAccount: (account) => set((state) => ({ accounts: [...state.accounts, account] })),
}));
```

- [ ] **Step 3: Write tests**

Create `tests/stores/uiStore.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { useUIStore } from '../../src/stores/uiStore';

describe('uiStore', () => {
  it('updates theme', () => {
    useUIStore.getState().setTheme('dark');
    expect(useUIStore.getState().theme).toBe('dark');
  });

  it('updates reading pane position', () => {
    useUIStore.getState().setReadingPanePosition('bottom');
    expect(useUIStore.getState().readingPanePosition).toBe('bottom');
  });

  it('updates density', () => {
    useUIStore.getState().setDensity('compact');
    expect(useUIStore.getState().density).toBe('compact');
  });
});
```

Create `tests/stores/accountStore.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { useAccountStore } from '../../src/stores/accountStore';

describe('accountStore', () => {
  it('adds an account', () => {
    const account = {
      id: '1',
      email: 'a@b.com',
      provider: 'eas',
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    };
    useAccountStore.getState().addAccount(account);
    expect(useAccountStore.getState().accounts).toContainEqual(account);
  });
});
```

Run:
```bash
npm test -- tests/stores
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/stores tests/stores
git commit -m "feat: add Zustand UI and account stores"
```

---

## Task 13: Offline/Online Detection and Pending Operations Queue

**Files:**
- Create: `src/services/queue/offlineQueue.ts`
- Modify: `src/services/db/migrations.ts`
- Create: `tests/services/queue/offlineQueue.test.ts`

**Interfaces:**
- Produces: `OfflineQueue` with `enqueue(operation)` and `process()`.

- [ ] **Step 1: Add pending_operations migration**

Modify `src/services/db/migrations.ts` to add migration v3:
```ts
{
  version: 3,
  description: 'Pending operations queue',
  sql: `
    CREATE TABLE IF NOT EXISTS pending_operations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      params TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 10,
      next_retry_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      error_message TEXT
    );
  `,
},
```

- [ ] **Step 2: Implement `OfflineQueue`**

Create `src/services/queue/offlineQueue.ts`:
```ts
import { getDb } from '../db/connection';

export interface PendingOperation {
  id?: string;
  accountId: string;
  operationType: string;
  resourceId: string;
  params: Record<string, unknown>;
}

export class OfflineQueue {
  async enqueue(op: PendingOperation): Promise<void> {
    const db = await getDb();
    const id = op.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await db.execute(
      `INSERT INTO pending_operations
       (id, account_id, operation_type, resource_id, params, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', unixepoch())`,
      [id, op.accountId, op.operationType, op.resourceId, JSON.stringify(op.params)],
    );
  }

  async dequeuePending(limit = 50): Promise<PendingOperation[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      `SELECT * FROM pending_operations
       WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= unixepoch())
       ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      operationType: r.operation_type,
      resourceId: r.resource_id,
      params: JSON.parse(r.params),
    }));
  }

  async markCompleted(id: string): Promise<void> {
    const db = await getDb();
    await db.execute('DELETE FROM pending_operations WHERE id = $1', [id]);
  }

  async markFailed(id: string, error: string): Promise<void> {
    const db = await getDb();
    await db.execute(
      `UPDATE pending_operations
       SET retry_count = retry_count + 1,
           next_retry_at = unixepoch() + (60 * (retry_count + 1)),
           error_message = $2,
           status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE 'pending' END
       WHERE id = $1`,
      [id, error],
    );
  }
}
```

- [ ] **Step 3: Write test**

Create `tests/services/queue/offlineQueue.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OfflineQueue } from '../../../src/services/queue/offlineQueue';
import { getDb } from '../../../src/services/db/connection';

vi.mock('../../../src/services/db/connection', () => ({
  getDb: vi.fn(),
}));

const mockDb = {
  execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
  select: vi.fn().mockResolvedValue([]),
};

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as any);
  mockDb.execute.mockClear();
  mockDb.select.mockClear();
});

describe('OfflineQueue', () => {
  it('enqueues an operation', async () => {
    const queue = new OfflineQueue();
    await queue.enqueue({
      accountId: 'acc-1',
      operationType: 'archive',
      resourceId: 'thread-1',
      params: {},
    });
    expect(mockDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pending_operations'),
      expect.any(Array),
    );
  });
});
```

Run:
```bash
npm test -- tests/services/queue/offlineQueue.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/services/queue src/services/db/migrations.ts tests/services/queue
git commit -m "feat: add offline pending operations queue"
```

---

## Task 14: Security Foundations — CSP and Safe Email Rendering

**Files:**
- Create: `src/components/email/SafeHtmlFrame.tsx`
- Create: `tests/components/SafeHtmlFrame.test.tsx`
- Install: `dompurify`, `@types/dompurify`

**Interfaces:**
- Produces: `<SafeHtmlFrame html={html} />` that sanitizes and renders in a sandboxed iframe.

- [ ] **Step 1: Install DOMPurify**

```bash
npm install dompurify
npm install -D @types/dompurify
```

- [ ] **Step 2: Implement `SafeHtmlFrame`**

Create `src/components/email/SafeHtmlFrame.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';

interface SafeHtmlFrameProps {
  html: string;
  className?: string;
}

export function SafeHtmlFrame({ html, className }: SafeHtmlFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !iframe.contentDocument) return;

    const clean = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'a', 'b', 'i', 'em', 'strong', 'ul', 'ol', 'li', 'img', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      ALLOWED_ATTR: ['href', 'title', 'alt', 'src'],
    });

    const doc = iframe.contentDocument;
    doc.open();
    doc.write(`
      <html>
        <head>
          <style>
            body { font-family: sans-serif; color: var(--foreground); background: var(--background); margin: 0; padding: 16px; }
            img { max-width: 100%; height: auto; }
            a { color: var(--color-accent); }
          </style>
        </head>
        <body>${clean}</body>
      </html>
    `);
    doc.close();
  }, [html]);

  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-same-origin"
      className={className}
      style={{ width: '100%', height: '100%', border: 'none' }}
      title="Message body"
    />
  );
}
```

- [ ] **Step 3: Write test**

Create `tests/components/SafeHtmlFrame.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SafeHtmlFrame } from '../../src/components/email/SafeHtmlFrame';

describe('SafeHtmlFrame', () => {
  it('renders an iframe', () => {
    const { container } = render(<SafeHtmlFrame html="<p>Hello</p>" />);
    expect(container.querySelector('iframe')).toBeInTheDocument();
  });
});
```

Run:
```bash
npm test -- tests/components/SafeHtmlFrame.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Add CSP to `tauri.conf.json`**

Modify `src-tauri/tauri.conf.json` to add a strict CSP in `app > security > csp`:
```json
"default-src": "'self'",
"img-src": "'self' data: blob:",
"style-src": "'self' 'unsafe-inline'",
"script-src": "'self'",
"connect-src": "'self' https:"
```

- [ ] **Step 5: Commit**

```bash
git add src/components/email tests/components src-tauri/tauri.conf.json package.json package-lock.json
git commit -m "feat: add safe HTML rendering and CSP"
```

---

## Task 15: Wire Up App Initialization

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/main.tsx`
- Create: `src/test/setup.ts`

**Interfaces:**
- Produces: Complete app bootstrap that runs migrations, loads settings, applies theme, loads plugins.

- [ ] **Step 1: Update `src/App.tsx` to initialize theme and plugins**

Modify `src/App.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import { runMigrations } from './services/db/migrations';
import { getSetting } from './services/settings';
import { ThemeManager } from './services/theme/themeManager';
import { pluginManager } from './services/plugins/pluginManager';
import { useUIStore } from './stores/uiStore';
import { invoke } from '@tauri-apps/api/core';

const themeManager = new ThemeManager();

async function discoverPlugins(): Promise<string[]> {
  // In a real app this scans the plugins/ directory via Tauri fs API.
  // For the skeleton, return an empty list; the example plugin is loaded manually in dev.
  return [];
}

export default function App() {
  const [ready, setReady] = useState(false);
  const setTheme = useUIStore((s) => s.setTheme);

  useEffect(() => {
    async function init() {
      await runMigrations();

      const savedTheme = await getSetting('theme');
      if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
        setTheme(savedTheme);
        themeManager.applyTheme(savedTheme);
      }

      const pluginPaths = await discoverPlugins();
      await pluginManager.loadPlugins(pluginPaths);
      await pluginManager.activatePlugins();

      // Close splash screen if running in Tauri
      invoke('close_splashscreen').catch(() => {});

      setReady(true);
    }
    init();
  }, [setTheme]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--background)] text-[var(--foreground)]">
        <div>Loading your inbox…</div>
      </div>
    );
  }

  return <AppShell />;
}
```

- [ ] **Step 2: Write Vitest setup**

Create `src/test/setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 4: Verify TypeScript and build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/main.tsx src/test/setup.ts
git commit -m "feat: wire up app initialization and theme loading"
```

---

## Self-Review Checklist

### 1. Spec Coverage

| Spec Section | Task(s) |
|---|---|
| Tauri v2 Rust shell | Task 2 |
| SQLite + migrations | Task 3 |
| Credential encryption | Task 4 |
| Settings service | Task 5 |
| Account service | Task 6 |
| MailProvider + EAS skeleton | Task 7 |
| Plugin registry + injection | Task 8 |
| Theme manager (reference colors) | Task 9 |
| AI provider abstraction | Task 10 |
| IntelliJ + Outlook layout shell | Task 11 |
| Zustand stores (pane state) | Task 12 |
| Offline queue | Task 13 |
| Security (CSP + safe rendering) | Task 14 |
| App initialization + plugin load | Task 15 |

### 2. Placeholder Scan

- No `TBD`, `TODO`, or `implement later` in task steps.
- `EasProvider.connect/syncFolder`, `OpenAIProvider.chat`, and `OllamaProvider.chat` contain explicit `// TODO` comments marking future subsystem work, which is acceptable for a skeleton.
- All file paths are exact.

### 3. Type Consistency

- `Account` type in `src/types/index.ts` is used by `accounts.ts`, `easProvider.ts`, and `accountStore.ts`.
- `PluginAPI` interface in `pluginAPI.ts` is consumed by `pluginManager.ts` and `plugins/example-plugin/main.ts`.
- `LLMProvider` interface in `base.ts` is implemented by OpenAI and Ollama providers.

---

## Next Steps After Core Platform

1. **Plugin & Theme Framework** subsystem — full plugin lifecycle, theme package format, component injection.
2. **Mail Sync Engine** subsystem — Gmail API, IMAP/SMTP, EAS integration, threading, offline queue processing.
3. **Outlook-Style UI** subsystem — React Aria Components collection behaviors, drag-drop, command palette.
4. **AI-Native Layer** subsystem — provider integrations, prompt templates, agent loop.
5. **Performance Optimization** subsystem — virtualization, worker-thread sync, attachment caching.

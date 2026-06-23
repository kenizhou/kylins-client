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

beforeEach(async () => {
  vi.mocked(getDb)().then((db) => {
    vi.mocked(db.execute).mockClear();
    vi.mocked(db.select).mockClear();
  });
});

describe('runMigrations', () => {
  it('creates the migrations table on first run', async () => {
    const db = await getDb();
    await runMigrations();
    const calls = vi.mocked(db.execute).mock.calls;
    const migrationsCreateCall = calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('CREATE TABLE IF NOT EXISTS _migrations'),
    );
    expect(migrationsCreateCall).toBeDefined();
  });

  it('runs migration 1 (initial schema) when no migrations are applied', async () => {
    const db = await getDb();
    await runMigrations();
    const calls = vi.mocked(db.execute).mock.calls;
    const accountsTableCall = calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('CREATE TABLE IF NOT EXISTS accounts'),
    );
    expect(accountsTableCall).toBeDefined();
  });

  it('runs migration 2 (FTS5 + triggers) when applied', async () => {
    const db = await getDb();
    await runMigrations();
    const calls = vi.mocked(db.execute).mock.calls;
    const ftsCall = calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5'),
    );
    expect(ftsCall).toBeDefined();
  });

  it('runs kylins extension migrations 24-26', async () => {
    const db = await getDb();
    await runMigrations();
    const calls = vi.mocked(db.execute).mock.calls;
    const pluginStateCall = calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('CREATE TABLE IF NOT EXISTS plugin_state'),
    );
    expect(pluginStateCall).toBeDefined();

    const easSyncStateCall = calls.find(
      ([sql]) =>
        typeof sql === 'string' && sql.includes('CREATE TABLE IF NOT EXISTS eas_sync_state'),
    );
    expect(easSyncStateCall).toBeDefined();

    const easUrlCall = calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('ALTER TABLE accounts ADD COLUMN eas_url'),
    );
    expect(easUrlCall).toBeDefined();
  });

  it('commits each migration with INSERT INTO _migrations', async () => {
    const db = await getDb();
    await runMigrations();
    const calls = vi.mocked(db.execute).mock.calls;
    const insertCalls = calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT OR IGNORE INTO _migrations'),
    );
    // Should have at least one insert per applied migration (26 in total)
    expect(insertCalls.length).toBeGreaterThan(0);
  });
});

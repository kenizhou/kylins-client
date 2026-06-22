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

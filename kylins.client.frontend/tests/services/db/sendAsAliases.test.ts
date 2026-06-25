import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from '../../../src/services/db/connection';
import {
  getMappedAliasesForAccount,
  insertAlias,
  updateAlias,
  deleteAlias,
} from '../../../src/services/db/sendAsAliases';

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: vi.fn().mockResolvedValue({
      execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
      select: vi.fn().mockResolvedValue([]),
    }),
  },
}));

function mockSelect(rows: unknown[]) {
  return vi.mocked(getDb)().then((db) => {
    vi.mocked(db.select).mockResolvedValue(rows);
  });
}

beforeEach(async () => {
  const db = await getDb();
  vi.mocked(db.execute).mockClear();
  vi.mocked(db.select).mockClear();
});

describe('sendAsAliases service', () => {
  describe('getMappedAliasesForAccount', () => {
    it('maps raw rows to SendAsAlias objects', async () => {
      await mockSelect([
        {
          id: 'a1',
          account_id: 'acc1',
          email: 'alias@example.com',
          display_name: 'Alias Name',
          reply_to_address: 'reply@example.com',
          signature_id: null,
          is_primary: 0,
          is_default: 1,
          treat_as_alias: 1,
          verification_status: 'accepted',
          created_at: 1,
        },
      ]);
      const aliases = await getMappedAliasesForAccount('acc1');
      expect(aliases).toHaveLength(1);
      expect(aliases[0]).toMatchObject({
        id: 'a1',
        email: 'alias@example.com',
        displayName: 'Alias Name',
        replyTo: 'reply@example.com',
        isDefault: true,
        treatAsAlias: true,
      });
    });
  });

  describe('insertAlias', () => {
    it('inserts an alias', async () => {
      const db = await getDb();
      vi.mocked(db.select).mockResolvedValue([]);
      const id = await insertAlias({
        accountId: 'acc1',
        email: 'alias@example.com',
        displayName: 'Alias',
        replyTo: 'reply@example.com',
        isDefault: false,
        treatAsAlias: true,
      });
      expect(id).toBeTypeOf('string');
      expect(vi.mocked(db.execute)).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO send_as_aliases'),
        expect.arrayContaining(['acc1', 'alias@example.com', 'Alias', 'reply@example.com', 0, 1]),
      );
    });

    it('clears the previous default when inserting a new default', async () => {
      const db = await getDb();
      vi.mocked(db.select).mockResolvedValue([]);
      await insertAlias({
        accountId: 'acc1',
        email: 'default@example.com',
        isDefault: true,
      });
      expect(vi.mocked(db.execute)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE send_as_aliases SET is_default = 0 WHERE account_id = $1'),
        ['acc1'],
      );
    });
  });

  describe('updateAlias', () => {
    it('updates alias fields', async () => {
      const db = await getDb();
      vi.mocked(db.select).mockResolvedValue([{ account_id: 'acc1' }]);
      await updateAlias('a1', {
        displayName: 'Updated',
        replyTo: 'new@example.com',
        isDefault: false,
        treatAsAlias: false,
      });
      expect(vi.mocked(db.execute)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE send_as_aliases SET'),
        expect.arrayContaining(['Updated', 'new@example.com', 0, 0]),
      );
    });

    it('clears previous default when setting a new default', async () => {
      const db = await getDb();
      vi.mocked(db.select).mockResolvedValue([{ account_id: 'acc1' }]);
      await updateAlias('a1', { isDefault: true });
      expect(vi.mocked(db.execute)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE send_as_aliases SET is_default = 0 WHERE account_id = $1'),
        ['acc1'],
      );
    });
  });

  describe('deleteAlias', () => {
    it('deletes by id', async () => {
      const db = await getDb();
      await deleteAlias('a1');
      expect(vi.mocked(db.execute)).toHaveBeenCalledWith(
        'DELETE FROM send_as_aliases WHERE id = $1',
        ['a1'],
      );
    });
  });
});

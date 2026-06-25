import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from '../../../src/services/db/connection';
import {
  getSignaturesForAccount,
  getDefaultSignature,
  insertSignature,
  updateSignature,
  deleteSignature,
  isSignatureContext,
  type DbSignature,
} from '../../../src/services/db/signatures';

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

describe('signatures service', () => {
  describe('getSignaturesForAccount', () => {
    it('orders signatures by sort_order and created_at', async () => {
      const rows: DbSignature[] = [
        {
          id: 's1',
          account_id: 'acc1',
          name: 'Work',
          body_html: '<p>Work sig</p>',
          is_default: 1,
          sort_order: 0,
          context: 'all',
        },
      ];
      await mockSelect(rows);
      const result = await getSignaturesForAccount('acc1');
      expect(result).toEqual(rows);
      const db = await getDb();
      expect(vi.mocked(db.select)).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY sort_order, created_at'),
        ['acc1'],
      );
    });
  });

  describe('getDefaultSignature', () => {
    it('returns the exact-context default when present', async () => {
      const replySig: DbSignature = {
        id: 'reply-sig',
        account_id: 'acc1',
        name: 'Reply',
        body_html: '<p>Reply sig</p>',
        is_default: 1,
        sort_order: 0,
        context: 'reply',
      };
      await mockSelect([replySig]);
      const result = await getDefaultSignature('acc1', 'reply');
      expect(result).toEqual(replySig);
    });

    it('falls back to the all-context default when no context default exists', async () => {
      const allSig: DbSignature = {
        id: 'all-sig',
        account_id: 'acc1',
        name: 'Default',
        body_html: '<p>Default sig</p>',
        is_default: 1,
        sort_order: 0,
        context: 'all',
      };
      await mockSelect([allSig]);
      const result = await getDefaultSignature('acc1', 'new');
      expect(result).toEqual(allSig);
      const db = await getDb();
      expect(vi.mocked(db.select)).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY CASE WHEN context = $2 THEN 0 ELSE 1 END"),
        ['acc1', 'new'],
      );
    });

    it('defaults context to all when omitted', async () => {
      await mockSelect([]);
      await getDefaultSignature('acc1');
      const db = await getDb();
      expect(vi.mocked(db.select)).toHaveBeenCalledWith(
        expect.stringContaining("context = $2"),
        ['acc1', 'all'],
      );
    });
  });

  describe('insertSignature', () => {
    it('inserts a signature with the supplied context', async () => {
      const db = await getDb();
      vi.mocked(db.select).mockResolvedValue([]);
      const id = await insertSignature({
        accountId: 'acc1',
        name: 'Reply',
        bodyHtml: '<p>Reply</p>',
        isDefault: false,
        context: 'reply',
      });
      expect(id).toBeTypeOf('string');
      expect(vi.mocked(db.execute)).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO signatures'),
        expect.arrayContaining(['acc1', 'Reply', '<p>Reply</p>', 0, 'reply']),
      );
    });

    it('clears the previous default for the same context', async () => {
      const db = await getDb();
      vi.mocked(db.select).mockResolvedValue([]);
      await insertSignature({
        accountId: 'acc1',
        name: 'New default',
        bodyHtml: '<p>Default</p>',
        isDefault: true,
        context: 'new',
      });
      expect(vi.mocked(db.execute)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE signatures SET is_default = 0 WHERE account_id = $1 AND context = $2'),
        ['acc1', 'new'],
      );
    });
  });

  describe('updateSignature', () => {
    it('updates name and body', async () => {
      const db = await getDb();
      vi.mocked(db.select).mockResolvedValue([
        { account_id: 'acc1', context: 'all' },
      ]);
      await updateSignature('s1', { name: 'Updated', bodyHtml: '<p>Updated</p>' });
      expect(vi.mocked(db.execute)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE signatures SET name = $1, body_html = $2 WHERE id = $3'),
        ['Updated', '<p>Updated</p>', 's1'],
      );
    });

    it('clears the previous default for the target context', async () => {
      const db = await getDb();
      vi.mocked(db.select).mockResolvedValue([
        { account_id: 'acc1', context: 'reply' },
      ]);
      await updateSignature('s1', { isDefault: true, context: 'reply' });
      const calls = vi.mocked(db.execute).mock.calls;
      // Should have two calls: clear-default + dynamic update
      expect(calls.length).toBe(2);
      expect(calls[0]).toEqual([
        expect.stringContaining('UPDATE signatures SET is_default = 0 WHERE account_id = $1 AND context = $2'),
        ['acc1', 'reply'],
      ]);
    });
  });

  describe('deleteSignature', () => {
    it('deletes by id', async () => {
      const db = await getDb();
      await deleteSignature('s1');
      expect(vi.mocked(db.execute)).toHaveBeenCalledWith(
        'DELETE FROM signatures WHERE id = $1',
        ['s1'],
      );
    });
  });

  describe('isSignatureContext', () => {
    it('accepts valid contexts', () => {
      expect(isSignatureContext('all')).toBe(true);
      expect(isSignatureContext('new')).toBe(true);
      expect(isSignatureContext('reply')).toBe(true);
      expect(isSignatureContext('forward')).toBe(true);
    });

    it('rejects invalid contexts', () => {
      expect(isSignatureContext('replyAll')).toBe(false);
      expect(isSignatureContext('invalid')).toBe(false);
    });
  });
});

// Task 5 clean-cut: sendAsAliases.ts now routes through `invoke('db_*')`
// instead of getDb(). Mock invoke and assert the wrapper forwards the right
// command + args. The pure TS helpers (mapDbAlias, accountAsAlias) are still
// tested directly with raw row fixtures.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getMappedAliasesForAccount,
  getAliasesForAccount,
  insertAlias,
  updateAlias,
  deleteAlias,
  mapDbAlias,
  accountAsAlias,
  type DbSendAsAlias,
} from '../../../src/services/db/sendAsAliases';
import { wireDefaultDbResults } from '../../../src/test/mockInvoke';
import type { Account } from '../../../src/types';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

const rawRow: DbSendAsAlias = {
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
};

describe('sendAsAliases service', () => {
  describe('mapDbAlias (pure)', () => {
    it('maps a raw snake_case row to a SendAsAlias', () => {
      const alias = mapDbAlias(rawRow);
      expect(alias).toMatchObject({
        id: 'a1',
        email: 'alias@example.com',
        displayName: 'Alias Name',
        replyTo: 'reply@example.com',
        isDefault: true,
        treatAsAlias: true,
      });
    });
  });

  describe('accountAsAlias (pure)', () => {
    it('synthesizes a primary alias from an account', () => {
      const account = { id: 'acc1', email: 'me@x.com', displayName: 'Me' } as Account;
      const alias = accountAsAlias(account);
      expect(alias.isPrimary).toBe(true);
      expect(alias.isDefault).toBe(true);
      expect(alias.email).toBe('me@x.com');
    });
  });

  describe('getAliasesForAccount', () => {
    it('forwards to db_get_aliases_for_account', async () => {
      mockInvoke.mockResolvedValueOnce([rawRow]);
      const rows = await getAliasesForAccount('acc1');
      expect(rows).toEqual([rawRow]);
      expect(mockInvoke).toHaveBeenCalledWith('db_get_aliases_for_account', { accountId: 'acc1' });
    });
  });

  describe('getMappedAliasesForAccount', () => {
    it('fetches raw rows and maps them', async () => {
      mockInvoke.mockResolvedValueOnce([rawRow]);
      const aliases = await getMappedAliasesForAccount('acc1');
      expect(aliases).toHaveLength(1);
      expect(aliases[0]).toMatchObject({
        id: 'a1',
        email: 'alias@example.com',
        isDefault: true,
      });
    });
  });

  describe('insertAlias', () => {
    it('forwards the input payload (nulls for omitted optionals) and returns the id', async () => {
      mockInvoke.mockResolvedValueOnce('new-id');
      const id = await insertAlias({
        accountId: 'acc1',
        email: 'alias@example.com',
        displayName: 'Alias',
        replyTo: 'reply@example.com',
        isDefault: false,
        treatAsAlias: true,
      });
      expect(id).toBe('new-id');
      expect(mockInvoke).toHaveBeenCalledWith('db_insert_alias', {
        input: {
          accountId: 'acc1',
          email: 'alias@example.com',
          displayName: 'Alias',
          replyTo: 'reply@example.com',
          isDefault: false,
          treatAsAlias: true,
        },
      });
    });
  });

  describe('updateAlias', () => {
    it('forwards only the provided fields', async () => {
      await updateAlias('a1', {
        displayName: 'Updated',
        replyTo: 'new@example.com',
        isDefault: false,
        treatAsAlias: false,
      });
      expect(mockInvoke).toHaveBeenCalledWith('db_update_alias', {
        id: 'a1',
        updates: {
          displayName: 'Updated',
          replyTo: 'new@example.com',
          isDefault: false,
          treatAsAlias: false,
        },
      });
    });
  });

  describe('deleteAlias', () => {
    it('deletes by id', async () => {
      await deleteAlias('a1');
      expect(mockInvoke).toHaveBeenCalledWith('db_delete_alias', { id: 'a1' });
    });
  });
});

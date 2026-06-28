// Task 5 clean-cut: signatures.ts now routes through `invoke('db_*')` instead
// of getDb(). Mock invoke and assert the wrapper forwards the right command +
// args and passes the Rust return value through unchanged. The pure TS helpers
// (isSignatureContext, SIGNATURE_CONTEXTS, CONTEXT_LABELS) are still tested
// directly.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getSignaturesForAccount,
  getDefaultSignature,
  insertSignature,
  updateSignature,
  deleteSignature,
  isSignatureContext,
  signatureContextForComposerMode,
  SIGNATURE_CONTEXTS,
  CONTEXT_LABELS,
  type DbSignature,
} from '../../../src/services/db/signatures';
import { wireDefaultDbResults } from '../../../src/test/mockInvoke';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

describe('signatures service', () => {
  describe('getSignaturesForAccount', () => {
    it('forwards to db_get_signatures_for_account and returns rows', async () => {
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
      mockInvoke.mockResolvedValueOnce(rows);
      const result = await getSignaturesForAccount('acc1');
      expect(result).toEqual(rows);
      expect(mockInvoke).toHaveBeenCalledWith('db_get_signatures_for_account', {
        accountId: 'acc1',
      });
    });
  });

  describe('getDefaultSignature', () => {
    it('forwards with the supplied context', async () => {
      const replySig: DbSignature = {
        id: 'reply-sig',
        account_id: 'acc1',
        name: 'Reply',
        body_html: '<p>Reply sig</p>',
        is_default: 1,
        sort_order: 0,
        context: 'reply',
      };
      mockInvoke.mockResolvedValueOnce(replySig);
      const result = await getDefaultSignature('acc1', 'reply');
      expect(result).toEqual(replySig);
      expect(mockInvoke).toHaveBeenCalledWith('db_get_default_signature', {
        accountId: 'acc1',
        context: 'reply',
      });
    });

    it('defaults context to null (Rust treats null as "all") when omitted', async () => {
      mockInvoke.mockResolvedValueOnce(null);
      await getDefaultSignature('acc1');
      expect(mockInvoke).toHaveBeenCalledWith('db_get_default_signature', {
        accountId: 'acc1',
        context: null,
      });
    });
  });

  describe('insertSignature', () => {
    it('forwards the input payload and returns the new id', async () => {
      mockInvoke.mockResolvedValueOnce('new-id');
      const id = await insertSignature({
        accountId: 'acc1',
        name: 'Reply',
        bodyHtml: '<p>Reply</p>',
        isDefault: false,
        context: 'reply',
      });
      expect(id).toBe('new-id');
      expect(mockInvoke).toHaveBeenCalledWith('db_insert_signature', {
        input: {
          accountId: 'acc1',
          name: 'Reply',
          bodyHtml: '<p>Reply</p>',
          isDefault: false,
          context: 'reply',
        },
      });
    });

    it('defaults context to null when omitted', async () => {
      mockInvoke.mockResolvedValueOnce('new-id');
      await insertSignature({
        accountId: 'acc1',
        name: 'Default',
        bodyHtml: '<p>Default</p>',
        isDefault: true,
      });
      expect(mockInvoke).toHaveBeenCalledWith('db_insert_signature', {
        input: {
          accountId: 'acc1',
          name: 'Default',
          bodyHtml: '<p>Default</p>',
          isDefault: true,
          context: null,
        },
      });
    });
  });

  describe('updateSignature', () => {
    it('forwards only the provided fields', async () => {
      await updateSignature('s1', { name: 'Updated', bodyHtml: '<p>Updated</p>' });
      expect(mockInvoke).toHaveBeenCalledWith('db_update_signature', {
        id: 's1',
        updates: { name: 'Updated', bodyHtml: '<p>Updated</p>' },
      });
    });

    it('forwards isDefault + context together', async () => {
      await updateSignature('s1', { isDefault: true, context: 'reply' });
      expect(mockInvoke).toHaveBeenCalledWith('db_update_signature', {
        id: 's1',
        updates: { isDefault: true, context: 'reply' },
      });
    });

    it('forwards an empty payload when no fields are set (Rust treats as no-op)', async () => {
      await updateSignature('s1', {});
      expect(mockInvoke).toHaveBeenCalledWith('db_update_signature', {
        id: 's1',
        updates: {},
      });
    });
  });

  describe('deleteSignature', () => {
    it('deletes by id', async () => {
      await deleteSignature('s1');
      expect(mockInvoke).toHaveBeenCalledWith('db_delete_signature', { id: 's1' });
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

  describe('signatureContextForComposerMode', () => {
    it('maps composer modes to signature contexts', () => {
      expect(signatureContextForComposerMode('new')).toBe('new');
      expect(signatureContextForComposerMode('reply')).toBe('reply');
      expect(signatureContextForComposerMode('replyAll')).toBe('reply');
      expect(signatureContextForComposerMode('forward')).toBe('forward');
    });
  });

  describe('constants', () => {
    it('exposes the canonical context list and labels', () => {
      expect(SIGNATURE_CONTEXTS).toEqual(['all', 'new', 'reply', 'forward']);
      expect(CONTEXT_LABELS.reply).toBe('Reply');
    });
  });
});

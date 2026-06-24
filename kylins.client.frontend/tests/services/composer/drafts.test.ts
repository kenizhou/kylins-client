import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from '@tauri-apps/plugin-sql';
import {
  createDraft,
  updateDraft,
  saveDraft,
  deleteDraft,
  getDraft,
  type DraftInput,
} from '../../../src/services/composer/drafts';
import { getDb } from '../../../src/services/db/connection';

// Keep the real pure helpers (buildDynamicUpdate, boolToInt, withTransaction),
// override `getDb`, and reimplement `selectFirstBy` so it routes through the
// mocked `getDb` (the real one closes over the module's internal getDb and would
// bypass the mock).
vi.mock('../../../src/services/db/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/db/connection')>();
  const getDb = vi.fn();
  return {
    ...actual,
    getDb,
    selectFirstBy: vi.fn(async (sql: string, params: unknown[] = []) => {
      const db = await getDb();
      const rows = await db.select(sql, params);
      return rows[0] ?? null;
    }),
  };
});

const mockDb = {
  execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
  select: vi.fn().mockResolvedValue([]),
};

const baseInput: DraftInput = {
  accountId: 'acc-1',
  to: [{ name: 'alice@example.com', email: 'alice@example.com' }],
  cc: [{ name: 'bob@example.com', email: 'bob@example.com' }],
  bcc: [],
  subject: 'Hello',
  bodyHtml: '<p>Hi</p>',
  fromEmail: 'me@example.com',
  threadId: 'thread-1',
  inReplyToMessageId: '<orig@example.com>',
  signatureId: 'sig-1',
  attachments: [{ filename: 'a.txt', mimeType: 'text/plain', content: 'YQ==', size: 1 }],
};

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Database);
  mockDb.execute.mockClear();
  mockDb.select.mockClear();
});

describe('composer/drafts', () => {
  it('createDraft inserts and returns a new id', async () => {
    const id = await createDraft(baseInput);
    expect(id).toBeTruthy();
    const [sql, params] = mockDb.execute.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO local_drafts');
    // account_id is the 2nd positional param; addresses are JSON-encoded.
    expect(params![1]).toBe('acc-1');
    expect(params![2]).toBe(JSON.stringify(['alice@example.com']));
    expect(params![11]).toBe(JSON.stringify(baseInput.attachments));
  });

  it('updateDraft builds a dynamic UPDATE including updated_at', async () => {
    await updateDraft('draft-1', baseInput);
    const [sql] = mockDb.execute.mock.calls[0]!;
    expect(sql).toContain('UPDATE local_drafts SET');
    expect(sql).toContain('updated_at =');
    expect(sql).toContain('WHERE id =');
  });

  it('saveDraft updates when the existing id is present', async () => {
    mockDb.select.mockResolvedValueOnce([{ id: 'draft-1' }]);
    const id = await saveDraft(baseInput, 'draft-1');
    expect(id).toBe('draft-1');
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(mockDb.execute.mock.calls[0]![0]).toContain('UPDATE local_drafts');
  });

  it('saveDraft creates when the existing id is absent', async () => {
    // getDraft returns nothing → fall through to create.
    mockDb.select.mockResolvedValueOnce([]);
    const id = await saveDraft(baseInput, 'draft-missing');
    expect(id).not.toBe('draft-missing');
    expect(mockDb.execute.mock.calls[0]![0]).toContain('INSERT INTO local_drafts');
  });

  it('getDraft returns the first matching row', async () => {
    mockDb.select.mockResolvedValueOnce([{ id: 'draft-1', subject: 'Hello' }]);
    const draft = await getDraft('draft-1');
    expect(draft).not.toBeNull();
    expect(draft!.id).toBe('draft-1');
  });

  it('deleteDraft deletes by id', async () => {
    await deleteDraft('draft-1');
    const [sql, params] = mockDb.execute.mock.calls[0]!;
    expect(sql).toContain('DELETE FROM local_drafts WHERE id = $1');
    expect(params![0]).toBe('draft-1');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getFoldersByAccount,
  getAllFolders,
  getFolderByRole,
  getUnreadCountsByAccount,
  upsertFolders,
  createFolder,
  renameFolder,
  deleteFolder,
} from '../../../src/services/db/labels';
import { getDb, withTransaction } from '../../../src/services/db/connection';
import type { MailFolder } from '../../../src/services/mail/folders';
import type Database from '@tauri-apps/plugin-sql';

vi.mock('../../../src/services/db/connection', () => {
  const getDb = vi.fn();
  const withTransaction = vi.fn(async (fn: (db: unknown) => Promise<void>) => {
    const db = await getDb();
    return fn(db);
  });
  return { getDb, withTransaction };
});

const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Database);
  vi.mocked(withTransaction).mockClear();
  mockDb.select.mockReset();
  mockDb.execute.mockReset();
});

const row = (over: Record<string, unknown> = {}) => ({
  id: 'inbox',
  account_id: 'acc-1',
  name: 'Inbox',
  type: 'system',
  visible: 1,
  sort_order: 0,
  source: 'imap',
  role: 'inbox',
  parent_id: null,
  remote_id: 'inbox',
  delimiter: null,
  mail_class: 'mail',
  unread_count: 0,
  total_count: 0,
  hierarchical_name: null,
  ...over,
});

describe('getFoldersByAccount', () => {
  it('maps rows to MailFolder and orders system-by-role then user-by-name', async () => {
    mockDb.select.mockResolvedValue([
      row({ id: 'zebra', name: 'Zebra', role: null, type: 'user', sort_order: 0 }),
      row({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
      row({ id: 'newsletters', name: 'Newsletters', role: null, type: 'user', sort_order: 0 }),
      row({ id: 'sent', name: 'Sent', role: 'sent' }),
    ]);
    const folders = await getFoldersByAccount('acc-1');
    expect(folders.map((f) => f.id)).toEqual(['inbox', 'sent', 'newsletters', 'zebra']);
  });

  it('coerces row fields correctly', async () => {
    mockDb.select.mockResolvedValue([
      row({ id: 'f1', name: 'F1', role: null, visible: 1, unread_count: 7, source: 'eas' }),
    ]);
    const [f] = await getFoldersByAccount('acc-1');
    expect(f).toBeDefined();
    expect(f!.visible).toBe(true);
    expect(f!.unreadCount).toBe(7);
    expect(f!.source).toBe('eas');
    expect(f!.role).toBeNull();
  });
});

describe('getAllFolders', () => {
  it('returns folders across accounts', async () => {
    mockDb.select.mockResolvedValue([row({ id: 'a' }), row({ id: 'b', account_id: 'acc-2' })]);
    const folders = await getAllFolders();
    expect(folders).toHaveLength(2);
  });
});

describe('getFolderByRole', () => {
  it('returns the matching folder', async () => {
    mockDb.select.mockResolvedValue([row({ id: 'inbox', role: 'inbox' })]);
    const f = await getFolderByRole('acc-1', 'inbox');
    expect(f?.id).toBe('inbox');
  });

  it('returns null when not found', async () => {
    mockDb.select.mockResolvedValue([]);
    expect(await getFolderByRole('acc-1', 'inbox')).toBeNull();
  });
});

describe('getUnreadCountsByAccount', () => {
  it('groups unread thread counts by label id', async () => {
    mockDb.select.mockResolvedValue([
      { id: 'inbox', unread: 3 },
      { id: 'newsletters', unread: 1 },
    ]);
    const counts = await getUnreadCountsByAccount('acc-1');
    expect(counts).toEqual({ inbox: 3, newsletters: 1 });
  });
});

describe('upsertFolders', () => {
  it('inserts folders with ON CONFLICT upsert inside a transaction', async () => {
    const folder: MailFolder = {
      id: 'acc-1:INBOX',
      accountId: 'acc-1',
      source: 'imap',
      role: 'inbox',
      name: 'Inbox',
      parentId: null,
      remoteId: 'INBOX',
      delimiter: '/',
      unreadCount: 0,
      totalCount: 0,
      sortOrder: 0,
      visible: true,
      hierarchicalName: null,
      mailClass: 'mail',
    };
    await upsertFolders([folder]);
    expect(withTransaction).toHaveBeenCalledOnce();
    expect(mockDb.execute).toHaveBeenCalledOnce();
    const [sql] = mockDb.execute.mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO labels');
    expect(String(sql)).toContain('ON CONFLICT(account_id, id)');
    // Counts are intentionally not overwritten on conflict.
    expect(String(sql)).not.toContain('unread_count = excluded');
  });

  it('is a no-op for an empty list', async () => {
    await upsertFolders([]);
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

describe('createFolder', () => {
  it('inserts a local user folder appended after the current max sort_order', async () => {
    mockDb.select.mockResolvedValue([{ m: 5 }]);
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    const folder = await createFolder('acc-1', 'Projects');
    expect(folder.source).toBe('local');
    expect(folder.role).toBeNull();
    expect(folder.parentId).toBeNull();
    expect(folder.sortOrder).toBe(6);
    const [sql, params] = mockDb.execute.mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO labels');
    expect(String(sql)).toContain("'user'");
    expect(String(sql)).toContain("'local'");
    expect(params).toContain('acc-1');
    expect(params).toContain('Projects');
    expect(params).toContain(6);
  });

  it('passes through parentId for a subfolder', async () => {
    mockDb.select.mockResolvedValue([{ m: null }]);
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    const folder = await createFolder('acc-1', 'Apollo', { parentId: 'col-projects' });
    expect(folder.parentId).toBe('col-projects');
    expect(folder.sortOrder).toBe(0); // MAX(null) treated as -1
  });
});

describe('renameFolder', () => {
  it('updates the name', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await renameFolder('acc-1', 'fid', 'Renamed');
    const [sql, params] = mockDb.execute.mock.calls[0];
    expect(String(sql)).toContain('UPDATE labels SET name =');
    expect(params).toEqual(['acc-1', 'fid', 'Renamed']);
  });
});

describe('deleteFolder', () => {
  it('removes thread_labels then the label, inside a transaction', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await deleteFolder('acc-1', 'fid');
    expect(withTransaction).toHaveBeenCalledOnce();
    expect(mockDb.execute).toHaveBeenCalledTimes(2);
    const sqls = mockDb.execute.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('DELETE FROM thread_labels'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM labels'))).toBe(true);
    // Every statement is scoped to the account + label id.
    for (const [, params] of mockDb.execute.mock.calls) {
      expect(params).toEqual(['acc-1', 'fid']);
    }
  });
});

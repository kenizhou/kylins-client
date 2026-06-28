// Task 5 cutover: labels.ts now routes through `invoke('db_*')`. Rust returns
// ready camelCase MailFolder objects; the TS wrapper sorts them client-side
// (system-role order, then sort_order, then name) for getFoldersByAccount,
// matching the pre-cutover contract. These tests assert the wrapper invokes
// the right command + args and applies the sort correctly.

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { wireDefaultDbResults } from '../../../src/test/mockInvoke';
import type { MailFolder } from '../../../src/services/mail/folders';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

const folder = (over: Partial<MailFolder> = {}): MailFolder => ({
  id: 'inbox',
  accountId: 'acc-1',
  source: 'imap',
  role: 'inbox',
  name: 'Inbox',
  parentId: null,
  remoteId: 'inbox',
  delimiter: null,
  unreadCount: 0,
  totalCount: 0,
  sortOrder: 0,
  visible: true,
  hierarchicalName: null,
  mailClass: 'mail',
  ...over,
});

describe('getFoldersByAccount', () => {
  it('invokes db_get_folders_by_account and sorts system-by-role then user-by-name', async () => {
    // Rust returns unspecified order; the wrapper must re-sort.
    mockInvoke.mockResolvedValueOnce([
      folder({ id: 'zebra', name: 'Zebra', role: null, sortOrder: 0 }),
      folder({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
      folder({ id: 'newsletters', name: 'Newsletters', role: null, sortOrder: 0 }),
      folder({ id: 'sent', name: 'Sent', role: 'sent' }),
    ]);
    const folders = await getFoldersByAccount('acc-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_folders_by_account', { accountId: 'acc-1' });
    expect(folders.map((f) => f.id)).toEqual(['inbox', 'sent', 'newsletters', 'zebra']);
  });

  it('passes the row fields through unchanged', async () => {
    mockInvoke.mockResolvedValueOnce([
      folder({ id: 'f1', name: 'F1', role: null, visible: true, unreadCount: 7, source: 'eas' }),
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
  it('invokes db_get_all_folders and returns the result unsorted (legacy behavior)', async () => {
    mockInvoke.mockResolvedValueOnce([folder({ id: 'a' }), folder({ id: 'b' })]);
    const folders = await getAllFolders();
    expect(mockInvoke).toHaveBeenCalledWith('db_get_all_folders');
    expect(folders).toHaveLength(2);
  });
});

describe('getFolderByRole', () => {
  it('invokes db_get_folder_by_role with (accountId, role)', async () => {
    mockInvoke.mockResolvedValueOnce(folder({ id: 'inbox', role: 'inbox' }));
    const f = await getFolderByRole('acc-1', 'inbox');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_folder_by_role', {
      accountId: 'acc-1',
      role: 'inbox',
    });
    expect(f?.id).toBe('inbox');
  });

  it('returns null when not found', async () => {
    mockInvoke.mockResolvedValueOnce(null);
    expect(await getFolderByRole('acc-1', 'inbox')).toBeNull();
  });
});

describe('getUnreadCountsByAccount', () => {
  it('invokes db_get_unread_counts_by_account and returns the map', async () => {
    mockInvoke.mockResolvedValueOnce({ inbox: 3, newsletters: 1 });
    const counts = await getUnreadCountsByAccount('acc-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_unread_counts_by_account', {
      accountId: 'acc-1',
    });
    expect(counts).toEqual({ inbox: 3, newsletters: 1 });
  });
});

describe('upsertFolders', () => {
  it('invokes db_upsert_folders with the folders array', async () => {
    const input: MailFolder = folder({ id: 'acc-1:INBOX' });
    await upsertFolders([input]);
    expect(mockInvoke).toHaveBeenCalledWith('db_upsert_folders', { folders: [input] });
  });

  it('is a no-op for an empty list (skips the invoke)', async () => {
    await upsertFolders([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('createFolder', () => {
  it('invokes db_create_folder with (accountId, name, parentId=null) and returns the Rust folder', async () => {
    const created = folder({ id: 'new', name: 'Projects', source: 'local', role: null });
    mockInvoke.mockResolvedValueOnce(created);
    const result = await createFolder('acc-1', 'Projects');
    expect(mockInvoke).toHaveBeenCalledWith('db_create_folder', {
      accountId: 'acc-1',
      name: 'Projects',
      parentId: null,
    });
    expect(result.id).toBe('new');
    expect(result.source).toBe('local');
  });

  it('passes through parentId for a subfolder', async () => {
    mockInvoke.mockResolvedValueOnce(folder({ id: 'sub' }));
    await createFolder('acc-1', 'Apollo', { parentId: 'col-projects' });
    expect(mockInvoke).toHaveBeenCalledWith('db_create_folder', {
      accountId: 'acc-1',
      name: 'Apollo',
      parentId: 'col-projects',
    });
  });
});

describe('renameFolder', () => {
  it('invokes db_rename_folder with (accountId, labelId, newName)', async () => {
    await renameFolder('acc-1', 'fid', 'Renamed');
    expect(mockInvoke).toHaveBeenCalledWith('db_rename_folder', {
      accountId: 'acc-1',
      labelId: 'fid',
      newName: 'Renamed',
    });
  });
});

describe('deleteFolder', () => {
  it('invokes db_delete_folder with (accountId, labelId)', async () => {
    await deleteFolder('acc-1', 'fid');
    expect(mockInvoke).toHaveBeenCalledWith('db_delete_folder', {
      accountId: 'acc-1',
      labelId: 'fid',
    });
  });
});

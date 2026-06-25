import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFolderStore } from '../../src/stores/folderStore';
import { useAccountStore } from '../../src/stores/accountStore';
import {
  getFoldersByAccount,
  getUnreadCountsByAccount,
  createFolder as createFolderRow,
  renameFolder as renameFolderRow,
  deleteFolder as deleteFolderRow,
} from '../../src/services/db/labels';
import { EasProvider } from '../../src/services/mail/easProvider';
import { ImapProvider } from '../../src/services/mail/imapProvider';
import { getSetting, setSetting } from '../../src/services/settings';
import type { Account } from '../../src/types';
import type { MailFolder as Folder } from '../../src/services/mail/folders';

vi.mock('../../src/services/db/labels', () => ({
  getFoldersByAccount: vi.fn(),
  getUnreadCountsByAccount: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
}));

vi.mock('../../src/services/mail/easProvider', () => ({
  EasProvider: vi.fn(function () {
    return { syncFolder: vi.fn().mockResolvedValue({ added: 2, updated: 1, deleted: 0 }) };
  }),
}));

vi.mock('../../src/services/mail/imapProvider', () => ({
  ImapProvider: vi.fn(function () {
    return { syncFolder: vi.fn().mockResolvedValue({ added: 1, updated: 0, deleted: 0 }) };
  }),
}));

vi.mock('../../src/services/settings', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

const inbox: Folder = {
  id: 'inbox',
  accountId: 'acc-1',
  source: 'local',
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
};

const todo: Folder = { ...inbox, id: 'todo', role: null, name: 'Todo' };

const account = { id: 'acc-1', email: 'a@b.com', provider: 'imap' } as unknown as Account;

function resetStores(): void {
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    defaultAccountId: null,
  });
  useFolderStore.setState({
    byAccount: {},
    favorites: new Set(),
    unreadCounts: {},
    selected: null,
    isLoading: false,
  });
}

beforeEach(() => {
  resetStores();
  vi.mocked(getFoldersByAccount).mockReset();
  vi.mocked(getUnreadCountsByAccount).mockReset();
  vi.mocked(getSetting).mockReset();
  vi.mocked(setSetting).mockReset();
  vi.mocked(getSetting).mockResolvedValue(null);
  vi.mocked(createFolderRow).mockReset();
  vi.mocked(renameFolderRow).mockReset();
  vi.mocked(deleteFolderRow).mockReset();
  vi.mocked(EasProvider).mockClear();
  vi.mocked(ImapProvider).mockClear();
});

describe('folderStore.loadLabels', () => {
  it('loads folders + unread counts and defaults selection to the inbox', async () => {
    useAccountStore.getState().setAccounts([account]);
    vi.mocked(getFoldersByAccount).mockResolvedValue([inbox, todo]);
    vi.mocked(getUnreadCountsByAccount).mockResolvedValue({ inbox: 3 });

    await useFolderStore.getState().loadLabels();

    const s = useFolderStore.getState();
    expect(s.byAccount['acc-1']).toHaveLength(2);
    expect(s.getUnread('acc-1', 'inbox')).toBe(3);
    expect(s.selected).toEqual({ accountId: 'acc-1', labelId: 'inbox' });
  });

  it('has no favorites by default', async () => {
    useAccountStore.getState().setAccounts([account]);
    vi.mocked(getFoldersByAccount).mockResolvedValue([inbox]);
    vi.mocked(getUnreadCountsByAccount).mockResolvedValue({});

    await useFolderStore.getState().loadLabels();

    const s = useFolderStore.getState();
    expect(s.favorites.size).toBe(0);
    expect(s.getFavoriteFolders()).toHaveLength(0);
  });

  it('loads favorites persisted in settings', async () => {
    useAccountStore.getState().setAccounts([account]);
    vi.mocked(getFoldersByAccount).mockResolvedValue([inbox, todo]);
    vi.mocked(getUnreadCountsByAccount).mockResolvedValue({});
    vi.mocked(getSetting).mockResolvedValue(JSON.stringify([['acc-1', 'todo']]));

    await useFolderStore.getState().loadLabels();

    const s = useFolderStore.getState();
    expect(s.isFavorite('acc-1', 'todo')).toBe(true);
    expect(s.getFavoriteFolders().map((f) => f.id)).toEqual(['todo']);
  });
});

describe('folderStore.toggleFavorite', () => {
  it('persists favorites to the settings KV', async () => {
    useFolderStore.setState({ byAccount: { 'acc-1': [inbox, todo] } });

    await useFolderStore.getState().toggleFavorite('acc-1', 'todo');
    expect(useFolderStore.getState().isFavorite('acc-1', 'todo')).toBe(true);
    expect(setSetting).toHaveBeenCalledWith('folder.favorites', expect.stringContaining('todo'));

    await useFolderStore.getState().toggleFavorite('acc-1', 'todo');
    expect(useFolderStore.getState().isFavorite('acc-1', 'todo')).toBe(false);
  });
});

describe('folderStore.selectLabel', () => {
  it('updates the selection', () => {
    useFolderStore.getState().selectLabel('acc-1', 'todo');
    expect(useFolderStore.getState().selected).toEqual({ accountId: 'acc-1', labelId: 'todo' });
  });
});

describe('folderStore.createFolder / renameFolder / deleteFolder', () => {
  it('createFolder calls the service and patches the account folder list in place', async () => {
    useAccountStore.getState().setAccounts([account]);
    vi.mocked(createFolderRow).mockResolvedValue(inbox);
    await useFolderStore.getState().createFolder('acc-1', 'New', null);
    expect(createFolderRow).toHaveBeenCalledWith('acc-1', 'New', { parentId: null });
    expect(useFolderStore.getState().byAccount['acc-1']).toContain(inbox);
  });

  it('renameFolder calls the service and patches the folder name in place', async () => {
    useFolderStore.setState({ byAccount: { 'acc-1': [inbox] } });
    vi.mocked(renameFolderRow).mockResolvedValue(undefined);
    await useFolderStore.getState().renameFolder('acc-1', 'inbox', 'In');
    expect(renameFolderRow).toHaveBeenCalledWith('acc-1', 'inbox', 'In');
    expect(useFolderStore.getState().byAccount['acc-1']?.[0]?.name).toBe('In');
  });

  it('deleteFolder removes the folder and its unread count in place', async () => {
    useFolderStore.setState({
      byAccount: { 'acc-1': [inbox] },
      unreadCounts: { 'acc-1__inbox': 3 },
    });
    vi.mocked(deleteFolderRow).mockResolvedValue(undefined);
    await useFolderStore.getState().deleteFolder('acc-1', 'inbox');
    expect(deleteFolderRow).toHaveBeenCalledWith('acc-1', 'inbox');
    expect(useFolderStore.getState().byAccount['acc-1']).toEqual([]);
    expect(useFolderStore.getState().unreadCounts['acc-1__inbox']).toBeUndefined();
  });

  it('decrementUnread lowers one folder badge and floors at 0', () => {
    useFolderStore.setState({ unreadCounts: { 'acc-1__inbox': 2 } });
    useFolderStore.getState().decrementUnread('acc-1', 'inbox');
    expect(useFolderStore.getState().unreadCounts['acc-1__inbox']).toBe(1);
    useFolderStore.getState().decrementUnread('acc-1', 'inbox');
    useFolderStore.getState().decrementUnread('acc-1', 'inbox'); // already 0 -> stays 0
    expect(useFolderStore.getState().unreadCounts['acc-1__inbox']).toBe(0);
  });
});

describe('folderStore.syncFolder', () => {
  it('stops without a provider for a local folder', async () => {
    await useFolderStore.getState().syncFolder(inbox); // inbox.source === 'local'
    expect(EasProvider).not.toHaveBeenCalled();
    expect(ImapProvider).not.toHaveBeenCalled();
  });

  it('stops without a provider for an unsupported account type', async () => {
    const gmailAccount = {
      id: 'g-1',
      email: 'a@gmail.com',
      provider: 'gmail_api',
    } as unknown as Account;
    useAccountStore.getState().setAccounts([gmailAccount]);
    const gmailFolder: Folder = { ...inbox, accountId: 'g-1', source: 'gmail' };
    await useFolderStore.getState().syncFolder(gmailFolder);
    expect(EasProvider).not.toHaveBeenCalled();
    expect(ImapProvider).not.toHaveBeenCalled();
  });

  it('uses the EAS provider for an EAS account folder and reloads labels', async () => {
    const easAccount = { id: 'e-1', email: 'a@ex.com', provider: 'eas' } as unknown as Account;
    useAccountStore.getState().setAccounts([easAccount]);
    const easFolder: Folder = { ...inbox, accountId: 'e-1', source: 'eas', remoteId: '1:5' };
    vi.mocked(getFoldersByAccount).mockResolvedValue([easFolder]);
    vi.mocked(getUnreadCountsByAccount).mockResolvedValue({});
    await useFolderStore.getState().syncFolder(easFolder);
    expect(EasProvider).toHaveBeenCalledWith(easAccount);
    expect(getFoldersByAccount).toHaveBeenCalledWith('e-1');
  });
});

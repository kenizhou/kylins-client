import { create } from 'zustand';
import {
  getFoldersByAccount,
  getUnreadCountsByAccount,
  createFolder as createFolderRow,
  renameFolder as renameFolderRow,
  deleteFolder as deleteFolderRow,
} from '../services/db/labels';
import { getSetting, setSetting } from '../services/settings';
import { EasProvider } from '../services/mail/easProvider';
import { ImapProvider } from '../services/mail/imapProvider';
import type { MailProvider } from '../services/mail/provider';
import { useAccountStore } from './accountStore';
import { useToastStore } from './toastStore';
import { useThreadStore } from './threadStore';
import type { MailFolder } from '../services/mail/folders';

// Favorites are user data, persisted in the settings KV (key `folder.favorites`)
// as a JSON array of [accountId, labelId] tuples — deliberately NOT a column on
// the labels table, so provider re-syncs can never clobber a user's pins.
const FAVORITES_KEY = 'folder.favorites';

/**
 * Composite key for per-folder state (unreadCounts, favorites). Exported so
 * components can subscribe to the `unreadCounts` map and look counts up
 * reactively — selecting the `getUnread` ACTION instead never re-renders,
 * because a store action is a stable function reference.
 */
export function favKey(accountId: string, labelId: string): string {
  return `${accountId}__${labelId}`;
}

/** Return a new byAccount with one account's folder list transformed (only if present). */
function patchAccount(
  byAccount: Record<string, MailFolder[]>,
  accountId: string,
  fn: (folders: MailFolder[]) => MailFolder[],
): Record<string, MailFolder[]> {
  const list = byAccount[accountId];
  if (!list) return byAccount;
  return { ...byAccount, [accountId]: fn(list) };
}

async function loadFavoritePairs(): Promise<Array<[string, string]>> {
  const raw = await getSetting(FAVORITES_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is [unknown, unknown] => Array.isArray(p) && p.length === 2)
      .map((p) => [String(p[0]), String(p[1])]);
  } catch {
    return [];
  }
}

async function saveFavoritePairs(pairs: Array<[string, string]>): Promise<void> {
  await setSetting(FAVORITES_KEY, JSON.stringify(pairs));
}

export interface FolderSelection {
  accountId: string;
  labelId: string;
}

export interface FolderState {
  byAccount: Record<string, MailFolder[]>;
  favorites: Set<string>;
  unreadCounts: Record<string, number>;
  selected: FolderSelection | null;
  isLoading: boolean;

  /** Load folders + unread counts + favorites for every configured account. */
  loadLabels: () => Promise<void>;
  /** Select the active account's Inbox (or first folder) if nothing is selected. */
  ensureDefaultSelection: () => void;
  selectLabel: (accountId: string, labelId: string) => void;
  toggleFavorite: (accountId: string, labelId: string) => Promise<void>;
  getUnread: (accountId: string, labelId: string) => number;
  isFavorite: (accountId: string, labelId: string) => boolean;
  /** Flattened list of folders the user has pinned, across accounts. */
  getFavoriteFolders: () => MailFolder[];

  // ---- User folder management (local-only for now) ----
  createFolder: (accountId: string, name: string, parentId?: string | null) => Promise<void>;
  renameFolder: (accountId: string, labelId: string, name: string) => Promise<void>;
  deleteFolder: (accountId: string, labelId: string) => Promise<void>;
  /** Decrement one folder's unread badge by 1 (used when a thread is read). */
  decrementUnread: (accountId: string, labelId: string) => void;
  /** Increment one folder's unread badge by 1 (used when a thread is marked unread). */
  incrementUnread: (accountId: string, labelId: string) => void;
  /** Best-effort message fetch via the account provider; toasts the result. */
  syncFolder: (folder: MailFolder) => Promise<void>;
}

export const useFolderStore = create<FolderState>((set, get) => ({
  byAccount: {},
  favorites: new Set(),
  unreadCounts: {},
  selected: null,
  isLoading: false,

  loadLabels: async () => {
    set({ isLoading: true });
    try {
      const accounts = useAccountStore.getState().accounts;
      const [folderEntries, unreadEntries, favPairs] = await Promise.all([
        Promise.all(accounts.map(async (a) => [a.id, await getFoldersByAccount(a.id)] as const)),
        Promise.all(
          accounts.map(async (a) => [a.id, await getUnreadCountsByAccount(a.id)] as const),
        ),
        loadFavoritePairs(),
      ]);

      const byAccount: Record<string, MailFolder[]> = {};
      for (const [id, folders] of folderEntries) {
        byAccount[id] = folders;
      }

      const unreadCounts: Record<string, number> = {};
      for (const [accountId, counts] of unreadEntries) {
        for (const [labelId, n] of Object.entries(counts)) {
          unreadCounts[favKey(accountId, labelId)] = n;
        }
      }

      const favorites = new Set(favPairs.map(([a, l]) => favKey(a, l)));
      set({ byAccount, unreadCounts, favorites });
    } finally {
      set({ isLoading: false });
    }
    get().ensureDefaultSelection();
  },

  ensureDefaultSelection: () => {
    const current = get().selected;
    if (current) {
      const stillExists =
        get().byAccount[current.accountId]?.some((f) => f.id === current.labelId) ?? false;
      if (stillExists) return;
    }

    const byAccount = get().byAccount;
    const activeId =
      useAccountStore.getState().activeAccountId ?? Object.keys(byAccount)[0] ?? null;
    if (!activeId) {
      set({ selected: null });
      return;
    }
    const folders = byAccount[activeId] ?? [];
    const inbox = folders.find((f) => f.role === 'inbox') ?? folders[0] ?? null;
    set({ selected: inbox ? { accountId: activeId, labelId: inbox.id } : null });
  },

  selectLabel: (accountId, labelId) => set({ selected: { accountId, labelId } }),

  toggleFavorite: async (accountId, labelId) => {
    const key = favKey(accountId, labelId);
    const next = new Set(get().favorites);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    set({ favorites: next });
    const pairs: Array<[string, string]> = [];
    for (const combined of next) {
      const sep = combined.indexOf('__');
      if (sep > 0) pairs.push([combined.slice(0, sep), combined.slice(sep + 2)]);
    }
    await saveFavoritePairs(pairs);
  },

  getUnread: (accountId, labelId) => get().unreadCounts[favKey(accountId, labelId)] ?? 0,

  isFavorite: (accountId, labelId) => get().favorites.has(favKey(accountId, labelId)),

  getFavoriteFolders: () => {
    const { byAccount, favorites } = get();
    const out: MailFolder[] = [];
    for (const folders of Object.values(byAccount)) {
      for (const f of folders) {
        if (favorites.has(favKey(f.accountId, f.id))) out.push(f);
      }
    }
    return out;
  },

  createFolder: async (accountId, name, parentId) => {
    const folder = await createFolderRow(accountId, name, { parentId: parentId ?? null });
    set((s) => ({
      byAccount: { ...s.byAccount, [accountId]: [...(s.byAccount[accountId] ?? []), folder] },
    }));
    useToastStore.getState().push('Folder created', 'success');
  },

  renameFolder: async (accountId, labelId, name) => {
    await renameFolderRow(accountId, labelId, name);
    set((s) => ({
      byAccount: patchAccount(s.byAccount, accountId, (fs) =>
        fs.map((f) => (f.id === labelId ? { ...f, name } : f)),
      ),
    }));
    useToastStore.getState().push('Folder renamed', 'success');
  },

  deleteFolder: async (accountId, labelId) => {
    await deleteFolderRow(accountId, labelId);
    const key = favKey(accountId, labelId);
    set((s) => {
      const unreadCounts = { ...s.unreadCounts };
      delete unreadCounts[key];
      return {
        byAccount: patchAccount(s.byAccount, accountId, (fs) => fs.filter((f) => f.id !== labelId)),
        unreadCounts,
      };
    });
    useToastStore.getState().push('Folder deleted', 'success');
  },

  decrementUnread: (accountId, labelId) => {
    const key = favKey(accountId, labelId);
    const cur = get().unreadCounts[key];
    if (cur && cur > 0) {
      set((s) => ({ unreadCounts: { ...s.unreadCounts, [key]: cur - 1 } }));
    }
  },

  incrementUnread: (accountId, labelId) => {
    const key = favKey(accountId, labelId);
    const cur = get().unreadCounts[key] ?? 0;
    set((s) => ({ unreadCounts: { ...s.unreadCounts, [key]: cur + 1 } }));
  },

  syncFolder: async (folder) => {
    const toast = useToastStore.getState();
    if (folder.source === 'local') {
      toast.push('Local folders have nothing to sync');
      return;
    }
    const account = useAccountStore.getState().accounts.find((a) => a.id === folder.accountId);
    if (!account) {
      toast.push('Account not found', 'error');
      return;
    }
    let provider: MailProvider;
    if (account.provider === 'eas') provider = new EasProvider(account);
    else if (account.provider === 'imap') provider = new ImapProvider(account);
    else {
      toast.push('Sync is not supported for this account type', 'error');
      return;
    }
    // Message persistence isn't wired yet, so this fetches from the server and
    // reports counts without populating the message list. See plan §Context.
    try {
      const result = await provider.syncFolder(folder.remoteId);
      toast.push(
        `Synced "${folder.name}": +${result.added} new, ${result.updated} updated, ${result.deleted} removed`,
      );
      await get().loadLabels();
      // Refresh the open message list so newly-synced threads appear. Uses
      // deferred getState() to avoid a top-level circular import with threadStore.
      useThreadStore
        .getState()
        .refresh()
        .catch(() => {});
    } catch (e) {
      toast.push(`Sync failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  },
}));

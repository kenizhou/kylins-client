// Persistence boundary for the unified folder/label store.
//
// Task 5 (Option C) cutover: this module no longer touches plugin-sql. Every
// function delegates to a Rust `db_*` Tauri command (see
// `kylins.client.backend/src/db/commands.rs`). Rust owns the `labels` table
// and returns ready camelCase `MailFolder` objects, so the snake→camel
// `rowToFolder` mapping is gone. The client-side `sortFolders` is preserved
// because Rust deliberately returns folders in unspecified order and the TS
// contract has always applied the `roleOrderIndex` sort rule.

import { invoke } from '@tauri-apps/api/core';
import type { FolderRole, MailFolder } from '../mail/folders';
import { roleOrderIndex } from '../mail/folders';

/** Order: system folders by canonical role, then user folders by sort/name. */
function sortFolders(folders: MailFolder[]): MailFolder[] {
  return [...folders].sort(
    (a, b) =>
      roleOrderIndex(a.role) - roleOrderIndex(b.role) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name),
  );
}

/** All mail folders for one account, system-first then user, ready to render. */
export async function getFoldersByAccount(accountId: string): Promise<MailFolder[]> {
  const folders = await invoke<MailFolder[]>('db_get_folders_by_account', { accountId });
  return sortFolders(folders);
}

/** All mail folders across all accounts, grouped-flat (caller groups by account). */
export async function getAllFolders(): Promise<MailFolder[]> {
  // Rust returns unspecified order; getAllFolders historically did not sort
  // (only getFoldersByAccount did). Preserve that.
  return invoke<MailFolder[]>('db_get_all_folders');
}

/** Find a special folder by canonical role for an account (e.g. the Inbox). */
export async function getFolderByRole(
  accountId: string,
  role: FolderRole,
): Promise<MailFolder | null> {
  return invoke<MailFolder | null>('db_get_folder_by_role', { accountId, role });
}

/**
 * Unread thread counts per label for an account. Rust returns the map as a
 * JSON object matching the TS `Record<string, number>` shape.
 */
export async function getUnreadCountsByAccount(accountId: string): Promise<Record<string, number>> {
  return invoke<Record<string, number>>('db_get_unread_counts_by_account', { accountId });
}

/**
 * Persist canonical folders (from any source adapter) into the labels table.
 * Deterministic ids mean re-syncs upsert in place. Counts are intentionally NOT
 * overwritten on conflict — they're maintained by message sync / live queries.
 */
export async function upsertFolders(folders: MailFolder[]): Promise<void> {
  if (folders.length === 0) return;
  await invoke<void>('db_upsert_folders', { folders });
}

/**
 * Create a local (app-only) user folder. Server round-trip (EAS/IMAP
 * CREATE/RENAME/DELETE) is deferred — these rows are source='local'. The
 * returned folder is built Rust-side and merged straight into the store.
 */
export async function createFolder(
  accountId: string,
  name: string,
  opts: { parentId?: string | null } = {},
): Promise<MailFolder> {
  return invoke<MailFolder>('db_create_folder', {
    accountId,
    name,
    parentId: opts.parentId ?? null,
  });
}

/** Rename a user folder. (System folders are protected at the UI layer.) */
export async function renameFolder(
  accountId: string,
  labelId: string,
  newName: string,
): Promise<void> {
  await invoke<void>('db_rename_folder', { accountId, labelId, newName });
}

/**
 * Delete a folder. `thread_labels` has no FK to `labels`; Rust removes its
 * rows + the label row atomically in one transaction. Child folders are left
 * in place — they resurface as top-level in the tree once their parent is gone.
 */
export async function deleteFolder(accountId: string, labelId: string): Promise<void> {
  await invoke<void>('db_delete_folder', { accountId, labelId });
}

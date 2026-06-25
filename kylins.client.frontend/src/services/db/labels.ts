// Persistence boundary for the unified folder/label store. The `labels` table
// holds folders from every source (IMAP, Gmail, ActiveSync, Graph, local);
// this module maps those rows to/from the canonical MailFolder so the rest of
// the app never touches SQL or provider-specific columns directly.

import { getDb, withTransaction } from './connection';
import type { FolderRole, FolderSource, MailFolder, MailFolderClass } from '../mail/folders';
import { roleOrderIndex } from '../mail/folders';

export interface DbLabelRow {
  id: string;
  account_id: string;
  name: string;
  type: string;
  color_bg?: string | null;
  color_fg?: string | null;
  visible: number;
  sort_order: number;
  imap_folder_path?: string | null;
  imap_special_use?: string | null;
  source?: string | null;
  role?: string | null;
  parent_id?: string | null;
  remote_id?: string | null;
  delimiter?: string | null;
  mail_class?: string | null;
  unread_count?: number | null;
  total_count?: number | null;
  hierarchical_name?: string | null;
}

function rowToFolder(row: DbLabelRow): MailFolder {
  return {
    id: row.id,
    accountId: row.account_id,
    source: (row.source ?? 'local') as FolderSource,
    role: (row.role ?? null) as FolderRole | null,
    name: row.name,
    parentId: row.parent_id ?? null,
    remoteId: row.remote_id ?? row.id,
    delimiter: row.delimiter ?? null,
    unreadCount: row.unread_count ?? 0,
    totalCount: row.total_count ?? 0,
    sortOrder: row.sort_order ?? 0,
    visible: (row.visible ?? 1) === 1,
    hierarchicalName: row.hierarchical_name ?? null,
    mailClass: (row.mail_class ?? 'mail') as MailFolderClass,
  };
}

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
  const db = await getDb();
  const rows = await db.select<DbLabelRow[]>(
    `SELECT * FROM labels
     WHERE account_id = $1 AND mail_class = 'mail' AND visible = 1`,
    [accountId],
  );
  return sortFolders(rows.map(rowToFolder));
}

/** All mail folders across all accounts, grouped-flat (caller groups by account). */
export async function getAllFolders(): Promise<MailFolder[]> {
  const db = await getDb();
  const rows = await db.select<DbLabelRow[]>(
    `SELECT * FROM labels WHERE mail_class = 'mail' AND visible = 1`,
  );
  return rows.map(rowToFolder);
}

/** Find a special folder by canonical role for an account (e.g. the Inbox). */
export async function getFolderByRole(
  accountId: string,
  role: FolderRole,
): Promise<MailFolder | null> {
  const db = await getDb();
  const rows = await db.select<DbLabelRow[]>(
    `SELECT * FROM labels
     WHERE account_id = $1 AND role = $2 AND mail_class = 'mail'
     LIMIT 1`,
    [accountId, role],
  );
  return rows[0] ? rowToFolder(rows[0]) : null;
}

/**
 * Unread thread counts per label for an account, computed live from
 * thread_labels × threads. Accurate for all locally-synced data today; Graph
 * and EAS sync may additionally cache counts on the labels row.
 */
export async function getUnreadCountsByAccount(accountId: string): Promise<Record<string, number>> {
  const db = await getDb();
  const rows = await db.select<{ id: string; unread: number }[]>(
    `SELECT tl.label_id AS id, COUNT(*) AS unread
     FROM thread_labels tl
     JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
     WHERE tl.account_id = $1 AND t.is_read = 0
     GROUP BY tl.label_id`,
    [accountId],
  );
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.id] = r.unread;
  }
  return out;
}

/**
 * Persist canonical folders (from any source adapter) into the labels table.
 * Deterministic ids mean re-syncs upsert in place. Counts are intentionally NOT
 * overwritten on conflict — they're maintained by message sync / live queries.
 */
export async function upsertFolders(folders: MailFolder[]): Promise<void> {
  if (folders.length === 0) return;
  await withTransaction(async (db) => {
    for (const f of folders) {
      await db.execute(
        `INSERT INTO labels (
           id, account_id, name, type, visible, sort_order,
           source, role, parent_id, remote_id, delimiter, mail_class, hierarchical_name
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT(account_id, id) DO UPDATE SET
           name = excluded.name,
           type = excluded.type,
           visible = excluded.visible,
           sort_order = excluded.sort_order,
           source = excluded.source,
           role = excluded.role,
           parent_id = excluded.parent_id,
           remote_id = excluded.remote_id,
           delimiter = excluded.delimiter,
           mail_class = excluded.mail_class,
           hierarchical_name = excluded.hierarchical_name`,
        [
          f.id,
          f.accountId,
          f.name,
          f.role ? 'system' : 'user',
          f.visible ? 1 : 0,
          f.sortOrder,
          f.source,
          f.role,
          f.parentId,
          f.remoteId,
          f.delimiter,
          f.mailClass,
          f.hierarchicalName,
        ],
      );
    }
  });
}

/**
 * Create a local (app-only) user folder. Server round-trip (EAS/IMAP
 * CREATE/RENAME/DELETE) is deferred — these rows are source='local'. The
 * returned folder can be merged straight into the store without a reload.
 */
export async function createFolder(
  accountId: string,
  name: string,
  opts: { parentId?: string | null } = {},
): Promise<MailFolder> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const remoteId = id;
  const parentId = opts.parentId ?? null;
  // Append after the account's current max sort_order so new folders land last.
  const max = await db.select<{ m: number | null }[]>(
    'SELECT MAX(sort_order) AS m FROM labels WHERE account_id = $1',
    [accountId],
  );
  const sortOrder = (max[0]?.m ?? -1) + 1;
  await db.execute(
    `INSERT INTO labels (
       id, account_id, name, type, visible, sort_order,
       source, role, parent_id, remote_id, mail_class
     ) VALUES ($1, $2, $3, 'user', 1, $4, 'local', NULL, $5, $6, 'mail')`,
    [id, accountId, name, sortOrder, parentId, remoteId],
  );
  return {
    id,
    accountId,
    source: 'local',
    role: null,
    name,
    parentId,
    remoteId,
    delimiter: null,
    unreadCount: 0,
    totalCount: 0,
    sortOrder,
    visible: true,
    hierarchicalName: null,
    mailClass: 'mail',
  };
}

/** Rename a user folder. (System folders are protected at the UI layer.) */
export async function renameFolder(
  accountId: string,
  labelId: string,
  newName: string,
): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE labels SET name = $3 WHERE account_id = $1 AND id = $2', [
    accountId,
    labelId,
    newName,
  ]);
}

/**
 * Delete a folder. `thread_labels` has no FK to `labels`, so its rows are
 * removed explicitly to avoid orphans. Child folders are left in place — they
 * resurface as top-level in the tree once their parent is gone.
 */
export async function deleteFolder(accountId: string, labelId: string): Promise<void> {
  await withTransaction(async (db) => {
    await db.execute('DELETE FROM thread_labels WHERE account_id = $1 AND label_id = $2', [
      accountId,
      labelId,
    ]);
    await db.execute('DELETE FROM labels WHERE account_id = $1 AND id = $2', [accountId, labelId]);
  });
}

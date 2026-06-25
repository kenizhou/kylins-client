// Thread list + per-thread message loading for the message list / reading pane.
// The list query is body-free (sender comes from a latest-message LEFT JOIN) and
// uses keyset (cursor) pagination on (last_message_at, id) so deep pages stay
// fast regardless of folder size. Bodies are NOT loaded here — see
// messageBodies.ts + getMessagesForThread (metadata only).

import { getDb, withTransaction } from './connection';
import type { MailMessage } from '../../features/view/viewStore';

export interface Thread {
  id: string;
  accountId: string;
  subject: string | null;
  snippet: string | null;
  lastMessageAt: number | null;
  messageCount: number;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  hasAttachments: boolean;
  isSnoozed: boolean;
  fromName: string | null;
  fromAddress: string | null;
}

export interface ThreadCursor {
  date: number;
  id: string;
}

export interface GetThreadsOptions {
  /** Label/folder id. Every folder is a label in our model. */
  labelId?: string | null;
  limit?: number;
  /** Cursor from a previous page's nextCursor (keyset pagination). */
  cursor?: ThreadCursor | null;
}

interface DbThreadRow {
  id: string;
  account_id: string;
  subject: string | null;
  snippet: string | null;
  last_message_at: number | null;
  message_count: number;
  is_read: number;
  is_starred: number;
  is_important: number;
  has_attachments: number;
  is_snoozed: number;
  from_name: string | null;
  from_address: string | null;
}

function mapThread(r: DbThreadRow): Thread {
  return {
    id: r.id,
    accountId: r.account_id,
    subject: r.subject,
    snippet: r.snippet,
    lastMessageAt: r.last_message_at,
    messageCount: r.message_count,
    isRead: r.is_read === 1,
    isStarred: r.is_starred === 1,
    isImportant: r.is_important === 1,
    hasAttachments: r.has_attachments === 1,
    isSnoozed: r.is_snoozed === 1,
    fromName: r.from_name,
    fromAddress: r.from_address,
  };
}

/**
 * Load one page of threads for an account, optionally filtered to a label/folder.
 * Returns the page plus a cursor for the next page (null when the page was short).
 */
export async function getThreads(
  accountId: string,
  opts: GetThreadsOptions = {},
): Promise<{ threads: Thread[]; nextCursor: ThreadCursor | null }> {
  const db = await getDb();
  const limit = opts.limit ?? 50;

  const joins: string[] = [];
  const where: string[] = ['t.account_id = $1'];
  const params: unknown[] = [accountId];
  let p = 2;

  if (opts.labelId) {
    joins.push(
      `INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id AND tl.label_id = $${p}`,
    );
    params.push(opts.labelId);
    p += 1;
  }
  if (opts.cursor) {
    // Portable cursor form (no SQLite row-value syntax): strictly less than the
    // (date, id) tuple of the last row on the previous page.
    where.push(`(t.last_message_at < $${p} OR (t.last_message_at = $${p} AND t.id < $${p + 1}))`);
    params.push(opts.cursor.date, opts.cursor.id);
    p += 2;
  }

  params.push(limit);
  const sql = `
    SELECT t.id, t.account_id, t.subject, t.snippet, t.last_message_at, t.message_count,
           t.is_read, t.is_starred, t.is_important, t.has_attachments, t.is_snoozed,
           m.from_name, m.from_address
    FROM threads t
    ${joins.join('\n    ')}
    LEFT JOIN messages m
      ON m.account_id = t.account_id AND m.thread_id = t.id
     AND m.date = (SELECT MAX(m2.date) FROM messages m2
                   WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
    WHERE ${where.join(' AND ')}
    ORDER BY t.last_message_at DESC, t.id DESC
    LIMIT $${p}
  `;
  const rows = await db.select<DbThreadRow[]>(sql, params);
  const threads = rows.map(mapThread);
  const last = rows[rows.length - 1];
  const nextCursor: ThreadCursor | null =
    rows.length === limit && last ? { date: last.last_message_at ?? 0, id: last.id } : null;
  return { threads, nextCursor };
}

export interface DbMessageRow {
  id: string;
  account_id: string;
  thread_id: string;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses?: string | null;
  reply_to?: string | null;
  subject: string | null;
  snippet: string | null;
  date: number;
  is_read: number;
  is_starred: number;
  body_text: string | null;
  body_cached?: number;
  message_id_header?: string | null;
  in_reply_to_header?: string | null;
}

/** Load a thread's message metadata (no body_html) ordered oldest→newest. */
export async function getMessagesForThread(
  accountId: string,
  threadId: string,
): Promise<DbMessageRow[]> {
  const db = await getDb();
  return db.select<DbMessageRow[]>(
    'SELECT * FROM messages WHERE account_id = $1 AND thread_id = $2 ORDER BY date ASC',
    [accountId, threadId],
  );
}

/** Mark every message in a thread (and the thread row) as read, atomically. */
export async function markThreadRead(accountId: string, threadId: string): Promise<void> {
  await withTransaction(async (db) => {
    await db.execute('UPDATE threads SET is_read = 1 WHERE account_id = $1 AND id = $2', [
      accountId,
      threadId,
    ]);
    await db.execute('UPDATE messages SET is_read = 1 WHERE account_id = $1 AND thread_id = $2', [
      accountId,
      threadId,
    ]);
  });
}

/** Parse a comma-separated address list ("Name <a@x>, b@y") into structured rows. */
export function parseAddresses(
  raw: string | null | undefined,
): { name: string; address: string }[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
      if (m) {
        const name = (m[1] ?? '').trim();
        const address = (m[2] ?? s).trim();
        return { name: name || address, address };
      }
      return { name: s, address: s };
    });
}

/** Map a DB message row (+ lazily-fetched HTML body) to the app's MailMessage. */
export function mapMessageToMailMessage(
  msg: DbMessageRow,
  bodyHtml: string | null = null,
): MailMessage {
  const fromName = msg.from_name ?? msg.from_address ?? 'Unknown';
  return {
    id: msg.id,
    subject: msg.subject ?? '(no subject)',
    from: { name: fromName, address: msg.from_address ?? fromName },
    to: parseAddresses(msg.to_addresses),
    cc: parseAddresses(msg.cc_addresses),
    date: new Date((msg.date ?? 0) * 1000).toISOString(),
    preview: msg.snippet ?? '',
    html: bodyHtml,
    text: msg.body_text ?? null,
    threadId: msg.thread_id,
    messageId: msg.message_id_header ?? undefined,
  };
}

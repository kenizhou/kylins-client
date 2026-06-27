// Thread list + per-thread message loading for the message list / reading pane.
// The list query is body-free (sender comes from a latest-message LEFT JOIN) and
// uses keyset (cursor) pagination on (last_message_at, id) so deep pages stay
// fast regardless of folder size. Bodies are NOT loaded here — see
// messageBodies.ts + getMessagesForThread (metadata only).

import { getDb, withTransaction } from './connection';
import type { ImapMessage } from '../../types';
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
  classificationId: string | null;
  isEncrypted: boolean;
  isSigned: boolean;
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
  classification_id: string | null;
  is_encrypted: number;
  is_signed: number;
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
    classificationId: r.classification_id ?? null,
    isEncrypted: r.is_encrypted === 1,
    isSigned: r.is_signed === 1,
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
           t.classification_id, t.is_encrypted, t.is_signed,
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
  classification_id: string | null;
  is_encrypted: number;
  is_signed: number;
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

/** Persist a batch of IMAP/EAS messages into threads, messages, thread_labels,
 *  and message_bodies. Minimal grouping: one thread per message (stable id from
 *  Message-ID header). Re-syncs upsert in place.
 *
 *  TODO: group related messages into real conversation threads by References/In-Reply-To. */
export async function upsertImapMessages(
  accountId: string,
  labelId: string,
  messages: ImapMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  await withTransaction(async (tx) => {
    for (const m of messages) {
      const messageId = m.message_id ?? crypto.randomUUID();
      const threadId = messageId;
      const hasAttachments = m.attachments && m.attachments.length > 0 ? 1 : 0;
      const now = Math.floor(Date.now() / 1000);

      await tx.execute(
        `INSERT INTO threads (
          id, account_id, subject, snippet, last_message_at, message_count,
          is_read, is_starred, is_important, has_attachments, is_snoozed,
          from_name, from_address, classification_id, is_encrypted, is_signed
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT(account_id, id) DO UPDATE SET
          subject = excluded.subject,
          snippet = excluded.snippet,
          last_message_at = excluded.last_message_at,
          message_count = excluded.message_count,
          is_read = excluded.is_read,
          is_starred = excluded.is_starred,
          is_important = excluded.is_important,
          has_attachments = excluded.has_attachments,
          from_name = excluded.from_name,
          from_address = excluded.from_address`,
        [
          threadId,
          accountId,
          m.subject ?? null,
          m.snippet ?? null,
          m.date,
          1,
          m.is_read ? 1 : 0,
          m.is_starred ? 1 : 0,
          0,
          hasAttachments,
          0,
          m.from_name ?? null,
          m.from_address ?? null,
          null,
          0,
          0,
        ],
      );

      await tx.execute(
        `INSERT INTO messages (
          id, account_id, thread_id, from_address, from_name, to_addresses, cc_addresses,
          bcc_addresses, reply_to, subject, snippet, date, is_read, is_starred,
          body_text, body_cached, raw_size, message_id_header, in_reply_to_header,
          references_header, list_unsubscribe, list_unsubscribe_post, auth_results
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
        ON CONFLICT(account_id, id) DO UPDATE SET
          from_address = excluded.from_address,
          from_name = excluded.from_name,
          to_addresses = excluded.to_addresses,
          cc_addresses = excluded.cc_addresses,
          bcc_addresses = excluded.bcc_addresses,
          reply_to = excluded.reply_to,
          subject = excluded.subject,
          snippet = excluded.snippet,
          date = excluded.date,
          is_read = excluded.is_read,
          is_starred = excluded.is_starred,
          body_text = excluded.body_text,
          raw_size = excluded.raw_size`,
        [
          messageId,
          accountId,
          threadId,
          m.from_address ?? null,
          m.from_name ?? null,
          m.to_addresses ?? null,
          m.cc_addresses ?? null,
          m.bcc_addresses ?? null,
          m.reply_to ?? null,
          m.subject ?? null,
          m.snippet ?? null,
          m.date,
          m.is_read ? 1 : 0,
          m.is_starred ? 1 : 0,
          m.body_text ?? null,
          m.body_html ? 1 : 0,
          m.raw_size,
          m.message_id ?? null,
          m.in_reply_to ?? null,
          m.references ?? null,
          m.list_unsubscribe ?? null,
          m.list_unsubscribe_post ?? null,
          m.auth_results ?? null,
        ],
      );

      await tx.execute(
        `INSERT INTO thread_labels (thread_id, account_id, label_id)
         VALUES ($1, $2, $3)
         ON CONFLICT(account_id, thread_id, label_id) DO NOTHING`,
        [threadId, accountId, labelId],
      );

      if (m.body_html) {
        await tx.execute(
          `INSERT OR REPLACE INTO message_bodies (account_id, message_id, body_html, fetched_at)
           VALUES ($1, $2, $3, $4)`,
          [accountId, messageId, m.body_html, now],
        );
      }
    }
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
    classificationId: msg.classification_id ?? null,
    isEncrypted: msg.is_encrypted === 1,
    isSigned: msg.is_signed === 1,
  };
}

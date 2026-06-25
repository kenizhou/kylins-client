// Separate HTML body store (migration v34). The bulky rendered HTML lives here,
// fetched lazily when a message is opened; messages keeps only body_text (for
// FTS + the reading-pane text fallback). bodies can be evicted to reclaim space
// and re-fetched on demand via setMessageBody.

import { getDb, withTransaction } from './connection';

export interface MessageBody {
  accountId: string;
  messageId: string;
  bodyHtml: string | null;
  fetchedAt: number | null;
}

export async function getMessageBody(
  accountId: string,
  messageId: string,
): Promise<MessageBody | null> {
  const db = await getDb();
  const rows = await db.select<{ body_html: string | null; fetched_at: number | null }[]>(
    'SELECT body_html, fetched_at FROM message_bodies WHERE account_id = $1 AND message_id = $2',
    [accountId, messageId],
  );
  const r = rows[0];
  return r ? { accountId, messageId, bodyHtml: r.body_html, fetchedAt: r.fetched_at } : null;
}

/** Store/refresh a body and mark the message as body-cached (atomic). */
export async function setMessageBody(
  accountId: string,
  messageId: string,
  bodyHtml: string,
): Promise<void> {
  await withTransaction(async (db) => {
    await db.execute(
      `INSERT OR REPLACE INTO message_bodies (account_id, message_id, body_html, fetched_at)
       VALUES ($1, $2, $3, unixepoch())`,
      [accountId, messageId, bodyHtml],
    );
    await db.execute('UPDATE messages SET body_cached = 1 WHERE account_id = $1 AND id = $2', [
      accountId,
      messageId,
    ]);
  });
}

/** Drop a body to reclaim space (re-fetched on next open); atomic. */
export async function evictBody(accountId: string, messageId: string): Promise<void> {
  await withTransaction(async (db) => {
    await db.execute('DELETE FROM message_bodies WHERE account_id = $1 AND message_id = $2', [
      accountId,
      messageId,
    ]);
    await db.execute('UPDATE messages SET body_cached = 0 WHERE account_id = $1 AND id = $2', [
      accountId,
      messageId,
    ]);
  });
}

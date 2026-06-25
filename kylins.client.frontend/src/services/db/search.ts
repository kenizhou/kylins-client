// Full-text search over the existing messages_fts (external-content FTS5,
// trigram tokenizer, migration v2). Returns ranked matches with a highlighted
// snippet from body_text. A richer query parser (from:/is:/since:) and a search
// box UI are follow-ups; this is the data layer.

import { getDb } from './connection';

export interface MessageSearchResult {
  id: string;
  threadId: string;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  date: number;
  /** Highlighted snippet with <mark>…</mark> around matching terms. */
  preview: string;
  rank: number;
}

interface DbSearchRow {
  id: string;
  thread_id: string;
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  date: number;
  preview: string | null;
  rank: number;
}

/** Search an account's messages; empty query returns no rows. */
export async function searchMessages(
  accountId: string,
  query: string,
  limit = 50,
): Promise<MessageSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const db = await getDb();
  const rows = await db.select<DbSearchRow[]>(
    `SELECT m.id AS id, m.thread_id AS thread_id, m.subject AS subject,
            m.from_name AS from_name, m.from_address AS from_address, m.date AS date,
            snippet(messages_fts, 3, '<mark>', '</mark>', '…', 16) AS preview,
            rank AS rank
     FROM messages_fts
     JOIN messages m ON m.rowid = messages_fts.rowid
     WHERE messages_fts MATCH $1 AND m.account_id = $2
     ORDER BY rank
     LIMIT $3`,
    [trimmed, accountId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    threadId: r.thread_id,
    subject: r.subject,
    fromName: r.from_name,
    fromAddress: r.from_address,
    date: r.date,
    preview: r.preview ?? '',
    rank: r.rank,
  }));
}

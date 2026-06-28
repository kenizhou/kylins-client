// Full-text search over the existing messages_fts (external-content FTS5,
// trigram tokenizer, migration v2). Returns ranked matches with a highlighted
// snippet from body_text. A richer query parser (from:/is:/since:) and a search
// box UI are follow-ups; this is the data layer.
//
// Task 5 (Option C) clean-cut cutover: delegates to Rust
// `db_search_messages` (see `kylins.client.backend/src/db/search.rs`). The FTS5
// MATCH + snippet + rank SQL is reproduced verbatim in Rust so results match
// the historical behavior byte-for-byte.

import { invoke } from '@tauri-apps/api/core';

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

/** Search an account's messages; empty query returns no rows. */
export async function searchMessages(
  accountId: string,
  query: string,
  limit = 50,
): Promise<MessageSearchResult[]> {
  // Empty-query guard stays TS-side (matches the historical early return);
  // avoids a pointless IPC round-trip and a Rust no-op.
  const trimmed = query.trim();
  if (!trimmed) return [];
  return invoke<MessageSearchResult[]>('db_search_messages', { accountId, query, limit });
}

// Per-message query helpers exposed to the frontend. Mirrors the
// `db::messages` Rust module (query layer) + the `db_*` Tauri commands in
// `db::commands`. Kept separate from `messageBodies.ts` (the body-row store)
// because `messages` is the envelope table and the two have different shapes.
//
// Currently the only consumer is the viewport body-prefetch hook
// (`hooks/useViewportBodyPrefetch`), which uses `getUncachedBodyMessageIds`
// to filter the visible+buffer candidate list so it only requests bodies the
// cache is missing.

import { invoke } from '@tauri-apps/api/core';

/**
 * Return the subset of `messageIds` whose body is NOT cached
 * (`body_cached = 0`). The prefetch hook uses this to avoid re-requesting
 * bodies the cache already has. Missing ids are silently dropped.
 */
export function getUncachedBodyMessageIds(
  accountId: string,
  messageIds: string[],
): Promise<string[]> {
  return invoke<string[]>('db_get_uncached_body_message_ids', {
    accountId,
    messageIds,
  });
}

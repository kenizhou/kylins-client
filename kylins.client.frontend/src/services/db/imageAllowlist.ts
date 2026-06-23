// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Per-sender remote-image allowlist over the `image_allowlist` table. A sender
// on the allowlist has its remote images loaded automatically (trackers are
// still stripped — see utils/imageBlocker).

import { getDb, selectFirstBy } from '@/services/db/connection';
import { normalizeEmail } from '@/utils/emailUtils';

export async function addToAllowlist(accountId: string, senderAddress: string): Promise<void> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.execute(
    'INSERT OR IGNORE INTO image_allowlist (id, account_id, sender_address) VALUES ($1, $2, $3)',
    [id, accountId, normalizeEmail(senderAddress)],
  );
}

export async function isAllowlisted(accountId: string, senderAddress: string): Promise<boolean> {
  const row = await selectFirstBy<{ id: string }>(
    'SELECT id FROM image_allowlist WHERE account_id = $1 AND sender_address = $2 LIMIT 1',
    [accountId, normalizeEmail(senderAddress)],
  );
  return row !== null;
}

export async function removeFromAllowlist(accountId: string, senderAddress: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM image_allowlist WHERE account_id = $1 AND sender_address = $2', [
    accountId,
    normalizeEmail(senderAddress),
  ]);
}

import { getDb } from './connection';

export interface ContactSyncState {
  accountId: string;
  source: string;
  syncToken: string | null;
  lastSyncAt: number | null;
}

export async function getContactSyncState(
  accountId: string,
  source: string,
): Promise<ContactSyncState | null> {
  const db = await getDb();
  const rows = await db.select<
    { account_id: string; source: string; sync_token: string | null; last_sync_at: number | null }[]
  >(
    'SELECT account_id, source, sync_token, last_sync_at FROM contact_sync_state WHERE account_id = $1 AND source = $2 LIMIT 1',
    [accountId, source],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    accountId: row.account_id,
    source: row.source,
    syncToken: row.sync_token,
    lastSyncAt: row.last_sync_at,
  };
}

export async function setContactSyncState(
  accountId: string,
  source: string,
  syncToken: string | null,
  lastSyncAt?: number,
): Promise<void> {
  const db = await getDb();
  const now = lastSyncAt ?? Math.floor(Date.now() / 1000);
  await db.execute(
    `INSERT INTO contact_sync_state (account_id, source, sync_token, last_sync_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(account_id, source) DO UPDATE SET
       sync_token = $3,
       last_sync_at = $4`,
    [accountId, source, syncToken, now],
  );
}

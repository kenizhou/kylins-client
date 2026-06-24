// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Send-as aliases over the `send_as_aliases` table (migration v7). An account
// can send from its own address plus any verified aliases (e.g. a shared
// mailbox or custom "From"). When the table has no rows for an account we
// synthesize one from the account itself so the From selector always works.

import { getDb } from './connection';
import type { Account } from '../../types';

export interface DbSendAsAlias {
  id: string;
  account_id: string;
  email: string;
  display_name: string | null;
  reply_to_address: string | null;
  signature_id: string | null;
  is_primary: number;
  is_default: number;
  treat_as_alias: number;
  verification_status: string;
  created_at: number;
}

export interface SendAsAlias {
  id: string;
  email: string;
  displayName: string | null;
  replyTo: string | null;
  signatureId: string | null;
  isPrimary: boolean;
  isDefault: boolean;
  verificationStatus: string;
}

export function mapDbAlias(row: DbSendAsAlias): SendAsAlias {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    replyTo: row.reply_to_address,
    signatureId: row.signature_id,
    isPrimary: row.is_primary === 1,
    isDefault: row.is_default === 1,
    verificationStatus: row.verification_status,
  };
}

export async function getAliasesForAccount(accountId: string): Promise<DbSendAsAlias[]> {
  const db = await getDb();
  return db.select<DbSendAsAlias[]>(
    'SELECT * FROM send_as_aliases WHERE account_id = $1 ORDER BY is_default DESC, is_primary DESC, created_at ASC',
    [accountId],
  );
}

/**
 * Synthesize a send-as identity for an account's own address. Used so the From
 * selector always has at least one entry even when the alias table is empty.
 */
export function accountAsAlias(account: Account): SendAsAlias {
  return {
    id: `account-${account.id}`,
    email: account.email,
    displayName: account.displayName ?? null,
    replyTo: null,
    signatureId: null,
    isPrimary: true,
    isDefault: true,
    verificationStatus: 'accepted',
  };
}

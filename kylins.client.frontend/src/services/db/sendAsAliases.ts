// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Send-as aliases over the `send_as_aliases` table (migration v7). An account
// can send from its own address plus any verified aliases (e.g. a shared
// mailbox or custom "From"). When the table has no rows for an account we
// synthesize one from the account itself so the From selector always works.

import { getDb, buildDynamicUpdate } from './connection';
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
  treatAsAlias: boolean;
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
    treatAsAlias: row.treat_as_alias === 1,
    verificationStatus: row.verification_status,
  };
}

export async function getMappedAliasesForAccount(accountId: string): Promise<SendAsAlias[]> {
  const rows = await getAliasesForAccount(accountId);
  return rows.map(mapDbAlias);
}

export interface CreateAliasInput {
  accountId: string;
  email: string;
  displayName?: string;
  replyTo?: string;
  isDefault?: boolean;
  treatAsAlias?: boolean;
}

export async function insertAlias(input: CreateAliasInput): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();

  if (input.isDefault) {
    await db.execute('UPDATE send_as_aliases SET is_default = 0 WHERE account_id = $1', [
      input.accountId,
    ]);
  }

  await db.execute(
    `INSERT INTO send_as_aliases (
      id, account_id, email, display_name, reply_to_address,
      is_primary, is_default, treat_as_alias, verification_status, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'accepted', $9)`,
    [
      id,
      input.accountId,
      input.email,
      input.displayName ?? null,
      input.replyTo ?? null,
      0,
      input.isDefault ? 1 : 0,
      input.treatAsAlias !== false ? 1 : 0,
      Math.floor(Date.now() / 1000),
    ],
  );
  return id;
}

export async function updateAlias(
  id: string,
  updates: Partial<Omit<CreateAliasInput, 'accountId' | 'email'>>,
): Promise<void> {
  const db = await getDb();

  if (updates.isDefault) {
    const rows = await db.select<{ account_id: string }[]>(
      'SELECT account_id FROM send_as_aliases WHERE id = $1',
      [id],
    );
    if (rows[0]) {
      await db.execute(
        'UPDATE send_as_aliases SET is_default = 0 WHERE account_id = $1',
        [rows[0].account_id],
      );
    }
  }

  const fields: [string, unknown][] = [];
  if (updates.displayName !== undefined) fields.push(['display_name', updates.displayName]);
  if (updates.replyTo !== undefined) fields.push(['reply_to_address', updates.replyTo]);
  if (updates.isDefault !== undefined) fields.push(['is_default', updates.isDefault ? 1 : 0]);
  if (updates.treatAsAlias !== undefined)
    fields.push(['treat_as_alias', updates.treatAsAlias ? 1 : 0]);

  const query = buildDynamicUpdate('send_as_aliases', 'id', id, fields);
  if (query) {
    await db.execute(query.sql, query.params);
  }
}

export async function deleteAlias(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM send_as_aliases WHERE id = $1', [id]);
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
    treatAsAlias: true,
    verificationStatus: 'accepted',
  };
}

// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Send-as aliases over the `send_as_aliases` table (migration v7). An account
// can send from its own address plus any verified aliases (e.g. a shared
// mailbox or custom "From"). When the table has no rows for an account we
// synthesize one from the account itself so the From selector always works.
//
// Task 5 (Option C) clean-cut cutover: every SQL function delegates to a Rust
// `db_*` Tauri command (see `kylins.client.backend/src/db/send_as_aliases.rs`).
// Rust returns raw snake_case `DbSendAsAlias` rows (matching the historical TS
// interface). The pure TS `mapDbAlias` + `accountAsAlias` helpers stay here —
// they have no SQL and are imported by the composer preferences UI.

import { invoke } from '@tauri-apps/api/core';
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
  return invoke<string>('db_insert_alias', {
    input: {
      accountId: input.accountId,
      email: input.email,
      displayName: input.displayName ?? null,
      replyTo: input.replyTo ?? null,
      isDefault: input.isDefault ?? null,
      treatAsAlias: input.treatAsAlias ?? null,
    },
  });
}

export async function updateAlias(
  id: string,
  updates: Partial<Omit<CreateAliasInput, 'accountId' | 'email'>>,
): Promise<void> {
  // Only forward keys that are actually set (matches historical buildDynamicUpdate).
  const payload: Record<string, unknown> = {};
  if (updates.displayName !== undefined) payload.displayName = updates.displayName;
  if (updates.replyTo !== undefined) payload.replyTo = updates.replyTo;
  if (updates.isDefault !== undefined) payload.isDefault = updates.isDefault;
  if (updates.treatAsAlias !== undefined) payload.treatAsAlias = updates.treatAsAlias;
  await invoke<void>('db_update_alias', { id, updates: payload });
}

export async function deleteAlias(id: string): Promise<void> {
  await invoke<void>('db_delete_alias', { id });
}

export async function getAliasesForAccount(accountId: string): Promise<DbSendAsAlias[]> {
  return invoke<DbSendAsAlias[]>('db_get_aliases_for_account', { accountId });
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

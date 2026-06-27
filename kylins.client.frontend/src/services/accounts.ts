// Ported from velo (https://github.com/aviyahmenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.
//
// Task 5 (Option C) cutover: this module no longer touches plugin-sql. Every
// function delegates to a Rust `db_*` Tauri command (see
// `kylins.client.backend/src/db/commands.rs`). Rust owns encryption of the
// four secret fields, so this module has no encrypt/decrypt calls — the
// returned `Account` already carries plaintext secrets. Crypto is still
// available for tangential modules via `services/crypto.ts`.
//
// The Rust `Account` DTO serializes to camelCase JSON that matches the TS
// `Account` interface field-for-field, so these wrappers are mechanical
// pass-throughs that preserve the original TS signatures.

import { invoke } from '@tauri-apps/api/core';
import type { Account, MailProvider, SecurityMode, AuthMethod } from '../types';

export interface CreateAccountInput {
  email: string;
  displayName?: string;
  accountLabel?: string;
  provider: MailProvider;
  setupProviderId?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  isActive?: boolean;
  isDefault?: boolean;
  sortOrder?: number;
  // IMAP
  imapHost?: string;
  imapPort?: number;
  imapSecurity?: SecurityMode;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: SecurityMode;
  authMethod?: AuthMethod;
  imapPassword?: string;
  imapUsername?: string;
  oauthProvider?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  acceptInvalidCerts?: boolean;
  // EAS
  easUrl?: string;
  easProtocolVersion?: string;
  easDeviceId?: string;
}

export type AccountUpdates = Partial<Omit<Account, 'id' | 'createdAt'>>;

export async function getAllAccounts(): Promise<Account[]> {
  return invoke<Account[]>('db_get_all_accounts');
}

export async function getAccountById(id: string): Promise<Account | null> {
  return invoke<Account | null>('db_get_account_by_id', { id });
}

export async function getAccountByEmail(email: string): Promise<Account | null> {
  return invoke<Account | null>('db_get_account_by_email', { email });
}

export async function createAccount(input: CreateAccountInput): Promise<Account> {
  // Signature seeding moved Rust-side (db::accounts::create inserts a default
  // signature row). No frontend insertSignature call here — see task-5 report.
  return invoke<Account>('db_create_account', { input });
}

export async function updateAccount(id: string, updates: AccountUpdates): Promise<void> {
  await invoke<void>('db_update_account', { id, updates });
}

export async function deleteAccount(id: string): Promise<void> {
  await invoke<void>('db_delete_account', { id });
}

export async function deleteAccountByEmail(email: string): Promise<void> {
  await invoke<void>('db_delete_account_by_email', { email });
}

export async function getAccountCount(): Promise<number> {
  return invoke<number>('db_get_account_count');
}

export async function setDefaultAccount(id: string): Promise<void> {
  await invoke<void>('db_set_default_account', { id });
}

export async function getDefaultAccount(): Promise<Account | null> {
  return invoke<Account | null>('db_get_default_account');
}

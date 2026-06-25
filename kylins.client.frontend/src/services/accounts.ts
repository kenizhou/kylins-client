// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

import { getDb, withTransaction } from './db/connection';
import { encryptSecret, decryptSecret } from './crypto';
import { insertSignature } from './db/signatures';
import type { Account, DbAccountRow, MailProvider, SecurityMode, AuthMethod } from '../types';

function generateId(): string {
  return crypto.randomUUID();
}

async function decryptField(value: string | null | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  return decryptSecret(value);
}

async function rowToAccount(row: DbAccountRow): Promise<Account> {
  // Decrypt the 4 secret fields concurrently; each is an independent IPC round-trip.
  const [accessToken, refreshToken, imapPassword, oauthClientSecret] = await Promise.all([
    decryptField(row.access_token),
    decryptField(row.refresh_token),
    decryptField(row.imap_password),
    decryptField(row.oauth_client_secret),
  ]);
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name ?? undefined,
    accountLabel: row.account_label ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    provider: row.provider as MailProvider,
    setupProviderId: row.setup_provider_id ?? undefined,
    accessToken,
    refreshToken,
    tokenExpiresAt: row.token_expires_at ?? undefined,
    historyId: row.history_id ?? undefined,
    lastSyncAt: row.last_sync_at ?? undefined,
    isActive: row.is_active === 1,
    isDefault: row.is_default === 1,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // IMAP/SMTP
    imapHost: row.imap_host ?? undefined,
    imapPort: row.imap_port ?? undefined,
    imapSecurity: (row.imap_security as SecurityMode) ?? undefined,
    smtpHost: row.smtp_host ?? undefined,
    smtpPort: row.smtp_port ?? undefined,
    smtpSecurity: (row.smtp_security as SecurityMode) ?? undefined,
    authMethod: (row.auth_method as AuthMethod) ?? undefined,
    imapPassword,
    imapUsername: row.imap_username ?? undefined,
    oauthProvider: row.oauth_provider ?? undefined,
    oauthClientId: row.oauth_client_id ?? undefined,
    oauthClientSecret,
    acceptInvalidCerts: row.accept_invalid_certs === 1,
    // EAS
    easUrl: row.eas_url ?? undefined,
    easProtocolVersion: row.eas_protocol_version ?? undefined,
    easDeviceId: row.eas_device_id ?? undefined,
    easPolicyKey: row.eas_policy_key ?? undefined,
    easUserAgent: row.eas_user_agent ?? undefined,
  };
}

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

export async function createAccount(input: CreateAccountInput): Promise<Account> {
  const db = await getDb();
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);

  // First account automatically becomes the default so "send from default account"
  // always resolves to something.
  const isDefault = input.isDefault ?? (await getAccountCount()) === 0;

  // Encrypt the 4 secret fields concurrently; each is an independent IPC round-trip.
  const [accessToken, refreshToken, imapPassword, oauthClientSecret] = await Promise.all([
    input.accessToken ? encryptSecret(input.accessToken) : Promise.resolve(null),
    input.refreshToken ? encryptSecret(input.refreshToken) : Promise.resolve(null),
    input.imapPassword ? encryptSecret(input.imapPassword) : Promise.resolve(null),
    input.oauthClientSecret ? encryptSecret(input.oauthClientSecret) : Promise.resolve(null),
  ]);

  await db.execute(
    `INSERT INTO accounts (
      id, email, display_name, account_label, provider, setup_provider_id,
      access_token, refresh_token, token_expires_at,
      is_active, is_default, sort_order, created_at, updated_at,
      imap_host, imap_port, imap_security,
      smtp_host, smtp_port, smtp_security,
      auth_method, imap_password, imap_username,
      oauth_provider, oauth_client_id, oauth_client_secret,
      accept_invalid_certs,
      eas_url, eas_protocol_version, eas_device_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)`,
    [
      id,
      input.email,
      input.displayName ?? null,
      input.accountLabel ?? null,
      input.provider,
      input.setupProviderId ?? null,
      accessToken,
      refreshToken,
      input.tokenExpiresAt ?? null,
      (input.isActive ?? true) ? 1 : 0,
      isDefault ? 1 : 0,
      input.sortOrder ?? 0,
      now,
      now,
      input.imapHost ?? null,
      input.imapPort ?? null,
      input.imapSecurity ?? null,
      input.smtpHost ?? null,
      input.smtpPort ?? null,
      input.smtpSecurity ?? null,
      input.authMethod ?? null,
      imapPassword,
      input.imapUsername ?? null,
      input.oauthProvider ?? null,
      input.oauthClientId ?? null,
      oauthClientSecret,
      input.acceptInvalidCerts ? 1 : 0,
      input.easUrl ?? null,
      input.easProtocolVersion ?? null,
      input.easDeviceId ?? null,
    ],
  );

  const created = await getAccountById(id);
  if (!created) throw new Error('Failed to read back created account');

  // Seed a default signature so the composer always has something to offer.
  try {
    await insertSignature({
      accountId: id,
      name: 'Default',
      bodyHtml: '<p>Sent from Kylins Mail</p>',
      isDefault: true,
      context: 'all',
    });
  } catch (e) {
    console.warn('Failed to seed default signature:', e);
  }

  return created;
}

export async function getAllAccounts(): Promise<Account[]> {
  const db = await getDb();
  const rows = await db.select<DbAccountRow[]>(
    'SELECT * FROM accounts ORDER BY created_at DESC',
    [],
  );
  // Use allSettled so a single corrupt row (e.g. undecryptable ciphertext, or a
  // locked keyring) does not brick startup by rejecting the whole list. Bad
  // rows are warned and skipped; only fulfilled accounts are returned.
  const results = await Promise.allSettled(rows.map((row) => rowToAccount(row)));
  const accounts: Account[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === 'fulfilled') {
      accounts.push(r.value);
    } else {
      const row = rows[i]!;
      console.warn(
        `[accounts] skipping corrupt row id=${row.id} email=${row.email ?? '<unknown>'}:`,
        r.reason,
      );
    }
  }
  return accounts;
}

export async function getAccountById(id: string): Promise<Account | null> {
  const db = await getDb();
  const rows = await db.select<DbAccountRow[]>('SELECT * FROM accounts WHERE id = $1', [id]);
  return rows[0] ? await rowToAccount(rows[0]) : null;
}

export type AccountUpdates = Partial<Omit<Account, 'id' | 'createdAt'>>;

export async function updateAccount(id: string, updates: AccountUpdates): Promise<void> {
  const db = await getDb();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  let idx = 1;

  const map: Array<
    [
      keyof AccountUpdates,
      string,
      (v: unknown) => Promise<string | number | null> | string | number | null,
    ]
  > = [
    ['email', 'email', (v) => v as string],
    ['displayName', 'display_name', (v) => v as string],
    ['accountLabel', 'account_label', (v) => v as string],
    ['provider', 'provider', (v) => v as string],
    ['setupProviderId', 'setup_provider_id', (v) => v as string],
    ['accessToken', 'access_token', (v) => encryptSecret(v as string)],
    ['refreshToken', 'refresh_token', (v) => encryptSecret(v as string)],
    ['tokenExpiresAt', 'token_expires_at', (v) => v as number],
    ['historyId', 'history_id', (v) => v as string],
    ['lastSyncAt', 'last_sync_at', (v) => v as number],
    ['isActive', 'is_active', (v) => (v ? 1 : 0)],
    ['isDefault', 'is_default', (v) => (v ? 1 : 0)],
    ['sortOrder', 'sort_order', (v) => v as number],
    ['imapHost', 'imap_host', (v) => v as string],
    ['imapPort', 'imap_port', (v) => v as number],
    ['imapSecurity', 'imap_security', (v) => v as string],
    ['smtpHost', 'smtp_host', (v) => v as string],
    ['smtpPort', 'smtp_port', (v) => v as number],
    ['smtpSecurity', 'smtp_security', (v) => v as string],
    ['authMethod', 'auth_method', (v) => v as string],
    ['imapPassword', 'imap_password', (v) => encryptSecret(v as string)],
    ['imapUsername', 'imap_username', (v) => v as string],
    ['oauthProvider', 'oauth_provider', (v) => v as string],
    ['oauthClientId', 'oauth_client_id', (v) => v as string],
    ['oauthClientSecret', 'oauth_client_secret', (v) => encryptSecret(v as string)],
    ['acceptInvalidCerts', 'accept_invalid_certs', (v) => (v ? 1 : 0)],
    ['easUrl', 'eas_url', (v) => v as string],
    ['easProtocolVersion', 'eas_protocol_version', (v) => v as string],
    ['easDeviceId', 'eas_device_id', (v) => v as string],
    ['easPolicyKey', 'eas_policy_key', (v) => v as string],
    ['easUserAgent', 'eas_user_agent', (v) => v as string],
  ];

  for (const [key, column, transform] of map) {
    const value = updates[key];
    if (value !== undefined) {
      fields.push(`${column} = $${idx++}`);
      values.push(await transform(value));
    }
  }

  fields.push(`updated_at = $${idx++}`);
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);

  await db.execute(`UPDATE accounts SET ${fields.join(', ')} WHERE id = $${idx}`, values);
}

export async function deleteAccount(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM accounts WHERE id = $1', [id]);
}

export async function getAccountCount(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>('SELECT COUNT(*) as count FROM accounts');
  return rows[0]?.count ?? 0;
}

export async function setDefaultAccount(id: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await withTransaction(async (tx) => {
    await tx.execute('UPDATE accounts SET is_default = 0', []);
    await tx.execute('UPDATE accounts SET is_default = 1, updated_at = $1 WHERE id = $2', [
      now,
      id,
    ]);
  });
}

export async function getDefaultAccount(): Promise<Account | null> {
  const db = await getDb();
  const rows = await db.select<DbAccountRow[]>('SELECT * FROM accounts WHERE is_default = 1 LIMIT 1', []);
  return rows[0] ? await rowToAccount(rows[0]) : null;
}

import { getDb } from './db/connection';
import type { Account, DbAccountRow } from '../types';

function generateId(): string {
  return crypto.randomUUID();
}

function rowToAccount(row: DbAccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name ?? undefined,
    provider: row.provider as Account['provider'],
    providerConfig: row.provider_config ? JSON.parse(row.provider_config) : undefined,
    accessToken: row.access_token ?? undefined,
    refreshToken: row.refresh_token ?? undefined,
    tokenExpiresAt: row.token_expires_at ?? undefined,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createAccount(
  input: Pick<Account, 'email' | 'provider'> & Partial<Account>,
): Promise<Account> {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const account: Account = {
    id: generateId(),
    email: input.email,
    displayName: input.displayName,
    provider: input.provider,
    providerConfig: input.providerConfig,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    tokenExpiresAt: input.tokenExpiresAt,
    isActive: input.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };

  await db.execute(
    `INSERT INTO accounts
      (id, email, display_name, provider, provider_config, access_token, refresh_token, token_expires_at, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      account.id,
      account.email,
      account.displayName ?? null,
      account.provider,
      account.providerConfig ? JSON.stringify(account.providerConfig) : null,
      account.accessToken ?? null,
      account.refreshToken ?? null,
      account.tokenExpiresAt ?? null,
      account.isActive ? 1 : 0,
      account.createdAt,
      account.updatedAt,
    ],
  );

  return account;
}

export async function getAllAccounts(): Promise<Account[]> {
  const db = await getDb();
  const rows = await db.select<DbAccountRow[]>('SELECT * FROM accounts ORDER BY created_at DESC', []);
  return rows.map(rowToAccount);
}

export async function getAccountById(id: string): Promise<Account | null> {
  const db = await getDb();
  const rows = await db.select<DbAccountRow[]>('SELECT * FROM accounts WHERE id = $1', [id]);
  return rows[0] ? rowToAccount(rows[0]) : null;
}

export async function updateAccount(
  id: string,
  updates: Partial<Omit<Account, 'id' | 'createdAt'>>,
): Promise<void> {
  const db = await getDb();
  const fields: string[] = [];
  const values: (string | number | boolean | null)[] = [];
  let idx = 1;

  if (updates.email !== undefined) fields.push(`email = $${idx++}`), values.push(updates.email);
  if (updates.displayName !== undefined) fields.push(`display_name = $${idx++}`), values.push(updates.displayName);
  if (updates.provider !== undefined) fields.push(`provider = $${idx++}`), values.push(updates.provider);
  if (updates.providerConfig !== undefined) fields.push(`provider_config = $${idx++}`), values.push(JSON.stringify(updates.providerConfig));
  if (updates.accessToken !== undefined) fields.push(`access_token = $${idx++}`), values.push(updates.accessToken);
  if (updates.refreshToken !== undefined) fields.push(`refresh_token = $${idx++}`), values.push(updates.refreshToken);
  if (updates.tokenExpiresAt !== undefined) fields.push(`token_expires_at = $${idx++}`), values.push(updates.tokenExpiresAt);
  if (updates.isActive !== undefined) fields.push(`is_active = $${idx++}`), values.push(updates.isActive ? 1 : 0);

  fields.push(`updated_at = $${idx++}`);
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);

  await db.execute(
    `UPDATE accounts SET ${fields.join(', ')} WHERE id = $${idx}`,
    values,
  );
}

export async function deleteAccount(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM accounts WHERE id = $1', [id]);
}

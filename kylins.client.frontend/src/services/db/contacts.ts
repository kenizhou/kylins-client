// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Contacts service. Supports rich local contacts, groups, and future sync
// sources (CardDAV, Google People, EAS). Email lookups are normalized.

import { getDb, buildDynamicUpdate, selectFirstBy } from './connection';
import { normalizeEmail } from '@/utils/emailUtils';
import { parseJsonField } from '@/utils/parseJson';

export interface DbContact {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  frequency: number;
  last_contacted_at: number | null;
  first_contacted_at: number | null;
  notes: string | null;
  account_id: string | null;
  source: string;
  external_id: string | null;
  etag: string | null;
  raw_vcard: string | null;
  is_hidden: number;
  is_readonly: number;
  company: string | null;
  job_title: string | null;
  emails_json: string;
  phone_numbers_json: string;
  addresses_json: string;
  created_at: number;
  updated_at: number;
}

export interface ContactEmail {
  label?: string;
  value: string;
  isPrimary?: boolean;
}

export interface ContactPhone {
  label?: string;
  value: string;
}

export interface ContactAddress {
  label?: string;
  formatted?: string;
  street?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export interface Contact {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  frequency: number;
  lastContactedAt: number | null;
  firstContactedAt: number | null;
  notes: string | null;
  accountId: string | null;
  source: string;
  externalId: string | null;
  etag: string | null;
  rawVCard: string | null;
  isHidden: boolean;
  isReadonly: boolean;
  company: string | null;
  jobTitle: string | null;
  emails: ContactEmail[];
  phones: ContactPhone[];
  addresses: ContactAddress[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateContactInput {
  email: string;
  displayName?: string | null;
  accountId?: string | null;
  source?: string;
  externalId?: string | null;
  etag?: string | null;
  rawVCard?: string | null;
  avatarUrl?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  emails?: ContactEmail[];
  phones?: ContactPhone[];
  addresses?: ContactAddress[];
  notes?: string | null;
}

export interface UpdateContactInput {
  displayName?: string | null;
  avatarUrl?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  emails?: ContactEmail[];
  phones?: ContactPhone[];
  addresses?: ContactAddress[];
  notes?: string | null;
  isHidden?: boolean;
  isReadonly?: boolean;
}

export function mapDbContact(row: DbContact): Contact {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    frequency: row.frequency,
    lastContactedAt: row.last_contacted_at,
    firstContactedAt: row.first_contacted_at,
    notes: row.notes,
    accountId: row.account_id,
    source: row.source,
    externalId: row.external_id,
    etag: row.etag,
    rawVCard: row.raw_vcard,
    isHidden: row.is_hidden === 1,
    isReadonly: row.is_readonly === 1,
    company: row.company,
    jobTitle: row.job_title,
    emails: parseJsonField<ContactEmail[]>(row.emails_json, []),
    phones: parseJsonField<ContactPhone[]>(row.phone_numbers_json, []),
    addresses: parseJsonField<ContactAddress[]>(row.addresses_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ContactListOptions {
  accountId?: string;
  source?: string;
  limit?: number;
  offset?: number;
  includeHidden?: boolean;
}

export async function getContacts(options: ContactListOptions = {}): Promise<Contact[]> {
  const db = await getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.accountId) {
    conditions.push('account_id = $' + (params.length + 1));
    params.push(options.accountId);
  }
  if (options.source) {
    conditions.push('source = $' + (params.length + 1));
    params.push(options.source);
  }
  if (!options.includeHidden) {
    conditions.push('(is_hidden = 0 OR is_hidden IS NULL)');
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? 500;
  const offset = options.offset ?? 0;
  params.push(limit, offset);

  const rows = await db.select<DbContact[]>(
    `SELECT * FROM contacts ${where}
     ORDER BY frequency DESC, display_name ASC, email ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map(mapDbContact);
}

export async function getAllContacts(limit = 500, offset = 0): Promise<Contact[]> {
  return getContacts({ limit, offset });
}

/**
 * Search contacts by email or name prefix for autocomplete.
 * Returns raw DB rows so callers that only need email/name don't pay the JSON parse cost.
 */
export async function searchContacts(query: string, limit = 10): Promise<DbContact[]> {
  const db = await getDb();
  const pattern = `%${query}%`;
  return db.select<DbContact[]>(
    `SELECT * FROM contacts
     WHERE (is_hidden = 0 OR is_hidden IS NULL)
       AND (email LIKE $1 OR display_name LIKE $1)
     ORDER BY frequency DESC, display_name ASC
     LIMIT $2`,
    [pattern, limit],
  );
}

export async function getContactById(id: string): Promise<Contact | null> {
  const db = await getDb();
  const rows = await db.select<DbContact[]>('SELECT * FROM contacts WHERE id = $1 LIMIT 1', [id]);
  const row = rows[0];
  return row ? mapDbContact(row) : null;
}

export async function getContactByEmail(email: string): Promise<Contact | null> {
  const row = await selectFirstBy<DbContact>('SELECT * FROM contacts WHERE email = $1 LIMIT 1', [
    normalizeEmail(email),
  ]);
  return row ? mapDbContact(row) : null;
}

export async function getContactByExternalId(
  accountId: string,
  source: string,
  externalId: string,
): Promise<Contact | null> {
  const db = await getDb();
  const rows = await db.select<DbContact[]>(
    'SELECT * FROM contacts WHERE account_id = $1 AND source = $2 AND external_id = $3 LIMIT 1',
    [accountId, source, externalId],
  );
  const row = rows[0];
  return row ? mapDbContact(row) : null;
}

export async function createContact(input: CreateContactInput): Promise<Contact> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const normalizedEmail = normalizeEmail(input.email);

  await db.execute(
    `INSERT INTO contacts (
      id, email, display_name, account_id, source, external_id, etag, raw_vcard,
      avatar_url, company, job_title, emails_json, phone_numbers_json, addresses_json,
      notes, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)`,
    [
      id,
      normalizedEmail,
      input.displayName ?? null,
      input.accountId ?? null,
      input.source ?? 'local',
      input.externalId ?? null,
      input.etag ?? null,
      input.rawVCard ?? null,
      input.avatarUrl ?? null,
      input.company ?? null,
      input.jobTitle ?? null,
      JSON.stringify(input.emails ?? []),
      JSON.stringify(input.phones ?? []),
      JSON.stringify(input.addresses ?? []),
      input.notes ?? null,
      now,
    ],
  );

  const created = await getContactById(id);
  if (!created) throw new Error(`[contacts] failed to read created contact ${id}`);
  return created;
}

export async function updateContact(id: string, updates: UpdateContactInput): Promise<void> {
  const db = await getDb();
  const fields: [string, unknown][] = [];

  if (updates.displayName !== undefined) fields.push(['display_name', updates.displayName]);
  if (updates.avatarUrl !== undefined) fields.push(['avatar_url', updates.avatarUrl]);
  if (updates.company !== undefined) fields.push(['company', updates.company]);
  if (updates.jobTitle !== undefined) fields.push(['job_title', updates.jobTitle]);
  if (updates.emails !== undefined) fields.push(['emails_json', JSON.stringify(updates.emails)]);
  if (updates.phones !== undefined)
    fields.push(['phone_numbers_json', JSON.stringify(updates.phones)]);
  if (updates.addresses !== undefined)
    fields.push(['addresses_json', JSON.stringify(updates.addresses)]);
  if (updates.notes !== undefined) fields.push(['notes', updates.notes]);
  if (updates.isHidden !== undefined) fields.push(['is_hidden', updates.isHidden ? 1 : 0]);
  if (updates.isReadonly !== undefined) fields.push(['is_readonly', updates.isReadonly ? 1 : 0]);

  if (fields.length === 0) return;

  const query = buildDynamicUpdate('contacts', 'id', id, fields);
  if (!query) return;
  await db.execute(query.sql, query.params);
}

export async function deleteContact(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM contacts WHERE id = $1', [id]);
}

/**
 * Upsert a contact from mail interaction — bumps frequency if already exists.
 */
export async function upsertContact(email: string, displayName: string | null): Promise<void> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO contacts (id, email, display_name, source, last_contacted_at)
     VALUES ($1, $2, $3, 'mail', unixepoch())
     ON CONFLICT(email) DO UPDATE SET
       display_name = COALESCE($3, display_name),
       frequency = frequency + 1,
       last_contacted_at = unixepoch(),
       updated_at = unixepoch()`,
    [id, normalizeEmail(email), displayName],
  );
}

export async function updateContactAvatar(email: string, avatarUrl: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE contacts SET avatar_url = $1, updated_at = unixepoch() WHERE email = $2',
    [avatarUrl, normalizeEmail(email)],
  );
}

/**
 * Update a contact's notes by email.
 */
export async function updateContactNotes(email: string, notes: string | null): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE contacts SET notes = $1, updated_at = unixepoch() WHERE email = $2', [
    notes || null,
    normalizeEmail(email),
  ]);
}

export interface ContactStats {
  emailCount: number;
  firstEmail: number | null;
  lastEmail: number | null;
}

export async function getContactStats(email: string): Promise<ContactStats> {
  const db = await getDb();
  const rows = await db.select<
    { cnt: number; first_date: number | null; last_date: number | null }[]
  >(
    `SELECT COUNT(*) as cnt, MIN(date) as first_date, MAX(date) as last_date
     FROM messages WHERE from_address = $1`,
    [normalizeEmail(email)],
  );
  const row = rows[0];
  return {
    emailCount: row?.cnt ?? 0,
    firstEmail: row?.first_date ?? null,
    lastEmail: row?.last_date ?? null,
  };
}

export async function getRecentThreadsWithContact(
  email: string,
  limit = 5,
): Promise<{ thread_id: string; subject: string | null; last_message_at: number | null }[]> {
  const db = await getDb();
  return db.select(
    `SELECT DISTINCT t.id as thread_id, t.subject, t.last_message_at
     FROM threads t
     INNER JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
     WHERE m.from_address = $1
     ORDER BY t.last_message_at DESC
     LIMIT $2`,
    [normalizeEmail(email), limit],
  );
}

export interface ContactAttachment {
  filename: string;
  mime_type: string | null;
  size: number | null;
  date: number;
}

export async function getAttachmentsFromContact(
  email: string,
  limit = 5,
): Promise<ContactAttachment[]> {
  const db = await getDb();
  return db.select<ContactAttachment[]>(
    `SELECT a.filename, a.mime_type, a.size, m.date
     FROM attachments a
     INNER JOIN messages m ON m.account_id = a.account_id AND m.id = a.message_id
     WHERE m.from_address = $1 AND a.is_inline = 0 AND a.filename IS NOT NULL
     ORDER BY m.date DESC
     LIMIT $2`,
    [normalizeEmail(email), limit],
  );
}

export interface SameDomainContact {
  email: string;
  display_name: string | null;
  avatar_url: string | null;
}

const PUBLIC_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'yahoo.co.uk',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'protonmail.com',
  'proton.me',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'gmx.com',
  'gmx.net',
]);

export async function getContactsFromSameDomain(
  email: string,
  limit = 5,
): Promise<SameDomainContact[]> {
  const normalized = normalizeEmail(email);
  const atIdx = normalized.indexOf('@');
  if (atIdx === -1) return [];

  const domain = normalized.slice(atIdx + 1);
  if (PUBLIC_DOMAINS.has(domain)) return [];

  const db = await getDb();
  return db.select<SameDomainContact[]>(
    `SELECT email, display_name, avatar_url FROM contacts
     WHERE email LIKE $1 AND email != $2
     ORDER BY frequency DESC
     LIMIT $3`,
    [`%@${domain}`, normalized, limit],
  );
}

export async function getLatestAuthResult(email: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ auth_results: string | null }[]>(
    `SELECT auth_results FROM messages
     WHERE from_address = $1 AND auth_results IS NOT NULL
     ORDER BY date DESC LIMIT 1`,
    [normalizeEmail(email)],
  );
  return rows[0]?.auth_results ?? null;
}

// ---------- Group helpers ----------

export interface DbContactGroup {
  id: string;
  account_id: string | null;
  source: string;
  external_id: string | null;
  name: string;
  etag: string | null;
  is_readonly: number;
  created_at: number;
  updated_at: number;
}

export interface ContactGroup {
  id: string;
  accountId: string | null;
  source: string;
  externalId: string | null;
  name: string;
  etag: string | null;
  isReadonly: boolean;
  createdAt: number;
  updatedAt: number;
}

export function mapDbContactGroup(row: DbContactGroup): ContactGroup {
  return {
    id: row.id,
    accountId: row.account_id,
    source: row.source,
    externalId: row.external_id,
    name: row.name,
    etag: row.etag,
    isReadonly: row.is_readonly === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getContactGroups(accountId?: string): Promise<ContactGroup[]> {
  const db = await getDb();
  if (accountId) {
    const rows = await db.select<DbContactGroup[]>(
      'SELECT * FROM contact_groups WHERE account_id = $1 OR account_id IS NULL ORDER BY name ASC',
      [accountId],
    );
    return rows.map(mapDbContactGroup);
  }
  const rows = await db.select<DbContactGroup[]>('SELECT * FROM contact_groups ORDER BY name ASC');
  return rows.map(mapDbContactGroup);
}

export async function createContactGroup(
  name: string,
  accountId?: string | null,
  source = 'local',
): Promise<ContactGroup> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db.execute(
    `INSERT INTO contact_groups (id, account_id, source, name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [id, accountId ?? null, source, name, now],
  );
  const group = await getContactGroupById(id);
  if (!group) throw new Error(`[contacts] failed to read created group ${id}`);
  return group;
}

export async function getContactGroupById(id: string): Promise<ContactGroup | null> {
  const db = await getDb();
  const rows = await db.select<DbContactGroup[]>(
    'SELECT * FROM contact_groups WHERE id = $1 LIMIT 1',
    [id],
  );
  const row = rows[0];
  return row ? mapDbContactGroup(row) : null;
}

export async function renameContactGroup(id: string, name: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE contact_groups SET name = $1, updated_at = unixepoch() WHERE id = $2',
    [name, id],
  );
}

export async function deleteContactGroup(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM contact_groups WHERE id = $1', [id]);
}

export async function addContactToGroup(contactId: string, groupId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES ($1, $2)',
    [groupId, contactId],
  );
}

export async function removeContactFromGroup(contactId: string, groupId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    'DELETE FROM contact_group_members WHERE group_id = $1 AND contact_id = $2',
    [groupId, contactId],
  );
}

export async function getContactIdsForGroup(groupId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ contact_id: string }[]>(
    'SELECT contact_id FROM contact_group_members WHERE group_id = $1',
    [groupId],
  );
  return rows.map((r) => r.contact_id);
}

export async function getGroupsForContact(contactId: string): Promise<ContactGroup[]> {
  const db = await getDb();
  const rows = await db.select<DbContactGroup[]>(
    `SELECT g.* FROM contact_groups g
     INNER JOIN contact_group_members m ON m.group_id = g.id
     WHERE m.contact_id = $1
     ORDER BY g.name ASC`,
    [contactId],
  );
  return rows.map(mapDbContactGroup);
}

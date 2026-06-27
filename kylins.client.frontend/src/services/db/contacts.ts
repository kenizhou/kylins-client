// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Contacts service. Supports rich local contacts, groups, and future sync
// sources (CardDAV, Google People, EAS). Email lookups are normalized.
//
// Task 5 (Option C) clean-cut cutover: every function delegates to a Rust
// `db_*` Tauri command (see `kylins.client.backend/src/db/contacts.rs`). Rust
// owns the `contacts` / `contact_groups` / `contact_group_members` tables and
// returns ready camelCase DTOs matching the TS types below. The email
// normalization (`normalizeEmail`) now happens Rust-side; TS callers still pass
// raw emails. JSON array columns (`emails_json`, etc.) are parsed by Rust and
// surfaced as `Contact.emails` / `.phones` / `.addresses` (JSON values).

import { invoke } from '@tauri-apps/api/core';

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

export interface ContactListOptions {
  accountId?: string;
  source?: string;
  limit?: number;
  offset?: number;
  includeHidden?: boolean;
}

export async function getContacts(options: ContactListOptions = {}): Promise<Contact[]> {
  return invoke<Contact[]>('db_list_contacts', { options });
}

export async function getAllContacts(limit = 500, offset = 0): Promise<Contact[]> {
  return getContacts({ limit, offset });
}

/**
 * Search contacts by email or name prefix for autocomplete.
 * Returns raw DB rows so callers that only need email/name don't pay the JSON parse cost.
 */
export async function searchContacts(query: string, limit = 10): Promise<DbContact[]> {
  return invoke<DbContact[]>('db_search_contacts', { query, limit });
}

export async function getContactById(id: string): Promise<Contact | null> {
  return invoke<Contact | null>('db_get_contact_by_id', { id });
}

export async function getContactByEmail(email: string): Promise<Contact | null> {
  return invoke<Contact | null>('db_get_contact_by_email', { email });
}

export async function getContactByExternalId(
  accountId: string,
  source: string,
  externalId: string,
): Promise<Contact | null> {
  return invoke<Contact | null>('db_get_contact_by_external_id', {
    accountId,
    source,
    externalId,
  });
}

export async function createContact(input: CreateContactInput): Promise<Contact> {
  return invoke<Contact>('db_create_contact', { input });
}

export async function updateContact(id: string, updates: UpdateContactInput): Promise<void> {
  await invoke<void>('db_update_contact', { id, updates });
}

export async function deleteContact(id: string): Promise<void> {
  await invoke<void>('db_delete_contact', { id });
}

/**
 * Upsert a contact from mail interaction — bumps frequency if already exists.
 */
export async function upsertContact(email: string, displayName: string | null): Promise<void> {
  await invoke<void>('db_upsert_contact', { email, displayName });
}

export async function updateContactAvatar(email: string, avatarUrl: string): Promise<void> {
  await invoke<void>('db_update_contact_avatar', { email, avatarUrl });
}

/**
 * Update a contact's notes by email.
 */
export async function updateContactNotes(email: string, notes: string | null): Promise<void> {
  await invoke<void>('db_update_contact_notes', { email, notes });
}

export interface ContactStats {
  emailCount: number;
  firstEmail: number | null;
  lastEmail: number | null;
}

export async function getContactStats(email: string): Promise<ContactStats> {
  return invoke<ContactStats>('db_get_contact_stats', { email });
}

export async function getRecentThreadsWithContact(
  email: string,
  limit = 5,
): Promise<{ thread_id: string; subject: string | null; last_message_at: number | null }[]> {
  return invoke('db_get_recent_threads_with_contact', { email, limit });
}

export interface ContactAttachment {
  filename: string;
  mimeType: string | null;
  size: number | null;
  date: number;
}

export async function getAttachmentsFromContact(
  email: string,
  limit = 5,
): Promise<ContactAttachment[]> {
  return invoke<ContactAttachment[]>('db_get_attachments_from_contact', { email, limit });
}

export interface SameDomainContact {
  email: string;
  display_name: string | null;
  avatar_url: string | null;
}

export async function getContactsFromSameDomain(
  email: string,
  limit = 5,
): Promise<SameDomainContact[]> {
  return invoke<SameDomainContact[]>('db_get_contacts_from_same_domain', { email, limit });
}

export async function getLatestAuthResult(email: string): Promise<string | null> {
  return invoke<string | null>('db_get_latest_auth_result', { email });
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

export async function getContactGroups(accountId?: string): Promise<ContactGroup[]> {
  return invoke<ContactGroup[]>('db_get_contact_groups', { accountId: accountId ?? null });
}

export async function createContactGroup(
  name: string,
  accountId?: string | null,
  source = 'local',
): Promise<ContactGroup> {
  return invoke<ContactGroup>('db_create_contact_group', {
    name,
    accountId: accountId ?? null,
    source,
  });
}

export async function getContactGroupById(id: string): Promise<ContactGroup | null> {
  return invoke<ContactGroup | null>('db_get_contact_group_by_id', { id });
}

export async function renameContactGroup(id: string, name: string): Promise<void> {
  await invoke<void>('db_rename_contact_group', { id, name });
}

export async function deleteContactGroup(id: string): Promise<void> {
  await invoke<void>('db_delete_contact_group', { id });
}

export async function addContactToGroup(contactId: string, groupId: string): Promise<void> {
  await invoke<void>('db_add_contact_to_group', { contactId, groupId });
}

export async function removeContactFromGroup(contactId: string, groupId: string): Promise<void> {
  await invoke<void>('db_remove_contact_from_group', { contactId, groupId });
}

export async function getContactIdsForGroup(groupId: string): Promise<string[]> {
  return invoke<string[]>('db_get_contact_ids_for_group', { groupId });
}

export async function getGroupsForContact(contactId: string): Promise<ContactGroup[]> {
  return invoke<ContactGroup[]>('db_get_groups_for_contact', { contactId });
}

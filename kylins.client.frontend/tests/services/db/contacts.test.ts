// Task 5 clean-cut: contacts.ts now routes through `invoke('db_*')` instead of
// getDb(). Mock invoke and assert the wrapper forwards the right command + args
// and passes the Rust return value through unchanged. Rust owns email
// normalization + JSON column parsing; the TS types stay byte-for-byte.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createContact,
  getContacts,
  getAllContacts,
  getContactById,
  getContactByEmail,
  getContactByExternalId,
  updateContact,
  deleteContact,
  upsertContact,
  searchContacts,
  updateContactAvatar,
  updateContactNotes,
  getContactStats,
  getRecentThreadsWithContact,
  getAttachmentsFromContact,
  getContactsFromSameDomain,
  getLatestAuthResult,
  getContactGroups,
  getContactGroupById,
  createContactGroup,
  renameContactGroup,
  deleteContactGroup,
  addContactToGroup,
  removeContactFromGroup,
  getContactIdsForGroup,
  getGroupsForContact,
  type Contact,
} from '../../../src/services/db/contacts';
import { wireDefaultDbResults } from '../../../src/test/mockInvoke';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

function contactFixture(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'c-1',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    avatarUrl: null,
    frequency: 0,
    lastContactedAt: null,
    firstContactedAt: null,
    notes: null,
    accountId: null,
    source: 'local',
    externalId: null,
    etag: null,
    rawVCard: null,
    isHidden: false,
    isReadonly: false,
    company: 'Analytical Engines',
    jobTitle: 'Countess',
    emails: [{ label: 'work', value: 'ada@example.com', isPrimary: true }],
    phones: [],
    addresses: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('contacts service', () => {
  it('createContact forwards the input and returns the created contact', async () => {
    mockInvoke.mockResolvedValueOnce(contactFixture());
    const contact = await createContact({
      email: 'Ada@Example.com',
      displayName: 'Ada Lovelace',
      company: 'Analytical Engines',
      jobTitle: 'Countess',
      emails: [{ label: 'work', value: 'ada@example.com', isPrimary: true }],
    });
    expect(contact.email).toBe('ada@example.com');
    expect(contact.displayName).toBe('Ada Lovelace');
    expect(mockInvoke).toHaveBeenCalledWith('db_create_contact', {
      input: expect.objectContaining({
        email: 'Ada@Example.com',
        displayName: 'Ada Lovelace',
        company: 'Analytical Engines',
      }),
    });
  });

  it('getContacts forwards to db_list_contacts with default options', async () => {
    mockInvoke.mockResolvedValueOnce([contactFixture()]);
    const contacts = await getContacts();
    expect(contacts).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledWith('db_list_contacts', { options: {} });
  });

  it('getContacts forwards filter options', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await getContacts({ source: 'mail', includeHidden: true });
    expect(mockInvoke).toHaveBeenCalledWith('db_list_contacts', {
      options: { source: 'mail', includeHidden: true },
    });
  });

  it('getAllContacts passes limit/offset', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await getAllContacts(10, 20);
    expect(mockInvoke).toHaveBeenCalledWith('db_list_contacts', {
      options: { limit: 10, offset: 20 },
    });
  });

  it('getContactById forwards id', async () => {
    mockInvoke.mockResolvedValueOnce(contactFixture());
    await getContactById('c-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_contact_by_id', { id: 'c-1' });
  });

  it('getContactByEmail forwards email (Rust normalizes)', async () => {
    mockInvoke.mockResolvedValueOnce(contactFixture());
    const contact = await getContactByEmail('ADA@EXAMPLE.COM');
    expect(contact).not.toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith('db_get_contact_by_email', {
      email: 'ADA@EXAMPLE.COM',
    });
  });

  it('getContactByExternalId forwards the triple', async () => {
    mockInvoke.mockResolvedValueOnce(null);
    await getContactByExternalId('acc1', 'carddav', 'ext-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_contact_by_external_id', {
      accountId: 'acc1',
      source: 'carddav',
      externalId: 'ext-1',
    });
  });

  it('updateContact forwards only the provided fields', async () => {
    await updateContact('c-1', {
      displayName: 'New Name',
      company: 'New Co',
      emails: [{ value: 'new@example.com' }],
      phones: [{ label: 'cell', value: '+1-555-0100' }],
    });
    expect(mockInvoke).toHaveBeenCalledWith('db_update_contact', {
      id: 'c-1',
      updates: expect.objectContaining({
        displayName: 'New Name',
        company: 'New Co',
        emails: [{ value: 'new@example.com' }],
        phones: [{ label: 'cell', value: '+1-555-0100' }],
      }),
    });
  });

  it('deleteContact forwards id', async () => {
    await deleteContact('c-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_delete_contact', { id: 'c-1' });
  });

  it('upsertContact forwards email + displayName', async () => {
    await upsertContact('Ada@Example.com', 'Ada Lovelace');
    expect(mockInvoke).toHaveBeenCalledWith('db_upsert_contact', {
      email: 'Ada@Example.com',
      displayName: 'Ada Lovelace',
    });
  });

  it('searchContacts forwards query + limit', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await searchContacts('ada', 5);
    expect(mockInvoke).toHaveBeenCalledWith('db_search_contacts', { query: 'ada', limit: 5 });
  });

  it('updateContactAvatar forwards email + url', async () => {
    await updateContactAvatar('ada@example.com', 'data:...');
    expect(mockInvoke).toHaveBeenCalledWith('db_update_contact_avatar', {
      email: 'ada@example.com',
      avatarUrl: 'data:...',
    });
  });

  it('updateContactNotes forwards email + notes (null allowed)', async () => {
    await updateContactNotes('ada@example.com', null);
    expect(mockInvoke).toHaveBeenCalledWith('db_update_contact_notes', {
      email: 'ada@example.com',
      notes: null,
    });
  });

  it('getContactStats returns the stats DTO', async () => {
    mockInvoke.mockResolvedValueOnce({ emailCount: 3, firstEmail: 1, lastEmail: 5 });
    const stats = await getContactStats('ada@example.com');
    expect(stats.emailCount).toBe(3);
    expect(mockInvoke).toHaveBeenCalledWith('db_get_contact_stats', { email: 'ada@example.com' });
  });

  it('getRecentThreadsWithContact forwards email + limit', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await getRecentThreadsWithContact('ada@example.com', 5);
    expect(mockInvoke).toHaveBeenCalledWith('db_get_recent_threads_with_contact', {
      email: 'ada@example.com',
      limit: 5,
    });
  });

  it('getAttachmentsFromContact forwards email + limit', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await getAttachmentsFromContact('ada@example.com');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_attachments_from_contact', {
      email: 'ada@example.com',
      limit: 5,
    });
  });

  it('getContactsFromSameDomain forwards email + limit', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await getContactsFromSameDomain('ada@example.com');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_contacts_from_same_domain', {
      email: 'ada@example.com',
      limit: 5,
    });
  });

  it('getLatestAuthResult forwards email', async () => {
    mockInvoke.mockResolvedValueOnce('pass');
    const result = await getLatestAuthResult('ada@example.com');
    expect(result).toBe('pass');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_latest_auth_result', {
      email: 'ada@example.com',
    });
  });

  describe('contact groups', () => {
    it('getContactGroups forwards optional accountId (null when omitted)', async () => {
      mockInvoke.mockResolvedValueOnce([]);
      await getContactGroups();
      expect(mockInvoke).toHaveBeenCalledWith('db_get_contact_groups', { accountId: null });
    });

    it('getContactGroups forwards the supplied accountId', async () => {
      mockInvoke.mockResolvedValueOnce([]);
      await getContactGroups('acc1');
      expect(mockInvoke).toHaveBeenCalledWith('db_get_contact_groups', { accountId: 'acc1' });
    });

    it('getContactGroupById forwards id', async () => {
      mockInvoke.mockResolvedValueOnce(null);
      await getContactGroupById('g-1');
      expect(mockInvoke).toHaveBeenCalledWith('db_get_contact_group_by_id', { id: 'g-1' });
    });

    it('createContactGroup forwards name/accountId/source with defaults', async () => {
      mockInvoke.mockResolvedValueOnce({
        id: 'g-1',
        accountId: null,
        source: 'local',
        externalId: null,
        name: 'Engineers',
        etag: null,
        isReadonly: false,
        createdAt: 1,
        updatedAt: 2,
      });
      await createContactGroup('Engineers');
      expect(mockInvoke).toHaveBeenCalledWith('db_create_contact_group', {
        name: 'Engineers',
        accountId: null,
        source: 'local',
      });
    });

    it('renameContactGroup forwards id + name', async () => {
      await renameContactGroup('g-1', 'Scientists');
      expect(mockInvoke).toHaveBeenCalledWith('db_rename_contact_group', {
        id: 'g-1',
        name: 'Scientists',
      });
    });

    it('deleteContactGroup forwards id', async () => {
      await deleteContactGroup('g-1');
      expect(mockInvoke).toHaveBeenCalledWith('db_delete_contact_group', { id: 'g-1' });
    });

    it('addContactToGroup forwards contactId + groupId', async () => {
      await addContactToGroup('c-1', 'g-1');
      expect(mockInvoke).toHaveBeenCalledWith('db_add_contact_to_group', {
        contactId: 'c-1',
        groupId: 'g-1',
      });
    });

    it('removeContactFromGroup forwards contactId + groupId', async () => {
      await removeContactFromGroup('c-1', 'g-1');
      expect(mockInvoke).toHaveBeenCalledWith('db_remove_contact_from_group', {
        contactId: 'c-1',
        groupId: 'g-1',
      });
    });

    it('getContactIdsForGroup forwards groupId', async () => {
      mockInvoke.mockResolvedValueOnce(['c-1', 'c-2']);
      const ids = await getContactIdsForGroup('g-1');
      expect(ids).toEqual(['c-1', 'c-2']);
      expect(mockInvoke).toHaveBeenCalledWith('db_get_contact_ids_for_group', { groupId: 'g-1' });
    });

    it('getGroupsForContact forwards contactId', async () => {
      mockInvoke.mockResolvedValueOnce([]);
      await getGroupsForContact('c-1');
      expect(mockInvoke).toHaveBeenCalledWith('db_get_groups_for_contact', { contactId: 'c-1' });
    });
  });
});

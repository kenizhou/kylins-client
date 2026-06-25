import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from '@tauri-apps/plugin-sql';
import {
  createContact,
  getContacts,
  getContactById,
  getContactByEmail,
  updateContact,
  deleteContact,
  upsertContact,
  searchContacts,
  getContactGroups,
  createContactGroup,
  renameContactGroup,
  deleteContactGroup,
  addContactToGroup,
  removeContactFromGroup,
  getContactIdsForGroup,
  getGroupsForContact,
} from '../../../src/services/db/contacts';
import { getDb } from '../../../src/services/db/connection';

vi.mock('../../../src/services/db/connection', () => ({
  getDb: vi.fn(),
  withTransaction: vi.fn(async (fn: (db: unknown) => Promise<void>) => {
    const db = vi.mocked(getDb)();
    return db.then((d) => fn(d));
  }),
  selectFirstBy: vi.fn(async <T>(sql: string, params: unknown[] = []) => {
    const db = await vi.mocked(getDb)();
    const rows = await db.select<T[]>(sql, params);
    return rows[0] ?? null;
  }),
  buildDynamicUpdate: vi.fn(
    (table: string, idColumn: string, idValue: unknown, fields: [string, unknown][]) => {
      if (fields.length === 0) return null;
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      for (const [column, value] of fields) {
        sets.push(`${column} = $${idx++}`);
        params.push(value);
      }
      params.push(idValue);
      const sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE ${idColumn} = $${idx}`;
      return { sql, params };
    },
  ),
}));

const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Database);
  mockDb.select.mockReset();
  mockDb.execute.mockReset();
});

function contactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c-1',
    email: 'ada@example.com',
    display_name: 'Ada Lovelace',
    avatar_url: null,
    frequency: 0,
    last_contacted_at: null,
    first_contacted_at: null,
    notes: null,
    account_id: null,
    source: 'local',
    external_id: null,
    etag: null,
    raw_vcard: null,
    is_hidden: 0,
    is_readonly: 0,
    company: 'Analytical Engines',
    job_title: 'Countess',
    emails_json: '[{"label":"work","value":"ada@example.com","isPrimary":true}]',
    phone_numbers_json: '[]',
    addresses_json: '[]',
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

describe('contacts service', () => {
  it('creates a contact', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    mockDb.select.mockResolvedValue([contactRow()]);

    const contact = await createContact({
      email: 'Ada@Example.com',
      displayName: 'Ada Lovelace',
      company: 'Analytical Engines',
      jobTitle: 'Countess',
      emails: [{ label: 'work', value: 'ada@example.com', isPrimary: true }],
    });

    expect(contact.email).toBe('ada@example.com');
    expect(contact.displayName).toBe('Ada Lovelace');
    expect(contact.company).toBe('Analytical Engines');
    expect(contact.emails).toHaveLength(1);
    expect(contact.emails[0]).toMatchObject({ label: 'work', value: 'ada@example.com', isPrimary: true });
  });

  it('lists contacts', async () => {
    mockDb.select.mockResolvedValue([contactRow({ id: 'c-1' }), contactRow({ id: 'c-2', email: 'grace@example.com', display_name: 'Grace Hopper' })]);
    const contacts = await getContacts();
    expect(contacts).toHaveLength(2);
    expect(contacts[0]!.email).toBe('ada@example.com');
  });

  it('filters contacts by source', async () => {
    mockDb.select.mockResolvedValue([contactRow({ source: 'mail' })]);
    const contacts = await getContacts({ source: 'mail' });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.source).toBe('mail');
  });

  it('gets a contact by id', async () => {
    mockDb.select.mockResolvedValue([contactRow()]);
    const contact = await getContactById('c-1');
    expect(contact).not.toBeNull();
    expect(contact!.id).toBe('c-1');
  });

  it('gets a contact by email normalized', async () => {
    mockDb.select.mockResolvedValue([contactRow()]);
    const contact = await getContactByEmail('ADA@EXAMPLE.COM');
    expect(contact).not.toBeNull();
    expect(contact!.email).toBe('ada@example.com');
  });

  it('updates a contact', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await updateContact('c-1', {
      displayName: 'New Name',
      company: 'New Co',
      emails: [{ value: 'new@example.com' }],
      phones: [{ label: 'cell', value: '+1-555-0100' }],
    });
    expect(mockDb.execute).toHaveBeenCalledOnce();
    const [sql, params] = mockDb.execute.mock.calls[0];
    expect(String(sql)).toContain('UPDATE contacts SET');
    expect(params).toContain('New Name');
    expect(params).toContain('New Co');
    expect(params).toContain('[{"value":"new@example.com"}]');
    expect(params).toContain('[{"label":"cell","value":"+1-555-0100"}]');
  });

  it('deletes a contact', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await deleteContact('c-1');
    const [sql, params] = mockDb.execute.mock.calls[0];
    expect(sql).toBe('DELETE FROM contacts WHERE id = $1');
    expect(params).toEqual(['c-1']);
  });

  it('upserts a contact and bumps frequency', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await upsertContact('Ada@Example.com', 'Ada Lovelace');
    const [sql, params] = mockDb.execute.mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO contacts');
    expect(String(sql)).toContain('ON CONFLICT(email) DO UPDATE');
    expect(params).toContain('ada@example.com');
    expect(params).toContain('Ada Lovelace');
  });

  it('searches contacts by query', async () => {
    mockDb.select.mockResolvedValue([contactRow()]);
    const results = await searchContacts('ada', 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.email).toBe('ada@example.com');
  });

  describe('contact groups', () => {
    function groupRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'g-1',
        account_id: null,
        source: 'local',
        external_id: null,
        name: 'Engineers',
        etag: null,
        is_readonly: 0,
        created_at: 1,
        updated_at: 2,
        ...overrides,
      };
    }

    it('lists groups', async () => {
      mockDb.select.mockResolvedValue([groupRow()]);
      const groups = await getContactGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0]!.name).toBe('Engineers');
    });

    it('creates a group', async () => {
      mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
      mockDb.select.mockResolvedValue([groupRow()]);
      const group = await createContactGroup('Engineers');
      expect(group.name).toBe('Engineers');
    });

    it('renames a group', async () => {
      mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
      await renameContactGroup('g-1', 'Scientists');
      const [sql, params] = mockDb.execute.mock.calls[0];
      expect(String(sql)).toContain('UPDATE contact_groups SET name = $1');
      expect(params).toContain('Scientists');
    });

    it('deletes a group', async () => {
      mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
      await deleteContactGroup('g-1');
      const [sql, params] = mockDb.execute.mock.calls[0];
      expect(sql).toBe('DELETE FROM contact_groups WHERE id = $1');
      expect(params).toEqual(['g-1']);
    });

    it('adds and removes a contact from a group', async () => {
      mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
      await addContactToGroup('c-1', 'g-1');
      const [addSql, addParams] = mockDb.execute.mock.calls[0];
      expect(String(addSql)).toContain('INSERT OR IGNORE INTO contact_group_members');
      expect(addParams).toEqual(['g-1', 'c-1']);

      await removeContactFromGroup('c-1', 'g-1');
      const [removeSql, removeParams] = mockDb.execute.mock.calls[1];
      expect(String(removeSql)).toContain('DELETE FROM contact_group_members');
      expect(removeParams).toEqual(['g-1', 'c-1']);
    });

    it('lists contact ids for a group', async () => {
      mockDb.select.mockResolvedValue([{ contact_id: 'c-1' }, { contact_id: 'c-2' }]);
      const ids = await getContactIdsForGroup('g-1');
      expect(ids).toEqual(['c-1', 'c-2']);
    });

    it('lists groups for a contact', async () => {
      mockDb.select.mockResolvedValue([groupRow({ id: 'g-2', name: 'Friends' })]);
      const groups = await getGroupsForContact('c-1');
      expect(groups).toHaveLength(1);
      expect(groups[0]!.name).toBe('Friends');
    });
  });
});

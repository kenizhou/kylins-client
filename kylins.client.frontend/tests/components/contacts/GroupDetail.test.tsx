import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { GroupDetail } from '@/components/contacts/GroupDetail';
import type { ContactGroup, Contact } from '@/services/db/contacts';

vi.mock('@/services/db/contacts', async () => {
  const actual = await vi.importActual('@/services/db/contacts');
  return {
    ...(actual as object),
    renameContactGroup: vi.fn(() => Promise.resolve()),
    deleteContactGroup: vi.fn(() => Promise.resolve()),
    getContacts: vi.fn(() => Promise.resolve([])),
  };
});

import { renameContactGroup, deleteContactGroup } from '@/services/db/contacts';

function makeGroup(overrides: Partial<ContactGroup> = {}): ContactGroup {
  return {
    id: 'g-1',
    name: 'Team Leads',
    accountId: null,
    source: 'local',
    externalId: null,
    etag: null,
    isReadonly: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as ContactGroup;
}

function makeContact(overrides: Partial<Contact> = {}): Contact {
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
    company: null,
    jobTitle: null,
    emails: [],
    phones: [],
    addresses: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as Contact;
}

describe('GroupDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders group name and members', () => {
    const { getByText } = render(
      <GroupDetail group={makeGroup()} members={[makeContact()]} onUpdate={vi.fn()} />,
    );
    expect(getByText('Team Leads')).toBeInTheDocument();
    expect(getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('shows empty state when no members', () => {
    const { getByText } = render(
      <GroupDetail group={makeGroup()} members={[]} onUpdate={vi.fn()} />,
    );
    expect(getByText('No members yet')).toBeInTheDocument();
  });

  it('renames group and calls onUpdate', async () => {
    const onUpdate = vi.fn();
    const { getByText, getByDisplayValue } = render(
      <GroupDetail group={makeGroup()} members={[]} onUpdate={onUpdate} />,
    );
    fireEvent.click(getByText('Rename'));
    const input = getByDisplayValue('Team Leads');
    fireEvent.change(input, { target: { value: 'Engineering' } });
    fireEvent.click(getByText('Save'));
    await waitFor(() => {
      expect(renameContactGroup).toHaveBeenCalledWith('g-1', 'Engineering');
      expect(onUpdate).toHaveBeenCalled();
    });
  });

  it('deletes group after confirm', async () => {
    vi.stubGlobal('confirm', () => true);
    const onUpdate = vi.fn();
    const { getByText } = render(
      <GroupDetail group={makeGroup()} members={[]} onUpdate={onUpdate} />,
    );
    fireEvent.click(getByText('Delete'));
    await waitFor(() => {
      expect(deleteContactGroup).toHaveBeenCalledWith('g-1');
      expect(onUpdate).toHaveBeenCalled();
    });
    vi.unstubAllGlobals();
  });
});

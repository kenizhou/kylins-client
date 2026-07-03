import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { ContactList } from '@/components/contacts/ContactList';
import { useContactStore } from '@/stores/contactStore';
import type { Contact, ContactGroup } from '@/services/db/contacts';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'c-1',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    frequency: 2,
    accountId: 'acc-1',
    groups: [],
    phones: [],
    addresses: [],
    emails: [],
    ...overrides,
  } as Contact;
}

function makeGroup(overrides: Partial<ContactGroup> = {}): ContactGroup {
  return {
    id: 'g-1',
    name: 'Team Leads',
    accountId: 'acc-1',
    source: 'local',
    isReadonly: false,
    ...overrides,
  } as ContactGroup;
}

describe('ContactList', () => {
  beforeEach(() => {
    useContactStore.setState({
      contacts: [
        makeContact({ id: 'c-1', displayName: 'Ada Lovelace', email: 'ada@example.com' }),
        makeContact({ id: 'c-2', displayName: 'Grace Hopper', email: 'grace@example.com' }),
      ],
      groups: [makeGroup({ id: 'g-1', name: 'Team Leads' })],
      selectedContactId: null,
      selectedGroupId: null,
      selectedAccountId: null,
      searchQuery: '',
      isLoading: false,
    });
  });

  it('renders contacts and groups together alphabetically', async () => {
    const { getByText } = render(<ContactList />);
    await waitFor(() => {
      expect(getByText('Ada Lovelace')).toBeInTheDocument();
      expect(getByText('Grace Hopper')).toBeInTheDocument();
      expect(getByText('Team Leads')).toBeInTheDocument();
    });
  });

  it('filters contacts and groups by search query', async () => {
    useContactStore.getState().setSearchQuery('team');
    const { getByText, queryByText } = render(<ContactList />);
    await waitFor(() => {
      expect(getByText('Team Leads')).toBeInTheDocument();
      expect(queryByText('Ada Lovelace')).not.toBeInTheDocument();
    });
  });

  it('filters by selectedAccountId', async () => {
    useContactStore.setState({
      contacts: [
        makeContact({ id: 'c-1', displayName: 'Ada', accountId: 'acc-1' }),
        makeContact({ id: 'c-2', displayName: 'Grace', accountId: 'acc-2' }),
      ],
      groups: [
        makeGroup({ id: 'g-1', name: 'Team A', accountId: 'acc-1' }),
        makeGroup({ id: 'g-2', name: 'Team B', accountId: 'acc-2' }),
      ],
    });
    useContactStore.getState().setSelectedAccountId('acc-1');
    const { getByText, queryByText } = render(<ContactList />);
    await waitFor(() => {
      expect(getByText('Ada')).toBeInTheDocument();
      expect(getByText('Team A')).toBeInTheDocument();
      expect(queryByText('Grace')).not.toBeInTheDocument();
      expect(queryByText('Team B')).not.toBeInTheDocument();
    });
  });

  it('excludes hidden contacts', async () => {
    useContactStore.setState({
      contacts: [
        makeContact({ id: 'c-1', displayName: 'Ada Lovelace', email: 'ada@example.com' }),
        makeContact({
          id: 'c-hidden',
          displayName: 'Hidden Person',
          email: 'hidden@example.com',
          isHidden: true,
        }),
      ],
    });
    const { getByText, queryByText } = render(<ContactList />);
    await waitFor(() => {
      expect(getByText('Ada Lovelace')).toBeInTheDocument();
      expect(queryByText('Hidden Person')).not.toBeInTheDocument();
      expect(queryByText('hidden@example.com')).not.toBeInTheDocument();
    });
  });

  it('selects a contact on click', async () => {
    const { getByText } = render(<ContactList />);
    fireEvent.click(getByText('Ada Lovelace'));
    expect(useContactStore.getState().selectedContactId).toBe('c-1');
    expect(useContactStore.getState().selectedGroupId).toBeNull();
  });

  it('selects a group on click', async () => {
    const { getByText } = render(<ContactList />);
    fireEvent.click(getByText('Team Leads'));
    expect(useContactStore.getState().selectedGroupId).toBe('g-1');
    expect(useContactStore.getState().selectedContactId).toBeNull();
  });
});

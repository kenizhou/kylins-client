import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { ContactsPage } from '@/components/contacts/ContactsPage';
import { useContactStore } from '@/stores/contactStore';
import { useAccountStore } from '@/stores/accountStore';

vi.mock('@/services/db/contacts', async () => {
  const actual = await vi.importActual('@/services/db/contacts');
  return {
    ...(actual as object),
    getContacts: vi.fn(() =>
      Promise.resolve([
        {
          id: 'c-1',
          email: 'ada@example.com',
          displayName: 'Ada',
          accountId: 'acc-1',
          frequency: 0,
          emails: [],
          phones: [],
          addresses: [],
        },
        {
          id: 'c-2',
          email: 'grace@example.com',
          displayName: 'Grace',
          accountId: 'acc-2',
          frequency: 0,
          emails: [],
          phones: [],
          addresses: [],
        },
      ]),
    ),
    getContactGroups: vi.fn(() =>
      Promise.resolve([
        { id: 'g-1', name: 'Team Leads', accountId: 'acc-1', source: 'local', isReadonly: false },
      ]),
    ),
    getGroupsForContact: vi.fn(() => Promise.resolve([])),
  };
});

describe('ContactsPage', () => {
  beforeEach(() => {
    useContactStore.setState({
      contacts: [],
      groups: [],
      selectedContactId: null,
      selectedGroupId: null,
      selectedAccountId: null,
      searchQuery: '',
      isLoading: false,
    });
    useAccountStore.setState({
      accounts: [
        {
          id: 'acc-1',
          email: 'work@corp.com',
          accountLabel: 'Work',
          provider: 'imap',
        } as ReturnType<typeof useAccountStore.getState>['accounts'][0],
      ],
      activeAccountId: null,
      defaultAccountId: null,
    });
  });

  it('renders account pane and unified list', async () => {
    const { getByText } = render(<ContactsPage />);
    await waitFor(() => {
      expect(getByText('All accounts')).toBeInTheDocument();
      expect(getByText('Work')).toBeInTheDocument();
      expect(getByText('Ada')).toBeInTheDocument();
      expect(getByText('Team Leads')).toBeInTheDocument();
    });
  });

  it('filters list when account clicked', async () => {
    useContactStore.setState({
      contacts: [
        {
          id: 'c-1',
          email: 'ada@example.com',
          displayName: 'Ada',
          accountId: 'acc-1',
          frequency: 0,
          emails: [],
          phones: [],
          addresses: [],
        } as ReturnType<typeof useContactStore.getState>['contacts'][0],
        {
          id: 'c-2',
          email: 'grace@example.com',
          displayName: 'Grace',
          accountId: 'acc-2',
          frequency: 0,
          emails: [],
          phones: [],
          addresses: [],
        } as ReturnType<typeof useContactStore.getState>['contacts'][0],
      ],
      groups: [],
    });
    const { getByText, queryByText } = render(<ContactsPage />);
    fireEvent.click(getByText('Work'));
    await waitFor(() => {
      expect(getByText('Ada')).toBeInTheDocument();
      expect(queryByText('Grace')).not.toBeInTheDocument();
    });
  });
});

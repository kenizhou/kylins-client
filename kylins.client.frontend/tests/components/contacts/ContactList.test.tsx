import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { ContactList } from '../../../src/components/contacts/ContactList';
import { useContactStore } from '../../../src/stores/contactStore';

vi.mock('../../../src/services/db/contacts', async () => {
  const actual = await vi.importActual('../../../src/services/db/contacts');
  return {
    ...(actual as object),
    getContactIdsForGroup: vi.fn(() => Promise.resolve([])),
  };
});

describe('ContactList', () => {
  beforeEach(() => {
    useContactStore.setState({
      contacts: [
        {
          id: 'c-1',
          email: 'ada@example.com',
          displayName: 'Ada Lovelace',
          frequency: 2,
        } as unknown as ReturnType<typeof useContactStore.getState>['contacts'][0],
        {
          id: 'c-2',
          email: 'grace@example.com',
          displayName: 'Grace Hopper',
          frequency: 1,
        } as unknown as ReturnType<typeof useContactStore.getState>['contacts'][0],
      ],
      groups: [],
      selectedContactId: null,
      selectedGroupId: null,
      searchQuery: '',
      isLoading: false,
    });
  });

  it('renders contacts grouped alphabetically', async () => {
    const { getByText } = render(<ContactList />);
    await waitFor(() => {
      expect(getByText('Ada Lovelace')).toBeInTheDocument();
      expect(getByText('Grace Hopper')).toBeInTheDocument();
    });
  });

  it('filters contacts by search query', async () => {
    useContactStore.getState().setSearchQuery('grace');
    const { getByText, queryByText } = render(<ContactList />);
    await waitFor(() => {
      expect(getByText('Grace Hopper')).toBeInTheDocument();
      expect(queryByText('Ada Lovelace')).not.toBeInTheDocument();
    });
  });

  it('selects a contact on click', async () => {
    const { getByText } = render(<ContactList />);
    fireEvent.click(getByText('Ada Lovelace'));
    expect(useContactStore.getState().selectedContactId).toBe('c-1');
  });
});

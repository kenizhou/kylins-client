import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { ContactDetail } from '../../../src/components/contacts/ContactDetail';
import { useContactStore } from '../../../src/stores/contactStore';
import * as contactsModule from '../../../src/services/db/contacts';
import * as composerModule from '../../../src/stores/composerStore';

const contact = {
  id: 'c-1',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  company: 'Analytical Engines',
  jobTitle: 'Countess',
  notes: 'First programmer',
  frequency: 5,
  emails: [{ label: 'work', value: 'ada@work.com' }],
  phones: [{ label: 'cell', value: '+1-555-0100' }],
  addresses: [],
} as unknown as import('../../../src/services/db/contacts').Contact;

const groups = [
  { id: 'g-1', name: 'Engineers' },
] as unknown as import('../../../src/services/db/contacts').ContactGroup[];

vi.mock('../../../src/services/db/contacts', async () => {
  const actual = await vi.importActual('../../../src/services/db/contacts');
  return {
    ...(actual as object),
    getGroupsForContact: vi.fn(() => Promise.resolve([])),
    addContactToGroup: vi.fn(() => Promise.resolve()),
    removeContactFromGroup: vi.fn(() => Promise.resolve()),
    updateContact: vi.fn(() => Promise.resolve()),
    deleteContact: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../../../src/stores/composerStore', () => {
  const openComposer = vi.fn();
  return {
    useComposerStore: {
      getState: vi.fn(() => ({ openComposer })),
    },
  };
});

describe('ContactDetail', () => {
  beforeEach(() => {
    vi.mocked(contactsModule.getGroupsForContact).mockResolvedValue([]);
    useContactStore.setState({
      contacts: [contact as unknown as ReturnType<typeof useContactStore.getState>['contacts'][0]],
      groups,
      selectedContactId: 'c-1',
      selectedGroupId: null,
      searchQuery: '',
      isLoading: false,
    });
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  it('renders contact details', async () => {
    const { getByText } = render(<ContactDetail contact={contact} groups={groups} onUpdate={vi.fn()} />);
    await waitFor(() => {
      expect(getByText('Ada Lovelace')).toBeInTheDocument();
      expect(getByText('ada@example.com')).toBeInTheDocument();
      expect(getByText('Analytical Engines')).toBeInTheDocument();
      expect(getByText('First programmer')).toBeInTheDocument();
    });
  });

  it('enters edit mode and saves changes', async () => {
    const onUpdate = vi.fn();
    const { getByText, getByDisplayValue } = render(
      <ContactDetail contact={contact} groups={groups} onUpdate={onUpdate} />,
    );

    fireEvent.click(getByText('Edit'));
    const nameInput = getByDisplayValue('Ada Lovelace');
    fireEvent.change(nameInput, { target: { value: 'Ada Byron' } });
    fireEvent.click(getByText('Save'));

    await waitFor(() => {
      expect(contactsModule.updateContact).toHaveBeenCalledWith(
        'c-1',
        expect.objectContaining({ displayName: 'Ada Byron' }),
      );
      expect(onUpdate).toHaveBeenCalled();
    });
  });

  it('copies email to clipboard', async () => {
    const { getByText } = render(<ContactDetail contact={contact} groups={groups} onUpdate={vi.fn()} />);
    fireEvent.click(getByText('Copy email'));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ada@example.com');
    });
  });

  it('opens composer when Compose is clicked', async () => {
    const { getByText } = render(<ContactDetail contact={contact} groups={groups} onUpdate={vi.fn()} />);
    fireEvent.click(getByText('Compose'));
    const composer = composerModule.useComposerStore.getState();
    expect(composer.openComposer).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'new',
        to: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
      }),
    );
  });

  it('deletes a contact after confirmation', async () => {
    const onUpdate = vi.fn();
    const { getByText } = render(<ContactDetail contact={contact} groups={groups} onUpdate={onUpdate} />);
    fireEvent.click(getByText('Delete'));
    await waitFor(() => {
      expect(contactsModule.deleteContact).toHaveBeenCalledWith('c-1');
      expect(useContactStore.getState().contacts).toHaveLength(0);
    });
  });
});

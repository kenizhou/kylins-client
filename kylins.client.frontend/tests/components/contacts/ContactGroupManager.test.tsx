import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { ContactGroupManager } from '../../../src/components/contacts/ContactGroupManager';
import { useContactStore } from '../../../src/stores/contactStore';
import * as contactsModule from '../../../src/services/db/contacts';

vi.mock('../../../src/services/db/contacts', async () => {
  const actual = await vi.importActual('../../../src/services/db/contacts');
  return {
    ...(actual as object),
    createContactGroup: vi.fn((name) =>
      Promise.resolve({
        id: 'g-new',
        name,
        source: 'local',
        isReadonly: false,
        createdAt: 1,
        updatedAt: 2,
      } as unknown as import('../../../src/services/db/contacts').ContactGroup),
    ),
    renameContactGroup: vi.fn(() => Promise.resolve()),
    deleteContactGroup: vi.fn(() => Promise.resolve()),
  };
});

describe('ContactGroupManager', () => {
  beforeEach(() => {
    useContactStore.setState({
      contacts: [],
      groups: [
        { id: 'g-1', name: 'Engineers' } as unknown as ReturnType<
          typeof useContactStore.getState
        >['groups'][0],
      ],
      selectedContactId: null,
      selectedGroupId: null,
      searchQuery: '',
      isLoading: false,
    });
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
  });

  it('renders existing groups', () => {
    const { getByText } = render(<ContactGroupManager onUpdate={vi.fn()} />);
    expect(getByText('Engineers')).toBeInTheDocument();
  });

  it('creates a new group', async () => {
    const onUpdate = vi.fn();
    const { getByPlaceholderText, getByText } = render(<ContactGroupManager onUpdate={onUpdate} />);
    const input = getByPlaceholderText('New group name');
    fireEvent.change(input, { target: { value: 'Scientists' } });
    fireEvent.click(getByText('Add'));

    await waitFor(() => {
      expect(contactsModule.createContactGroup).toHaveBeenCalledWith('Scientists');
      expect(useContactStore.getState().groups.some((g) => g.name === 'Scientists')).toBe(true);
      expect(onUpdate).toHaveBeenCalled();
    });
  });

  it('renames a group', async () => {
    const onUpdate = vi.fn();
    const { getByLabelText, getByDisplayValue } = render(
      <ContactGroupManager onUpdate={onUpdate} />,
    );
    fireEvent.click(getByLabelText('Rename'));
    const input = getByDisplayValue('Engineers');
    fireEvent.change(input, { target: { value: 'Scientists' } });
    fireEvent.click(getByLabelText('Save'));

    await waitFor(() => {
      expect(contactsModule.renameContactGroup).toHaveBeenCalledWith('g-1', 'Scientists');
      expect(useContactStore.getState().groups[0]!.name).toBe('Scientists');
      expect(onUpdate).toHaveBeenCalled();
    });
  });

  it('deletes a group after confirmation', async () => {
    const onUpdate = vi.fn();
    const { getByLabelText } = render(<ContactGroupManager onUpdate={onUpdate} />);
    fireEvent.click(getByLabelText('Delete'));

    await waitFor(() => {
      expect(contactsModule.deleteContactGroup).toHaveBeenCalledWith('g-1');
      expect(useContactStore.getState().groups).toHaveLength(0);
      expect(onUpdate).toHaveBeenCalled();
    });
  });
});

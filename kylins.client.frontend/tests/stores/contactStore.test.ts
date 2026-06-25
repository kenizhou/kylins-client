import { describe, it, expect, beforeEach } from 'vitest';
import { useContactStore } from '../../src/stores/contactStore';

describe('contactStore', () => {
  beforeEach(() => {
    useContactStore.setState({
      contacts: [],
      groups: [],
      selectedContactId: null,
      selectedGroupId: null,
      searchQuery: '',
      isLoading: false,
    });
  });

  it('sets contacts', () => {
    useContactStore.getState().setContacts([{ id: 'c-1', email: 'a@example.com' } as ReturnType<typeof useContactStore.getState>['contacts'][0]]);
    expect(useContactStore.getState().contacts).toHaveLength(1);
  });

  it('adds a contact and selects it', () => {
    useContactStore.getState().addContact({ id: 'c-1', email: 'a@example.com' } as ReturnType<typeof useContactStore.getState>['contacts'][0]);
    const state = useContactStore.getState();
    expect(state.contacts[0]!.id).toBe('c-1');
    expect(state.selectedContactId).toBe('c-1');
  });

  it('updates a contact in place', () => {
    useContactStore.getState().setContacts([{ id: 'c-1', email: 'a@example.com', displayName: 'A' } as ReturnType<typeof useContactStore.getState>['contacts'][0]]);
    useContactStore.getState().updateContact('c-1', { displayName: 'Ada' } as Partial<ReturnType<typeof useContactStore.getState>['contacts'][0]>);
    expect(useContactStore.getState().contacts[0]!.displayName).toBe('Ada');
  });

  it('removes a contact and clears selection', () => {
    useContactStore.getState().setContacts([{ id: 'c-1', email: 'a@example.com' } as ReturnType<typeof useContactStore.getState>['contacts'][0]]);
    useContactStore.getState().setSelectedContactId('c-1');
    useContactStore.getState().removeContact('c-1');
    const state = useContactStore.getState();
    expect(state.contacts).toHaveLength(0);
    expect(state.selectedContactId).toBeNull();
  });

  it('sets groups in provided order', () => {
    useContactStore.getState().setGroups([
      { id: 'g-2', name: 'Beta' } as ReturnType<typeof useContactStore.getState>['groups'][0],
      { id: 'g-1', name: 'Alpha' } as ReturnType<typeof useContactStore.getState>['groups'][0],
    ]);
    const names = useContactStore.getState().groups.map((g) => g.name);
    expect(names).toEqual(['Beta', 'Alpha']);
  });

  it('adds a group sorted', () => {
    useContactStore.getState().setGroups([{ id: 'g-2', name: 'Beta' } as ReturnType<typeof useContactStore.getState>['groups'][0]]);
    useContactStore.getState().addGroup({ id: 'g-1', name: 'Alpha' } as ReturnType<typeof useContactStore.getState>['groups'][0]);
    const names = useContactStore.getState().groups.map((g) => g.name);
    expect(names).toEqual(['Alpha', 'Beta']);
  });

  it('removes a group and clears selection', () => {
    useContactStore.getState().setGroups([{ id: 'g-1', name: 'Alpha' } as ReturnType<typeof useContactStore.getState>['groups'][0]]);
    useContactStore.getState().setSelectedGroupId('g-1');
    useContactStore.getState().removeGroup('g-1');
    const state = useContactStore.getState();
    expect(state.groups).toHaveLength(0);
    expect(state.selectedGroupId).toBeNull();
  });

  it('sets search query', () => {
    useContactStore.getState().setSearchQuery('ada');
    expect(useContactStore.getState().searchQuery).toBe('ada');
  });
});

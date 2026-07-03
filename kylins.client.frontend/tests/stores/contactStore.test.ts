import { describe, it, expect, beforeEach } from 'vitest';
import { useContactStore } from '../../src/stores/contactStore';

function makeContact(
  overrides: Partial<ReturnType<typeof useContactStore.getState>['contacts'][0]> = {},
) {
  return { id: 'c-1', email: 'a@example.com', accountId: 'acc-1', ...overrides } as ReturnType<
    typeof useContactStore.getState
  >['contacts'][0];
}

function makeGroup(
  overrides: Partial<ReturnType<typeof useContactStore.getState>['groups'][0]> = {},
) {
  return { id: 'g-1', name: 'Alpha', accountId: 'acc-1', ...overrides } as ReturnType<
    typeof useContactStore.getState
  >['groups'][0];
}

describe('contactStore', () => {
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
  });

  it('sets contacts', () => {
    useContactStore
      .getState()
      .setContacts([
        { id: 'c-1', email: 'a@example.com' } as ReturnType<
          typeof useContactStore.getState
        >['contacts'][0],
      ]);
    expect(useContactStore.getState().contacts).toHaveLength(1);
  });

  it('adds a contact and selects it', () => {
    useContactStore
      .getState()
      .addContact({ id: 'c-1', email: 'a@example.com' } as ReturnType<
        typeof useContactStore.getState
      >['contacts'][0]);
    const state = useContactStore.getState();
    expect(state.contacts[0]!.id).toBe('c-1');
    expect(state.selectedContactId).toBe('c-1');
  });

  it('updates a contact in place', () => {
    useContactStore
      .getState()
      .setContacts([
        { id: 'c-1', email: 'a@example.com', displayName: 'A' } as ReturnType<
          typeof useContactStore.getState
        >['contacts'][0],
      ]);
    useContactStore
      .getState()
      .updateContact('c-1', { displayName: 'Ada' } as Partial<
        ReturnType<typeof useContactStore.getState>['contacts'][0]
      >);
    expect(useContactStore.getState().contacts[0]!.displayName).toBe('Ada');
  });

  it('removes a contact and clears selection', () => {
    useContactStore
      .getState()
      .setContacts([
        { id: 'c-1', email: 'a@example.com' } as ReturnType<
          typeof useContactStore.getState
        >['contacts'][0],
      ]);
    useContactStore.getState().setSelectedContactId('c-1');
    useContactStore.getState().removeContact('c-1');
    const state = useContactStore.getState();
    expect(state.contacts).toHaveLength(0);
    expect(state.selectedContactId).toBeNull();
  });

  it('sets groups in provided order', () => {
    useContactStore
      .getState()
      .setGroups([
        { id: 'g-2', name: 'Beta' } as ReturnType<typeof useContactStore.getState>['groups'][0],
        { id: 'g-1', name: 'Alpha' } as ReturnType<typeof useContactStore.getState>['groups'][0],
      ]);
    const names = useContactStore.getState().groups.map((g) => g.name);
    expect(names).toEqual(['Beta', 'Alpha']);
  });

  it('adds a group sorted', () => {
    useContactStore
      .getState()
      .setGroups([
        { id: 'g-2', name: 'Beta' } as ReturnType<typeof useContactStore.getState>['groups'][0],
      ]);
    useContactStore
      .getState()
      .addGroup({ id: 'g-1', name: 'Alpha' } as ReturnType<
        typeof useContactStore.getState
      >['groups'][0]);
    const names = useContactStore.getState().groups.map((g) => g.name);
    expect(names).toEqual(['Alpha', 'Beta']);
  });

  it('removes a group and clears selection', () => {
    useContactStore
      .getState()
      .setGroups([
        { id: 'g-1', name: 'Alpha' } as ReturnType<typeof useContactStore.getState>['groups'][0],
      ]);
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

  it('has default selectedAccountId null', () => {
    expect(useContactStore.getState().selectedAccountId).toBeNull();
  });

  it('sets selectedAccountId', () => {
    useContactStore.getState().setSelectedAccountId('acc-1');
    expect(useContactStore.getState().selectedAccountId).toBe('acc-1');
  });

  it('selecting a contact clears selectedGroupId', () => {
    useContactStore.getState().setSelectedGroupId('g-1');
    useContactStore.getState().setSelectedContactId('c-1');
    const state = useContactStore.getState();
    expect(state.selectedContactId).toBe('c-1');
    expect(state.selectedGroupId).toBeNull();
  });

  it('selecting a group clears selectedContactId', () => {
    useContactStore.getState().setSelectedContactId('c-1');
    useContactStore.getState().setSelectedGroupId('g-1');
    const state = useContactStore.getState();
    expect(state.selectedGroupId).toBe('g-1');
    expect(state.selectedContactId).toBeNull();
  });

  it('clears selected contact when account filter changes to a different account', () => {
    useContactStore.setState({
      contacts: [makeContact({ id: 'c-1', accountId: 'acc-1' })],
      groups: [makeGroup({ id: 'g-1', accountId: 'acc-1' })],
      selectedContactId: 'c-1',
      selectedGroupId: 'g-1',
      selectedAccountId: null,
    });
    useContactStore.getState().setSelectedAccountId('acc-2');
    const state = useContactStore.getState();
    expect(state.selectedAccountId).toBe('acc-2');
    expect(state.selectedContactId).toBeNull();
    expect(state.selectedGroupId).toBeNull();
  });

  it('keeps selection when account filter changes to all accounts', () => {
    useContactStore.setState({
      contacts: [makeContact({ id: 'c-1', accountId: 'acc-1' })],
      groups: [makeGroup({ id: 'g-1', accountId: 'acc-1' })],
      selectedContactId: 'c-1',
      selectedGroupId: 'g-1',
      selectedAccountId: 'acc-1',
    });
    useContactStore.getState().setSelectedAccountId(null);
    const state = useContactStore.getState();
    expect(state.selectedAccountId).toBeNull();
    expect(state.selectedContactId).toBe('c-1');
    expect(state.selectedGroupId).toBe('g-1');
  });

  it('keeps local selection when account filter changes to local', () => {
    useContactStore.setState({
      contacts: [makeContact({ id: 'c-1', accountId: null })],
      groups: [makeGroup({ id: 'g-1', accountId: null })],
      selectedContactId: 'c-1',
      selectedGroupId: 'g-1',
      selectedAccountId: null,
    });
    useContactStore.getState().setSelectedAccountId('local');
    const state = useContactStore.getState();
    expect(state.selectedAccountId).toBe('local');
    expect(state.selectedContactId).toBe('c-1');
    expect(state.selectedGroupId).toBe('g-1');
  });

  it('clears non-local selection when account filter changes to local', () => {
    useContactStore.setState({
      contacts: [makeContact({ id: 'c-1', accountId: 'acc-1' })],
      groups: [makeGroup({ id: 'g-1', accountId: 'acc-1' })],
      selectedContactId: 'c-1',
      selectedGroupId: 'g-1',
      selectedAccountId: null,
    });
    useContactStore.getState().setSelectedAccountId('local');
    const state = useContactStore.getState();
    expect(state.selectedAccountId).toBe('local');
    expect(state.selectedContactId).toBeNull();
    expect(state.selectedGroupId).toBeNull();
  });
});

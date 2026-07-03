import { create } from 'zustand';
import type { Contact, ContactGroup } from '../services/db/contacts';

export interface ContactState {
  contacts: Contact[];
  groups: ContactGroup[];
  selectedContactId: string | null;
  selectedGroupId: string | null;
  selectedAccountId: string | null;
  searchQuery: string;
  isLoading: boolean;

  setContacts: (contacts: Contact[]) => void;
  addContact: (contact: Contact) => void;
  updateContact: (id: string, updates: Partial<Contact>) => void;
  removeContact: (id: string) => void;
  setGroups: (groups: ContactGroup[]) => void;
  addGroup: (group: ContactGroup) => void;
  updateGroup: (id: string, updates: Partial<ContactGroup>) => void;
  removeGroup: (id: string) => void;
  setSelectedContactId: (id: string | null) => void;
  setSelectedGroupId: (id: string | null) => void;
  setSelectedAccountId: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  setIsLoading: (loading: boolean) => void;
}

export const useContactStore = create<ContactState>((set) => ({
  contacts: [],
  groups: [],
  selectedContactId: null,
  selectedGroupId: null,
  selectedAccountId: null,
  searchQuery: '',
  isLoading: false,

  setContacts: (contacts) => set({ contacts }),
  addContact: (contact) =>
    set((state) => ({
      contacts: [contact, ...state.contacts],
      selectedContactId: state.selectedContactId ?? contact.id,
    })),
  updateContact: (id, updates) =>
    set((state) => ({
      contacts: state.contacts.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    })),
  removeContact: (id) =>
    set((state) => {
      const next = state.contacts.filter((c) => c.id !== id);
      return {
        contacts: next,
        selectedContactId:
          state.selectedContactId === id ? (next[0]?.id ?? null) : state.selectedContactId,
      };
    }),
  setGroups: (groups) => set({ groups }),
  addGroup: (group) =>
    set((state) => ({
      groups: [...state.groups, group].sort((a, b) => a.name.localeCompare(b.name)),
    })),
  updateGroup: (id, updates) =>
    set((state) => ({
      groups: state.groups
        .map((g) => (g.id === id ? { ...g, ...updates } : g))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })),
  removeGroup: (id) =>
    set((state) => ({
      groups: state.groups.filter((g) => g.id !== id),
      selectedGroupId: state.selectedGroupId === id ? null : state.selectedGroupId,
    })),
  setSelectedContactId: (id) => set({ selectedContactId: id, selectedGroupId: null }),
  setSelectedGroupId: (id) => set({ selectedGroupId: id, selectedContactId: null }),
  setSelectedAccountId: (id) => set({ selectedAccountId: id }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setIsLoading: (isLoading) => set({ isLoading }),
}));

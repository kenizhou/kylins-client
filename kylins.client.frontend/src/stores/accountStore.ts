import { create } from 'zustand';
import type { Account } from '../types';

export interface AccountState {
  accounts: Account[];
  activeAccountId: string | null;
  defaultAccountId: string | null;
  setAccounts: (accounts: Account[]) => void;
  setActiveAccount: (id: string | null) => void;
  addAccount: (account: Account) => void;
  removeAccount: (id: string) => void;
  updateAccountInPlace: (id: string, updates: Partial<Account>) => void;
  setDefaultAccountId: (id: string) => void;
}

export const useAccountStore = create<AccountState>((set) => ({
  accounts: [],
  activeAccountId: null,
  defaultAccountId: null,

  setAccounts: (accounts) =>
    set((state) => {
      const defaultAcc = accounts.find((a) => a.isDefault);
      const fallbackDefault = defaultAcc?.id ?? accounts[0]?.id ?? null;
      return {
        accounts,
        activeAccountId:
          state.activeAccountId && accounts.some((a) => a.id === state.activeAccountId)
            ? state.activeAccountId
            : (accounts[0]?.id ?? null),
        defaultAccountId: fallbackDefault,
      };
    }),

  setActiveAccount: (activeAccountId) => set({ activeAccountId }),

  addAccount: (account) =>
    set((state) => ({
      accounts: [...state.accounts, account],
      activeAccountId: state.activeAccountId ?? account.id,
      defaultAccountId: state.defaultAccountId ?? (account.isDefault ? account.id : null),
    })),

  removeAccount: (id) =>
    set((state) => {
      const nextAccounts = state.accounts.filter((a) => a.id !== id);
      const nextActive =
        state.activeAccountId === id ? (nextAccounts[0]?.id ?? null) : state.activeAccountId;
      const nextDefault =
        state.defaultAccountId === id
          ? (nextAccounts.find((a) => a.isDefault)?.id ?? nextAccounts[0]?.id ?? null)
          : state.defaultAccountId;
      return {
        accounts: nextAccounts,
        activeAccountId: nextActive,
        defaultAccountId: nextDefault,
      };
    }),

  updateAccountInPlace: (id, updates) =>
    set((state) => {
      const nextAccounts = state.accounts.map((a) => {
        if (a.id === id) return { ...a, ...updates };
        // If another account is being promoted to default, clear the old default.
        if (updates.isDefault) return { ...a, isDefault: false };
        return a;
      });
      const nextDefault = nextAccounts.find((a) => a.isDefault)?.id ?? state.defaultAccountId;
      return {
        accounts: nextAccounts,
        defaultAccountId: nextDefault,
      };
    }),

  setDefaultAccountId: (id) =>
    set((state) => ({
      accounts: state.accounts.map((a) => ({
        ...a,
        isDefault: a.id === id,
      })),
      defaultAccountId: id,
    })),
}));

import { create } from 'zustand';
import type { Account } from '../types';

export interface AccountState {
  accounts: Account[];
  activeAccountId: string | null;
  setAccounts: (accounts: Account[]) => void;
  setActiveAccount: (id: string | null) => void;
  addAccount: (account: Account) => void;
}

export const useAccountStore = create<AccountState>((set) => ({
  accounts: [],
  activeAccountId: null,
  setAccounts: (accounts) => set({ accounts }),
  setActiveAccount: (activeAccountId) => set({ activeAccountId }),
  addAccount: (account) => set((state) => ({ accounts: [...state.accounts, account] })),
}));

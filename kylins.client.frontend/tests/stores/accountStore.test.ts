import { describe, it, expect, beforeEach } from 'vitest';
import { useAccountStore } from '../../src/stores/accountStore';

function makeAccount(overrides: Partial<import('../../src/types').Account> = {}) {
  return {
    id: '1',
    email: 'a@b.com',
    provider: 'eas' as const,
    isActive: true,
    isDefault: false,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('accountStore', () => {
  beforeEach(() => {
    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      defaultAccountId: null,
    });
  });

  it('adds an account', () => {
    const account = makeAccount();
    useAccountStore.getState().addAccount(account);
    expect(useAccountStore.getState().accounts).toContainEqual(account);
  });

  it('computes defaultAccountId from isDefault when setting accounts', () => {
    const a1 = makeAccount({ id: 'a1', isDefault: false });
    const a2 = makeAccount({ id: 'a2', isDefault: true });
    useAccountStore.getState().setAccounts([a1, a2]);
    expect(useAccountStore.getState().defaultAccountId).toBe('a2');
    expect(useAccountStore.getState().activeAccountId).toBe('a1');
  });

  it('falls back active account to first account when current is missing', () => {
    useAccountStore.setState({ activeAccountId: 'gone' });
    const a1 = makeAccount({ id: 'a1' });
    useAccountStore.getState().setAccounts([a1]);
    expect(useAccountStore.getState().activeAccountId).toBe('a1');
  });

  it('removes an account and resets active/default fallbacks', () => {
    const a1 = makeAccount({ id: 'a1', isDefault: true });
    const a2 = makeAccount({ id: 'a2' });
    useAccountStore.getState().setAccounts([a1, a2]);
    useAccountStore.getState().setActiveAccount('a1');
    useAccountStore.getState().removeAccount('a1');
    expect(useAccountStore.getState().accounts).toHaveLength(1);
    expect(useAccountStore.getState().accounts[0]?.id).toBe('a2');
    expect(useAccountStore.getState().activeAccountId).toBe('a2');
    expect(useAccountStore.getState().defaultAccountId).toBe('a2');
  });

  it('updates an account in place and tracks default changes', () => {
    const a1 = makeAccount({ id: 'a1', isDefault: true });
    const a2 = makeAccount({ id: 'a2', isDefault: false });
    useAccountStore.getState().setAccounts([a1, a2]);
    useAccountStore.getState().updateAccountInPlace('a2', { isDefault: true });
    expect(useAccountStore.getState().accounts.find((a) => a.id === 'a2')?.isDefault).toBe(true);
    expect(useAccountStore.getState().defaultAccountId).toBe('a2');
  });

  it('sets default account id across all accounts', () => {
    const a1 = makeAccount({ id: 'a1', isDefault: true });
    const a2 = makeAccount({ id: 'a2', isDefault: false });
    useAccountStore.getState().setAccounts([a1, a2]);
    useAccountStore.getState().setDefaultAccountId('a2');
    expect(useAccountStore.getState().accounts.every((a) => (a.id === 'a2' ? a.isDefault : !a.isDefault))).toBe(true);
    expect(useAccountStore.getState().defaultAccountId).toBe('a2');
  });
});

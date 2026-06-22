import { describe, it, expect } from 'vitest';
import { useAccountStore } from '../../src/stores/accountStore';

describe('accountStore', () => {
  it('adds an account', () => {
    const account = {
      id: '1',
      email: 'a@b.com',
      provider: 'eas',
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    };
    useAccountStore.getState().addAccount(account);
    expect(useAccountStore.getState().accounts).toContainEqual(account);
  });
});

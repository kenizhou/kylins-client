// Task 5: CryptoMethodSection UI tests.
//
// Verifies the per-account crypto-method picker mounted in SecurityPreferences:
//   - the dropdown seeds from the picked account's `cryptoMethod` value
//   - changing the dropdown calls `updateAccount(id, { cryptoMethod })` then
//     mirrors the change into the local store via `updateAccountInPlace`
//   - the default is `'none'` (mirrors the Rust `CryptoMethod::None` default)
//
// Mirrors CryptoGranularitySection.test.tsx structurally: real Zustand store
// seeded via `setState`, `vi.mock` for the accounts service, `fireEvent.change`
// for `<select>` mutations, `getByLabelText`/`getByDisplayValue` queries.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CryptoMethodSection } from '@/components/preferences/CryptoMethodSection';
import { useAccountStore } from '@/stores/accountStore';
import type { Account } from '@/types';

// Mock the accounts service — the unit under interaction. Only `updateAccount`
// is invoked by the component; the other exports are surfaced so the module
// shape matches the real one.
vi.mock('@/services/accounts', () => ({
  updateAccount: vi.fn().mockResolvedValue(undefined),
  getAllAccounts: vi.fn(),
  getAccountById: vi.fn(),
  createAccount: vi.fn(),
  deleteAccount: vi.fn(),
  setDefaultAccount: vi.fn(),
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'a1',
    email: 'one@example.com',
    displayName: 'One',
    provider: 'imap',
    isActive: true,
    isDefault: true,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('CryptoMethodSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Seed the real account store with two accounts: the first has
    // `cryptoMethod: 'openpgp'` so the seeded display value is
    // distinguishable from the 'None' default.
    useAccountStore.setState({
      accounts: [
        makeAccount({
          id: 'a1',
          email: 'one@x',
          displayName: 'One',
          cryptoMethod: 'openpgp',
        }),
        makeAccount({
          id: 'a2',
          email: 'two@x',
          displayName: 'Two',
          cryptoMethod: undefined,
        }),
      ],
      activeAccountId: 'a1',
      defaultAccountId: 'a1',
    });
  });

  it('seeds the dropdown from the picked account value', () => {
    render(<CryptoMethodSection />);
    // The picked account's `cryptoMethod` is 'openpgp' → the <select> shows
    // the matching option's label.
    const select = screen.getByDisplayValue('PGP (OpenPGP)') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe('openpgp');
  });

  it('calls updateAccount with the chosen cryptoMethod', async () => {
    const { updateAccount } = await import('@/services/accounts');
    const spy = vi.mocked(updateAccount);
    spy.mockClear();
    // Spy on the Zustand store's `updateAccountInPlace` to assert the component
    // mirrors the persisted update into the local store as well.
    const spy2 = vi.spyOn(useAccountStore.getState(), 'updateAccountInPlace');
    render(<CryptoMethodSection />);
    const select = screen.getByLabelText(/crypto method/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'smime' } });
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('a1', { cryptoMethod: 'smime' });
      expect(spy2).toHaveBeenCalledWith('a1', { cryptoMethod: 'smime' });
    });
    spy2.mockRestore();
  });

  it('shows the empty-state hint when no accounts exist', () => {
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    render(<CryptoMethodSection />);
    expect(screen.getByText(/add an account first to set its crypto method/i)).toBeInTheDocument();
  });

  it("re-seeds to 'none' when the picked account has no cryptoMethod", () => {
    render(<CryptoMethodSection />);
    // Pick the second account, which has `cryptoMethod: undefined` → the
    // method <select> falls back to 'None'.
    const accountSelect = screen.getByLabelText(/choose account/i) as HTMLSelectElement;
    fireEvent.change(accountSelect, { target: { value: 'a2' } });
    expect((screen.getByDisplayValue('None') as HTMLSelectElement).value).toBe('none');
  });

  it('reverts the dropdown on save failure (no silent optimistic update)', async () => {
    const { updateAccount } = await import('@/services/accounts');
    const spy = vi.mocked(updateAccount);
    spy.mockClear();
    spy.mockRejectedValueOnce(new Error('db locked'));
    render(<CryptoMethodSection />);
    const select = screen.getByLabelText(/crypto method/i) as HTMLSelectElement;
    // a1 starts at 'openpgp'; attempt to switch to 'smime' fails → the UI
    // reverts to the persisted 'openpgp'.
    fireEvent.change(select, { target: { value: 'smime' } });
    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
    // After the rejected save, the dropdown reflects the persisted value.
    expect((screen.getByDisplayValue('PGP (OpenPGP)') as HTMLSelectElement).value).toBe('openpgp');
  });
});

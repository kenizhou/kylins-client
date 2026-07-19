// Task 2 (CU): CryptoGranularitySection UI tests.
//
// Verifies the encryption-granularity picker mounted in SecurityPreferences:
//   - the dropdown seeds from the picked account's `cryptoGranularity` value
//   - changing the dropdown calls `updateAccount(id, { cryptoGranularity })`
//     then mirrors the change into the local store via `updateAccountInPlace`
//
// Mirrors KeyManager.test.tsx: real Zustand store seeded via `setState`,
// relative-path `vi.mock` for the service module, `fireEvent.change` for
// `<select>` mutations, `getByLabelText`/`getByDisplayValue` queries.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CryptoGranularitySection } from '@/components/preferences/CryptoGranularitySection';
import { useAccountStore } from '@/stores/accountStore';
import type { Account } from '@/types';

// Mock the accounts service — the unit under interaction. Only `updateAccount`
// is invoked by the component; the other exports are surfaced so the module
// shape matches the real one (in case future revisions call more of it).
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

describe('CryptoGranularitySection', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Seed the real account store with two accounts: the first has a
    // non-default `cryptoGranularity` so the dropdown's seeded display value
    // is distinguishable from the default "Whole message" option.
    useAccountStore.setState({
      accounts: [
        makeAccount({
          id: 'a1',
          email: 'one@x',
          displayName: 'One',
          cryptoGranularity: 'body_inline_merged_attachments',
        }),
        makeAccount({
          id: 'a2',
          email: 'two@x',
          displayName: 'Two',
          cryptoGranularity: undefined,
        }),
      ],
      activeAccountId: 'a1',
      defaultAccountId: 'a1',
    });
  });

  it('seeds the dropdown from the picked account value', () => {
    render(<CryptoGranularitySection />);
    // The picked account's `cryptoGranularity` is `body_inline_merged_attachments`
    // → the <select> shows the matching option's label.
    const select = screen.getByDisplayValue('Merged attachments (one part)');
    expect(select).toBeTruthy();
  });

  it('calls updateAccount with the chosen granularity', async () => {
    const { updateAccount } = await import('@/services/accounts');
    const spy = vi.mocked(updateAccount);
    spy.mockClear();
    // Spy on the Zustand store's `updateAccountInPlace` to assert the component
    // mirrors the persisted update into the local store as well. The store is
    // real (seeded via `setState` in `beforeEach`); `getState()` returns the
    // current merged state object, on which `vi.spyOn` swaps the action for a
    // spy wrapping the original. The component reads the action via its
    // selector at render time, so it picks up the spied reference.
    const spy2 = vi.spyOn(useAccountStore.getState(), 'updateAccountInPlace');
    render(<CryptoGranularitySection />);
    const select = screen.getByLabelText(/encryption granularity/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'whole_message' } });
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('a1', { cryptoGranularity: 'whole_message' });
      expect(spy2).toHaveBeenCalledWith('a1', { cryptoGranularity: 'whole_message' });
    });
    spy2.mockRestore();
  });

  it('shows the empty-state hint when no accounts exist', () => {
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    render(<CryptoGranularitySection />);
    expect(
      screen.getByText(/add an account first to set its encryption granularity/i),
    ).toBeInTheDocument();
  });

  it('re-seeds the granularity when the picked account changes', () => {
    render(<CryptoGranularitySection />);
    // Pick the second account, which has `cryptoGranularity: undefined` →
    // the granularity <select> falls back to the default "Whole message".
    const accountSelect = screen.getByLabelText(/choose account/i) as HTMLSelectElement;
    fireEvent.change(accountSelect, { target: { value: 'a2' } });
    expect((screen.getByDisplayValue('Whole message (standard)') as HTMLSelectElement).value).toBe(
      'whole_message',
    );
  });
});

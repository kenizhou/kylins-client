import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AccountsPreferences } from '../../../src/components/preferences/AccountsPreferences';
import { useAccountStore } from '../../../src/stores/accountStore';

vi.mock('../../../src/services/accounts', () => ({
  getAllAccounts: vi.fn().mockResolvedValue([]),
  deleteAccount: vi.fn(),
  updateAccount: vi.fn(),
  setDefaultAccount: vi.fn(),
}));

vi.mock('../../../src/services/db/sendAsAliases', () => ({
  getMappedAliasesForAccount: vi.fn().mockResolvedValue([]),
  insertAlias: vi.fn(),
  updateAlias: vi.fn(),
  deleteAlias: vi.fn(),
  accountAsAlias: vi.fn((account) => ({
    id: `account-${account.id}`,
    email: account.email,
    displayName: account.displayName ?? null,
    replyTo: null,
    signatureId: null,
    isPrimary: true,
    isDefault: true,
    treatAsAlias: true,
    verificationStatus: 'accepted',
  })),
}));

vi.mock('../../../src/services/auth/accountSetupFlows', () => ({
  reauthorizeAccount: vi.fn(),
  testImapConnection: vi.fn(),
  testEasConnection: vi.fn(),
}));

function makeAccount(overrides: Partial<import('../../../src/types').Account> = {}) {
  return {
    id: 'a1',
    email: 'user@example.com',
    displayName: 'User',
    provider: 'imap' as const,
    authMethod: 'password',
    isActive: true,
    isDefault: true,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('AccountsPreferences', () => {
  beforeEach(() => {
    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      defaultAccountId: null,
    });
    vi.clearAllMocks();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
  });

  it('renders empty state when no accounts', async () => {
    await act(async () => {
      render(<AccountsPreferences />);
    });
    expect(screen.getByText('No accounts configured yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add account/i })).toBeInTheDocument();
  });

  it('renders account list and selects an account', async () => {
    const account = makeAccount();
    useAccountStore.setState({ accounts: [account], defaultAccountId: account.id });
    const { getAllAccounts } = await import('../../../src/services/accounts');
    vi.mocked(getAllAccounts).mockResolvedValue([account]);

    await act(async () => {
      render(<AccountsPreferences />);
    });
    expect((await screen.findAllByText('user@example.com')).length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getAllByText('user@example.com')[0]!);
    expect(screen.getByRole('button', { name: /save identity/i })).toBeInTheDocument();
  });

  it('shows default and paused badges', async () => {
    const active = makeAccount({ id: 'a1', email: 'active@example.com', isActive: true });
    const paused = makeAccount({
      id: 'a2',
      email: 'paused@example.com',
      isActive: false,
      isDefault: false,
    });
    useAccountStore.setState({ accounts: [active, paused], defaultAccountId: active.id });
    const { getAllAccounts } = await import('../../../src/services/accounts');
    vi.mocked(getAllAccounts).mockResolvedValue([active, paused]);

    await act(async () => {
      render(<AccountsPreferences />);
    });
    expect((await screen.findAllByText('active@example.com')).length).toBeGreaterThanOrEqual(1);
    expect((await screen.findAllByText('paused@example.com')).length).toBeGreaterThanOrEqual(1);
    expect((await screen.findAllByText('Default')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('removes an account after confirmation', async () => {
    const account = makeAccount();
    useAccountStore.setState({ accounts: [account], defaultAccountId: account.id });
    const { getAllAccounts, deleteAccount } = await import('../../../src/services/accounts');
    vi.mocked(getAllAccounts).mockResolvedValue([]);
    vi.mocked(deleteAccount).mockResolvedValue(undefined);

    await act(async () => {
      render(<AccountsPreferences />);
    });
    fireEvent.click((await screen.findAllByText('user@example.com'))[0]!);
    fireEvent.click(screen.getByRole('button', { name: /remove account/i }));
    await waitFor(() => {
      expect(useAccountStore.getState().accounts).toHaveLength(0);
    });
  });
});

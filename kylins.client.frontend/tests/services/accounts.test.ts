// Ported from velo (https://github.com/aviyahmenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.
//
// Task 5 cutover: accounts.ts now routes through `invoke('db_*')`. Rust owns
// encryption of the four secret fields (verified by the Rust db::accounts
// tests with a real sqlite DB), so these frontend tests no longer assert on
// encrypt/decrypt — they assert the wrapper forwards the right command + args
// and passes the Rust Account return value through unchanged.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createAccount,
  getAllAccounts,
  getAccountById,
  getAccountByEmail,
  updateAccount,
  deleteAccount,
  deleteAccountByEmail,
  getAccountCount,
  setDefaultAccount,
  getDefaultAccount,
  type CreateAccountInput,
  type AccountUpdates,
} from '../../src/services/accounts';
import { wireDefaultDbResults } from '../../src/test/mockInvoke';
import type { Account } from '../../src/types';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

function makeAccount(over: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    email: 'e@x.com',
    provider: 'imap',
    isActive: true,
    isDefault: false,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    acceptInvalidCerts: false,
    ...over,
  };
}

describe('accounts', () => {
  it('createAccount invokes db_create_account with the input payload (no FE-side encrypt)', async () => {
    const input: CreateAccountInput = {
      email: 'e@x.com',
      provider: 'imap',
      authMethod: 'password',
      imapPassword: 'secret',
      accessToken: 'tok',
      refreshToken: 'ref',
      oauthClientSecret: 'cs',
    };
    mockInvoke.mockResolvedValueOnce(makeAccount({ ...input, id: 'acc-1' }));
    const account = await createAccount(input);
    expect(mockInvoke).toHaveBeenCalledWith('db_create_account', { input });
    // The wrapper must NOT have encrypted anything — secrets are passed as
    // plaintext for Rust to encrypt.
    const forwarded = (mockInvoke.mock.calls[0]![1] as { input: CreateAccountInput }).input;
    expect(forwarded.imapPassword).toBe('secret');
    expect(forwarded.accessToken).toBe('tok');
    expect(account.id).toBe('acc-1');
  });

  it('getAllAccounts invokes db_get_all_accounts and returns the list', async () => {
    const rows = [makeAccount({ id: 'acc-1', email: 'a@x.com' })];
    mockInvoke.mockResolvedValueOnce(rows);
    const accounts = await getAllAccounts();
    expect(mockInvoke).toHaveBeenCalledWith('db_get_all_accounts');
    expect(accounts).toEqual(rows);
  });

  it('getAllAccounts returns an empty list when Rust returns []', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    const accounts = await getAllAccounts();
    expect(accounts).toEqual([]);
  });

  it('getAccountById invokes db_get_account_by_id with id', async () => {
    mockInvoke.mockResolvedValueOnce(makeAccount({ id: 'acc-1' }));
    const account = await getAccountById('acc-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_account_by_id', { id: 'acc-1' });
    expect(account?.id).toBe('acc-1');
  });

  it('getAccountById returns null when not found', async () => {
    mockInvoke.mockResolvedValueOnce(null);
    expect(await getAccountById('missing')).toBeNull();
  });

  it('getAccountByEmail invokes db_get_account_by_email with email', async () => {
    mockInvoke.mockResolvedValueOnce(makeAccount({ email: 'e@x.com' }));
    const account = await getAccountByEmail('e@x.com');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_account_by_email', { email: 'e@x.com' });
    expect(account?.email).toBe('e@x.com');
  });

  it('updateAccount invokes db_update_account with (id, updates)', async () => {
    const updates: AccountUpdates = {
      email: 'new@x.com',
      displayName: 'New',
      accessToken: 'new-tok',
      isActive: false,
    };
    await updateAccount('acc-1', updates);
    expect(mockInvoke).toHaveBeenCalledWith('db_update_account', { id: 'acc-1', updates });
    // Secrets forwarded as plaintext for Rust to encrypt.
    expect((mockInvoke.mock.calls[0]![1] as { updates: AccountUpdates }).updates.accessToken).toBe(
      'new-tok',
    );
  });

  it('deleteAccount invokes db_delete_account with id', async () => {
    await deleteAccount('acc-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_delete_account', { id: 'acc-1' });
  });

  it('deleteAccountByEmail invokes db_delete_account_by_email with email', async () => {
    await deleteAccountByEmail('e@x.com');
    expect(mockInvoke).toHaveBeenCalledWith('db_delete_account_by_email', { email: 'e@x.com' });
  });

  it('getAccountCount invokes db_get_account_count and returns the number', async () => {
    mockInvoke.mockResolvedValueOnce(3);
    const count = await getAccountCount();
    expect(mockInvoke).toHaveBeenCalledWith('db_get_account_count');
    expect(count).toBe(3);
  });

  it('setDefaultAccount invokes db_set_default_account with id', async () => {
    await setDefaultAccount('acc-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_set_default_account', { id: 'acc-1' });
  });

  it('getDefaultAccount invokes db_get_default_account and returns the account', async () => {
    mockInvoke.mockResolvedValueOnce(makeAccount({ id: 'acc-default', isDefault: true }));
    const account = await getDefaultAccount();
    expect(mockInvoke).toHaveBeenCalledWith('db_get_default_account');
    expect(account?.id).toBe('acc-default');
    expect(account?.isDefault).toBe(true);
  });

  it('getDefaultAccount returns null when there is no default', async () => {
    mockInvoke.mockResolvedValueOnce(null);
    expect(await getDefaultAccount()).toBeNull();
  });

  it('passes IMAP/EAS connection fields through to db_create_account', async () => {
    const input: CreateAccountInput = {
      email: 'user@imap.example.com',
      provider: 'imap',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapSecurity: 'tls',
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpSecurity: 'starttls',
      authMethod: 'password',
      imapPassword: 'pw',
      imapUsername: 'user',
      acceptInvalidCerts: false,
    };
    mockInvoke.mockResolvedValueOnce(makeAccount({ ...input, id: 'acc-imap' }));
    await createAccount(input);
    const forwarded = (mockInvoke.mock.calls[0]![1] as { input: CreateAccountInput }).input;
    expect(forwarded.imapHost).toBe('imap.example.com');
    expect(forwarded.imapPort).toBe(993);
    expect(forwarded.smtpHost).toBe('smtp.example.com');
  });

  it('passes EAS connection fields through to db_create_account', async () => {
    const input: CreateAccountInput = {
      email: 'user@exchange.example.com',
      provider: 'eas',
      easUrl: 'https://exchange.example.com/Microsoft-Server-ActiveSync',
      easProtocolVersion: '16.1',
      easDeviceId: 'KYLINS-DEV-001',
    };
    mockInvoke.mockResolvedValueOnce(makeAccount({ ...input, id: 'acc-eas' }));
    await createAccount(input);
    const forwarded = (mockInvoke.mock.calls[0]![1] as { input: CreateAccountInput }).input;
    expect(forwarded.easUrl).toBe('https://exchange.example.com/Microsoft-Server-ActiveSync');
    expect(forwarded.easProtocolVersion).toBe('16.1');
    expect(forwarded.easDeviceId).toBe('KYLINS-DEV-001');
  });

  it('forwards account label + setup provider id on create', async () => {
    const input: CreateAccountInput = {
      email: 'e@x.com',
      provider: 'imap',
      accountLabel: 'Work',
      setupProviderId: 'gmail',
    };
    mockInvoke.mockResolvedValueOnce(makeAccount({ ...input }));
    await createAccount(input);
    const forwarded = (mockInvoke.mock.calls[0]![1] as { input: CreateAccountInput }).input;
    expect(forwarded.accountLabel).toBe('Work');
    expect(forwarded.setupProviderId).toBe('gmail');
  });
});

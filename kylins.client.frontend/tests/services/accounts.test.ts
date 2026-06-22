import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAccount, getAllAccounts, getAccountById, updateAccount, deleteAccount } from '../../src/services/accounts';
import { getDb } from '../../src/services/db/connection';

vi.mock('../../src/services/db/connection', () => ({
  getDb: vi.fn(),
}));

const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as any);
  mockDb.select.mockReset();
  mockDb.execute.mockReset();
});

describe('accounts', () => {
  it('creates an account', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    const account = await createAccount({
      email: 'test@example.com',
      provider: 'eas',
    });
    expect(account.email).toBe('test@example.com');
    expect(account.provider).toBe('eas');
    expect(account.isActive).toBe(true);
  });

  it('lists all accounts', async () => {
    mockDb.select.mockResolvedValue([
      {
        id: 'acc-1',
        email: 'test@example.com',
        provider: 'eas',
        is_active: 1,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    const accounts = await getAllAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe('test@example.com');
  });

  it('gets an account by id', async () => {
    mockDb.select.mockResolvedValue([
      {
        id: 'acc-1',
        email: 'test@example.com',
        display_name: 'Test User',
        provider: 'gmail_api',
        provider_config: JSON.stringify({ clientId: 'abc' }),
        access_token: 'tok',
        refresh_token: 'ref',
        token_expires_at: 1234567890,
        is_active: 1,
        created_at: 1,
        updated_at: 2,
      },
    ]);
    const account = await getAccountById('acc-1');
    expect(account).not.toBeNull();
    expect(account!.id).toBe('acc-1');
    expect(account!.email).toBe('test@example.com');
    expect(account!.displayName).toBe('Test User');
    expect(account!.provider).toBe('gmail_api');
    expect(account!.providerConfig).toEqual({ clientId: 'abc' });
    expect(account!.accessToken).toBe('tok');
    expect(account!.refreshToken).toBe('ref');
    expect(account!.tokenExpiresAt).toBe(1234567890);
    expect(account!.isActive).toBe(true);
    expect(account!.createdAt).toBe(1);
    expect(account!.updatedAt).toBe(2);
  });

  it('returns null when account not found', async () => {
    mockDb.select.mockResolvedValue([]);
    const account = await getAccountById('missing');
    expect(account).toBeNull();
  });

  it('updates an account', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await updateAccount('acc-1', {
      email: 'new@example.com',
      displayName: 'New Name',
      provider: 'imap',
      providerConfig: { host: 'imap.example.com' },
      accessToken: 'new-tok',
      refreshToken: 'new-ref',
      tokenExpiresAt: 9999999999,
      isActive: false,
    });
    expect(mockDb.execute).toHaveBeenCalledOnce();
    const [sql, params] = mockDb.execute.mock.calls[0];
    expect(sql).toContain('UPDATE accounts SET');
    expect(sql).toContain('email = $1');
    expect(sql).toContain('display_name = $2');
    expect(sql).toContain('provider = $3');
    expect(sql).toContain('provider_config = $4');
    expect(sql).toContain('access_token = $5');
    expect(sql).toContain('refresh_token = $6');
    expect(sql).toContain('token_expires_at = $7');
    expect(sql).toContain('is_active = $8');
    expect(sql).toContain('updated_at = $9');
    expect(sql).toContain('WHERE id = $10');
    expect(params).toEqual([
      'new@example.com',
      'New Name',
      'imap',
      JSON.stringify({ host: 'imap.example.com' }),
      'new-tok',
      'new-ref',
      9999999999,
      0,
      expect.any(Number),
      'acc-1',
    ]);
  });

  it('deletes an account', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await deleteAccount('acc-1');
    expect(mockDb.execute).toHaveBeenCalledOnce();
    const [sql, params] = mockDb.execute.mock.calls[0];
    expect(sql).toBe('DELETE FROM accounts WHERE id = $1');
    expect(params).toEqual(['acc-1']);
  });
});

// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createAccount,
  getAllAccounts,
  getAccountById,
  updateAccount,
  deleteAccount,
  type CreateAccountInput,
} from '../../src/services/accounts';
import { getDb } from '../../src/services/db/connection';
import { encryptSecret, decryptSecret } from '../../src/services/crypto';
import type Database from '@tauri-apps/plugin-sql';

vi.mock('../../src/services/db/connection', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../src/services/crypto', () => ({
  encryptSecret: vi.fn((plain: string) => Promise.resolve(`enc:${plain}`)),
  decryptSecret: vi.fn((cipher: string) => Promise.resolve(cipher.replace(/^enc:/, ''))),
}));

const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Database);
  mockDb.select.mockReset();
  mockDb.execute.mockReset();
});

describe('accounts', () => {
  it('encrypts secret fields on create', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    mockDb.select.mockResolvedValue([
      {
        id: 'a',
        email: 'e@x.com',
        provider: 'imap',
        is_active: 1,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    await createAccount({
      email: 'e@x.com',
      provider: 'imap',
      authMethod: 'password',
      imapPassword: 'secret',
      accessToken: 'tok',
      refreshToken: 'ref',
      oauthClientSecret: 'cs',
    } satisfies CreateAccountInput);
    const params = mockDb.execute.mock.calls[0][1] as unknown[];
    // encrypted values written, never plaintext
    expect(params).toContain('enc:secret');
    expect(params).toContain('enc:tok');
    expect(params).toContain('enc:ref');
    expect(params).toContain('enc:cs');
    expect(params).not.toContain('secret');
    expect(encryptSecret).toHaveBeenCalledWith('secret');
  });

  it('decrypts secret fields on read', async () => {
    mockDb.select.mockResolvedValue([
      {
        id: 'a',
        email: 'e@x.com',
        provider: 'imap',
        auth_method: 'password',
        imap_password: 'enc:secret',
        access_token: 'enc:tok',
        refresh_token: 'enc:ref',
        is_active: 1,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    const account = await getAccountById('a');
    expect(account!.imapPassword).toBe('secret');
    expect(account!.accessToken).toBe('tok');
    expect(account!.refreshToken).toBe('ref');
    expect(decryptSecret).toHaveBeenCalledWith('enc:secret');
  });

  it('creates an account', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
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
    expect(account!.accessToken).toBe('tok');
    expect(account!.refreshToken).toBe('ref');
    expect(account!.tokenExpiresAt).toBe(1234567890);
    expect(account!.isActive).toBe(true);
    expect(account!.createdAt).toBe(1);
    expect(account!.updatedAt).toBe(2);
  });

  it('gets an IMAP account with connection settings', async () => {
    mockDb.select.mockResolvedValue([
      {
        id: 'acc-imap',
        email: 'user@imap.example.com',
        provider: 'imap',
        imap_host: 'imap.example.com',
        imap_port: 993,
        imap_security: 'tls',
        smtp_host: 'smtp.example.com',
        smtp_port: 587,
        smtp_security: 'starttls',
        auth_method: 'password',
        imap_password: 'secret',
        accept_invalid_certs: 0,
        is_active: 1,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    const account = await getAccountById('acc-imap');
    expect(account).not.toBeNull();
    expect(account!.imapHost).toBe('imap.example.com');
    expect(account!.imapPort).toBe(993);
    expect(account!.imapSecurity).toBe('tls');
    expect(account!.smtpHost).toBe('smtp.example.com');
    expect(account!.authMethod).toBe('password');
    expect(account!.imapPassword).toBe('secret');
    expect(account!.acceptInvalidCerts).toBe(false);
  });

  it('gets an EAS account with connection settings', async () => {
    mockDb.select.mockResolvedValue([
      {
        id: 'acc-eas',
        email: 'user@exchange.example.com',
        provider: 'eas',
        eas_url: 'https://exchange.example.com/Microsoft-Server-ActiveSync',
        eas_protocol_version: '16.1',
        eas_device_id: 'KYLINS-DEV-001',
        is_active: 1,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    const account = await getAccountById('acc-eas');
    expect(account).not.toBeNull();
    expect(account!.easUrl).toBe('https://exchange.example.com/Microsoft-Server-ActiveSync');
    expect(account!.easProtocolVersion).toBe('16.1');
    expect(account!.easDeviceId).toBe('KYLINS-DEV-001');
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
    expect(sql).toContain('access_token = $4');
    expect(sql).toContain('refresh_token = $5');
    expect(sql).toContain('token_expires_at = $6');
    expect(sql).toContain('is_active = $7');
    expect(sql).toContain('updated_at = $8');
    expect(sql).toContain('WHERE id = $9');
    expect(params).toEqual([
      'new@example.com',
      'New Name',
      'imap',
      'enc:new-tok',
      'enc:new-ref',
      9999999999,
      0,
      expect.any(Number),
      'acc-1',
    ]);
  });

  it('updates an IMAP account with connection settings', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await updateAccount('acc-imap', {
      imapHost: 'new.imap.example.com',
      imapPort: 993,
      imapSecurity: 'tls',
      smtpHost: 'new.smtp.example.com',
      smtpPort: 465,
      smtpSecurity: 'tls',
      authMethod: 'password',
      imapPassword: 'new-secret',
    });
    expect(mockDb.execute).toHaveBeenCalledOnce();
    const [sql] = mockDb.execute.mock.calls[0];
    expect(sql).toContain('imap_host =');
    expect(sql).toContain('imap_port =');
    expect(sql).toContain('imap_security =');
    expect(sql).toContain('smtp_host =');
    expect(sql).toContain('smtp_port =');
    expect(sql).toContain('smtp_security =');
    expect(sql).toContain('auth_method =');
    expect(sql).toContain('imap_password =');
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

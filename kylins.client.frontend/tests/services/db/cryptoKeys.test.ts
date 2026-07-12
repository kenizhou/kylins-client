// Task 4: cryptoKeys.ts invoke wrappers. Mock `invoke` and assert each
// wrapper forwards the right Tauri command name + camelCase arg shape and
// passes the Rust return value through unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import {
  listCryptoKeysForAccount,
  getCryptoKey,
  generateKey,
  importKeyFromPath,
  exportPublicToPath,
  deleteCryptoKey,
  setDefaultSigningKey,
  type CryptoKeyRow,
} from '@/services/db/cryptoKeys';

beforeEach(() => vi.mocked(invoke).mockClear());

describe('cryptoKeys service wrappers', () => {
  it('listCryptoKeysForAccount invokes db_list_crypto_keys_for_account with camelCase args', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await listCryptoKeysForAccount('acct', 'smime');
    expect(invoke).toHaveBeenCalledWith('db_list_crypto_keys_for_account', {
      accountId: 'acct',
      standard: 'smime',
    });
  });

  it('getCryptoKey invokes db_get_crypto_key with standard + fingerprint', async () => {
    const row: CryptoKeyRow | null = null;
    vi.mocked(invoke).mockResolvedValue(row);
    await getCryptoKey('smime', 'fp');
    expect(invoke).toHaveBeenCalledWith('db_get_crypto_key', {
      standard: 'smime',
      fingerprint: 'fp',
    });
  });

  it('generateKey invokes crypto_generate_key', async () => {
    vi.mocked(invoke).mockResolvedValue({
      id: 'x',
      standard: 'smime',
      fingerprint: 'fp',
      hasPrivate: true,
    });
    await generateKey('acct', 'owner@k');
    expect(invoke).toHaveBeenCalledWith('crypto_generate_key', {
      accountId: 'acct',
      email: 'owner@k',
    });
  });

  it('importKeyFromPath invokes crypto_import_key_from_path', async () => {
    vi.mocked(invoke).mockResolvedValue({
      id: 'x',
      standard: 'smime',
      fingerprint: 'fp',
      hasPrivate: true,
    });
    await importKeyFromPath('acct', '/path/to/key.p12');
    expect(invoke).toHaveBeenCalledWith('crypto_import_key_from_path', {
      accountId: 'acct',
      path: '/path/to/key.p12',
    });
  });

  it('exportPublicToPath invokes crypto_export_public_to_path', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await exportPublicToPath('acct', 'smime', 'fp', '/out/pub.pem');
    expect(invoke).toHaveBeenCalledWith('crypto_export_public_to_path', {
      accountId: 'acct',
      standard: 'smime',
      fingerprint: 'fp',
      outPath: '/out/pub.pem',
    });
  });

  it('deleteCryptoKey invokes db_delete_crypto_key', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await deleteCryptoKey('acct', 'smime', 'fp');
    expect(invoke).toHaveBeenCalledWith('db_delete_crypto_key', {
      accountId: 'acct',
      standard: 'smime',
      fingerprint: 'fp',
    });
  });

  it('setDefaultSigningKey invokes the transactional command', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await setDefaultSigningKey('acct', 'smime', 'fp');
    expect(invoke).toHaveBeenCalledWith('db_set_default_signing_key', {
      accountId: 'acct',
      standard: 'smime',
      fingerprint: 'fp',
    });
  });
});

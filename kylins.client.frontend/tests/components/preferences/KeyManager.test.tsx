// Task 5 (Plan 4b): KeyManagerSection UI tests.
//
// Verifies the S/MIME key manager section:
//   - lists keys returned by `listCryptoKeysForAccount`
//   - Import button → `open()` (plugin-dialog) → `importKeyFromPath(accountId, path)`
//   - Generate button → `generateKey(accountId, email)` (email from account store)
//   - Set default button → `setDefaultSigningKey(accountId, 'smime', fingerprint)`
//   - Delete button (after confirm) → `deleteCryptoKey(accountId, 'smime', fingerprint)`
//   - Export button → `save()` (plugin-dialog) → `exportPublicToPath(accountId, 'smime', fingerprint, path)`
//
// Mirrors AccountsPreferences.test.tsx: relative-path `vi.mock`, real Zustand
// stores seeded via `setState`, `fireEvent` for clicks, `findByText`/`waitFor`
// for async list load.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { KeyManagerSection } from '../../../src/components/preferences/KeyManagerSection';
import { useAccountStore } from '../../../src/stores/accountStore';
import type { CryptoKeyRow } from '../../../src/services/db/cryptoKeys';

// Mock the crypto-keys service — these are the units under interaction.
vi.mock('../../../src/services/db/cryptoKeys', () => ({
  listCryptoKeysForAccount: vi.fn().mockResolvedValue([]),
  getCryptoKey: vi.fn(),
  generateKey: vi.fn().mockResolvedValue(undefined),
  importKeyFromPath: vi.fn().mockResolvedValue(undefined),
  exportPublicToPath: vi.fn().mockResolvedValue(undefined),
  deleteCryptoKey: vi.fn().mockResolvedValue(undefined),
  setDefaultSigningKey: vi.fn().mockResolvedValue(undefined),
}));

// Mock the Tauri dialog plugin — returns deterministic paths.
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));

function makeKey(overrides: Partial<CryptoKeyRow> = {}): CryptoKeyRow {
  return {
    id: 'k1',
    accountId: 'acct',
    standard: 'smime',
    keyType: 'cert',
    email: 'user@example.com',
    fingerprint: 'fp1abcdef0123456789',
    origin: 'generated',
    isDefaultSign: false,
    isDefaultEncrypt: false,
    createdAt: '1700000000',
    expiresAt: null,
    hasPrivate: true,
    ...overrides,
  };
}

async function renderWithKeys(keys: CryptoKeyRow[]) {
  const { listCryptoKeysForAccount } = await import('../../../src/services/db/cryptoKeys');
  vi.mocked(listCryptoKeysForAccount).mockResolvedValue(keys);
  await act(async () => {
    render(<KeyManagerSection accountId="acct" />);
  });
}

describe('KeyManagerSection', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );

    // Seed the account store so `generateKey` can resolve the account email.
    useAccountStore.setState({
      accounts: [
        {
          id: 'acct',
          email: 'user@example.com',
          displayName: 'Tester',
          provider: 'imap',
          isActive: true,
          isDefault: true,
          sortOrder: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeAccountId: 'acct',
      defaultAccountId: 'acct',
    });

    const { listCryptoKeysForAccount } = await import('../../../src/services/db/cryptoKeys');
    vi.mocked(listCryptoKeysForAccount).mockResolvedValue([]);
    // Re-set default dialog returns after clearAllMocks wipes implementations.
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.open).mockResolvedValue(null);
    vi.mocked(dialog.save).mockResolvedValue(null);
  });

  it('renders empty state when account has no keys', async () => {
    await renderWithKeys([]);
    expect(await screen.findByText(/no s\/mime keys yet/i)).toBeInTheDocument();
  });

  it('lists keys with fingerprint, email, and Default chip', async () => {
    await renderWithKeys([
      makeKey({ fingerprint: 'fpAAA111', isDefaultSign: true, email: 'alice@example.com' }),
      makeKey({ id: 'k2', fingerprint: 'fpBBB222', isDefaultSign: false, hasPrivate: false }),
    ]);
    expect(await screen.findByText(/fpAAA111/i)).toBeInTheDocument();
    expect(screen.getByText(/fpBBB222/i)).toBeInTheDocument();
    // Default chip only on default key.
    const defaults = screen.getAllByText(/^Default$/i);
    expect(defaults).toHaveLength(1);
  });

  it('Import button calls importKeyFromPath with the picked path', async () => {
    await renderWithKeys([]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.open).mockResolvedValue('/fake/cert.pem');
    const { importKeyFromPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/no s\/mime keys yet/i);
    fireEvent.click(screen.getByRole('button', { name: /import pem/i }));
    await waitFor(() => {
      expect(importKeyFromPath).toHaveBeenCalledWith('acct', '/fake/cert.pem');
    });
  });

  it('Import ignores a cancelled dialog (null path)', async () => {
    await renderWithKeys([]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.open).mockResolvedValue(null);
    const { importKeyFromPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/no s\/mime keys yet/i);
    fireEvent.click(screen.getByRole('button', { name: /import pem/i }));
    // Give the click handler a tick to resolve.
    await waitFor(() => {
      expect(dialog.open).toHaveBeenCalled();
    });
    expect(importKeyFromPath).not.toHaveBeenCalled();
  });

  it('Generate button calls generateKey with accountId and account email', async () => {
    await renderWithKeys([]);
    const { generateKey } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/no s\/mime keys yet/i);
    fireEvent.click(screen.getByRole('button', { name: /generate self-signed/i }));
    await waitFor(() => {
      expect(generateKey).toHaveBeenCalledWith('acct', 'user@example.com');
    });
  });

  it('Set default button calls setDefaultSigningKey', async () => {
    await renderWithKeys([makeKey({ fingerprint: 'fpCCC333', isDefaultSign: false })]);
    const { setDefaultSigningKey } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/fpCCC333/i);
    fireEvent.click(screen.getByRole('button', { name: /set default/i }));
    await waitFor(() => {
      expect(setDefaultSigningKey).toHaveBeenCalledWith('acct', 'smime', 'fpCCC333');
    });
  });

  it('Delete button calls deleteCryptoKey after confirm', async () => {
    await renderWithKeys([makeKey({ fingerprint: 'fpDDD444' })]);
    const { deleteCryptoKey } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/fpDDD444/i);
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => {
      expect(deleteCryptoKey).toHaveBeenCalledWith('acct', 'smime', 'fpDDD444');
    });
    expect(window.confirm).toHaveBeenCalled();
  });

  it('Delete is cancelled when confirm returns false', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await renderWithKeys([makeKey({ fingerprint: 'fpEEE555' })]);
    const { deleteCryptoKey } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/fpEEE555/i);
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
    });
    expect(deleteCryptoKey).not.toHaveBeenCalled();
  });

  it('Export button calls save() then exportPublicToPath', async () => {
    await renderWithKeys([makeKey({ fingerprint: 'fpFFF666' })]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.save).mockResolvedValue('/out/cert.der');
    const { exportPublicToPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/fpFFF666/i);
    fireEvent.click(screen.getByRole('button', { name: /export/i }));
    await waitFor(() => {
      expect(exportPublicToPath).toHaveBeenCalledWith('acct', 'smime', 'fpFFF666', '/out/cert.der');
    });
  });
});

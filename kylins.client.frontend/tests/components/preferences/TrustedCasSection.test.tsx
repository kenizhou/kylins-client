// G6 Task 6: TrustedCasSection UI tests.
//
// Verifies the "Trusted CAs" subsection of SecurityPreferences:
//   - lists ONLY keyType='cert' rows (CA roots), filtered out from
//     `listCryptoKeysForAccount` (which returns the full set).
//   - Import PEM button → open() (plugin-dialog) → readTextFile (plugin-fs)
//     → importTrustAnchorFromPath(accountId, path).
//   - Delete button (after window.confirm) → deleteCryptoKey(accountId,
//     'smime', fingerprint).
//   - No "Set default" / "Export" buttons (CA roots are trust anchors, not
//     signing identities).
//
// Mirrors KeyManager.test.tsx: relative-path `vi.mock`, real Zustand stores
// seeded via `setState`, `fireEvent` for clicks, `findByText`/`waitFor` for
// async list load.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { TrustedCasSection } from '../../../src/components/preferences/TrustedCasSection';
import { useAccountStore } from '../../../src/stores/accountStore';
import type { CryptoKeyRow } from '../../../src/services/db/cryptoKeys';

// Mock the crypto-keys service — the units under interaction. The Trusted CAs
// section consumes `listCryptoKeysForAccount` + `deleteCryptoKey` directly, and
// `importTrustAnchorFromPath` for the PEM import path (which internally PEM→DER
// →sha256→hex + upserts a key_type='cert' row).
vi.mock('../../../src/services/db/cryptoKeys', () => ({
  listCryptoKeysForAccount: vi.fn().mockResolvedValue([]),
  deleteCryptoKey: vi.fn().mockResolvedValue(undefined),
  importTrustAnchorFromPath: vi.fn().mockResolvedValue(undefined),
}));

// Mock the Tauri dialog plugin — returns deterministic paths. The Import flow
// picks a file via `open()`; the section never calls `save()` (no export).
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));

function makeRow(overrides: Partial<CryptoKeyRow> = {}): CryptoKeyRow {
  return {
    id: 'k1',
    accountId: 'acct',
    standard: 'smime',
    keyType: 'cert',
    email: null,
    fingerprint: 'fpCAabcdef0123456789',
    origin: 'imported',
    isDefaultSign: false,
    isDefaultEncrypt: false,
    createdAt: '1700000000',
    expiresAt: null,
    hasPrivate: false,
    ...overrides,
  };
}

async function renderWithRows(rows: CryptoKeyRow[]) {
  const { listCryptoKeysForAccount } = await import('../../../src/services/db/cryptoKeys');
  vi.mocked(listCryptoKeysForAccount).mockResolvedValue(rows);
  await act(async () => {
    render(<TrustedCasSection accountId="acct" />);
  });
}

describe('TrustedCasSection', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );

    // Seed the account store so the in-section picker has at least one account
    // when no accountId prop is supplied.
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
  });

  it('renders empty state when account has no CA roots', async () => {
    await renderWithRows([]);
    expect(await screen.findByText(/no trusted ca roots yet/i)).toBeInTheDocument();
  });

  it('lists only keyType=cert rows (filters out signing keys)', async () => {
    // listCryptoKeysForAccount returns ALL rows; section must filter to cert.
    await renderWithRows([
      makeRow({ id: 'ca1', fingerprint: 'fpCA1111', keyType: 'cert' }),
      makeRow({ id: 'priv1', fingerprint: 'fpPRIV22', keyType: 'private', hasPrivate: true }),
      makeRow({ id: 'ca2', fingerprint: 'fpCA2222', keyType: 'cert' }),
    ]);
    expect(await screen.findByText(/fpCA1111/i)).toBeInTheDocument();
    expect(screen.getByText(/fpCA2222/i)).toBeInTheDocument();
    // The private signing key must NOT appear in the Trusted CAs list.
    expect(screen.queryByText(/fpPRIV22/i)).not.toBeInTheDocument();
  });

  it('Import button calls importTrustAnchorFromPath with the picked path', async () => {
    await renderWithRows([]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.open).mockResolvedValue('/fake/ca.pem');
    const { importTrustAnchorFromPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/no trusted ca roots yet/i);
    fireEvent.click(screen.getByRole('button', { name: /import ca.*pem/i }));
    await waitFor(() => {
      expect(importTrustAnchorFromPath).toHaveBeenCalledWith('acct', '/fake/ca.pem');
    });
  });

  it('Import ignores a cancelled dialog (null path)', async () => {
    await renderWithRows([]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.open).mockResolvedValue(null);
    const { importTrustAnchorFromPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/no trusted ca roots yet/i);
    fireEvent.click(screen.getByRole('button', { name: /import ca.*pem/i }));
    await waitFor(() => {
      expect(dialog.open).toHaveBeenCalled();
    });
    expect(importTrustAnchorFromPath).not.toHaveBeenCalled();
  });

  it('Delete button calls deleteCryptoKey after confirm', async () => {
    await renderWithRows([makeRow({ id: 'ca1', fingerprint: 'fpDEL111' })]);
    const { deleteCryptoKey } = await import('../../../src/services/db/cryptoKeys');

    expect(await screen.findByText(/fpDEL111/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => {
      expect(deleteCryptoKey).toHaveBeenCalledWith('acct', 'smime', 'fpDEL111');
    });
    expect(window.confirm).toHaveBeenCalled();
  });

  it('Delete is cancelled when confirm returns false', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await renderWithRows([makeRow({ id: 'ca1', fingerprint: 'fpCANCEL1' })]);
    const { deleteCryptoKey } = await import('../../../src/services/db/cryptoKeys');

    expect(await screen.findByText(/fpCANCEL1/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
    });
    expect(deleteCryptoKey).not.toHaveBeenCalled();
  });

  it('does NOT render signing-key actions (Set default / Export)', async () => {
    await renderWithRows([makeRow({ id: 'ca1', fingerprint: 'fpNOTPRIV1' })]);
    expect(await screen.findByText(/fpNOTPRIV1/i)).toBeInTheDocument();
    // CA roots are not signing identities — these actions don't apply.
    expect(screen.queryByRole('button', { name: /set default/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export/i })).not.toBeInTheDocument();
  });
});

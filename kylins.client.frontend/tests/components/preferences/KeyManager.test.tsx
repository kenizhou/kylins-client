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
  exportP12ToPath: vi.fn().mockResolvedValue(undefined),
  deleteCryptoKey: vi.fn().mockResolvedValue(undefined),
  setDefaultSigningKey: vi.fn().mockResolvedValue(undefined),
}));

// Mock the Tauri dialog plugin — returns deterministic paths.
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));

// Mock the Tauri fs plugin — `readTextFile` is used by `onImport` to sniff
// whether a picked PEM file contains an `ENCRYPTED PRIVATE KEY` block.
// Defaults to a rejected promise so any test that doesn't care about the
// PEM path falls through to "read failed → skip prompt → runImport".
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn().mockRejectedValue(new Error('not configured')),
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
    // Default the fs read to "fails" so tests that don't exercise the PEM
    // sniff get the same behavior as a binary `.crt` (skip prompt → runImport).
    const fs = await import('@tauri-apps/plugin-fs');
    vi.mocked(fs.readTextFile).mockRejectedValue(new Error('not configured'));
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

  it('Import button calls importKeyFromPath with the picked path (no passphrase for PEM)', async () => {
    await renderWithKeys([]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.open).mockResolvedValue('/fake/cert.pem');
    const { importKeyFromPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/no s\/mime keys yet/i);
    fireEvent.click(screen.getByRole('button', { name: /import pem/i }));
    await waitFor(() => {
      // PEM path: no passphrase prompt, undefined forwards to Rust `None`.
      expect(importKeyFromPath).toHaveBeenCalledWith('acct', '/fake/cert.pem', undefined);
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

  it('Import .p12 opens passphrase prompt; submitting calls importKeyFromPath with the passphrase', async () => {
    await renderWithKeys([]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.open).mockResolvedValue('/fake/bundle.p12');
    const { importKeyFromPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/no s\/mime keys yet/i);
    fireEvent.click(screen.getByRole('button', { name: /import pem/i }));

    // The passphrase prompt modal must open (controlled by the section's
    // pendingPassphrasePath state).
    const passphraseInput = await screen.findByPlaceholderText(/bundle passphrase/i);
    expect(passphraseInput).toBeInTheDocument();

    // Type + submit; the importKeyFromPath wrapper must receive the passphrase.
    fireEvent.change(passphraseInput, { target: { value: 'test-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /^OK$/i }));

    await waitFor(() => {
      expect(importKeyFromPath).toHaveBeenCalledWith('acct', '/fake/bundle.p12', 'test-secret');
    });
  });

  it('Import .pfx opens passphrase prompt; cancelling does NOT call importKeyFromPath', async () => {
    await renderWithKeys([]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.open).mockResolvedValue('/fake/bundle.pfx');
    const { importKeyFromPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/no s\/mime keys yet/i);
    fireEvent.click(screen.getByRole('button', { name: /import pem/i }));

    const passphraseInput = await screen.findByPlaceholderText(/bundle passphrase/i);
    expect(passphraseInput).toBeInTheDocument();

    // Cancel — the pending path is cleared and importKeyFromPath never fires.
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => {
      expect(importKeyFromPath).not.toHaveBeenCalled();
    });
  });

  // ── I1: encrypted-PKCS#8 PEM content sniff ───────────────────────────────
  //
  // The `.p12`/`.pfx` extension gate always promptsed. The new behavior also
  // prompts when a picked PEM file contains an `ENCRYPTED PRIVATE KEY` block
  // — the backend fully supports that arm but ONLY when a passphrase is
  // supplied (otherwise it returns `Policy("encrypted PKCS#8 requires a
  // passphrase")`). The UI sniffs the file content via `readTextFile`.

  it('Import encrypted-PKCS#8 PEM opens the passphrase prompt (content sniff)', async () => {
    await renderWithKeys([]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.open).mockResolvedValue('/fake/identity.pem');
    const fs = await import('@tauri-apps/plugin-fs');
    vi.mocked(fs.readTextFile).mockResolvedValue(
      [
        '-----BEGIN ENCRYPTED PRIVATE KEY-----',
        'MIIE6TAbBgkqhkiG9w0BBQMwDgQI...',
        '-----END ENCRYPTED PRIVATE KEY-----',
        '-----BEGIN CERTIFICATE-----',
        'MIIB...',
        '-----END CERTIFICATE-----',
      ].join('\n'),
    );
    const { importKeyFromPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/no s\/mime keys yet/i);
    fireEvent.click(screen.getByRole('button', { name: /import pem/i }));

    // The passphrase prompt must open (encrypted PEM detected by content).
    const passphraseInput = await screen.findByPlaceholderText(/bundle passphrase/i);
    expect(passphraseInput).toBeInTheDocument();
    // And the import has NOT been called yet (waiting on the passphrase).
    expect(importKeyFromPath).not.toHaveBeenCalled();
    // The sniff read the picked file exactly once.
    expect(fs.readTextFile).toHaveBeenCalledWith('/fake/identity.pem');
  });

  it('Import plain PEM (CERTIFICATE + unencrypted PRIVATE KEY) does NOT open the prompt', async () => {
    await renderWithKeys([]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.open).mockResolvedValue('/fake/plain.pem');
    const fs = await import('@tauri-apps/plugin-fs');
    vi.mocked(fs.readTextFile).mockResolvedValue(
      [
        '-----BEGIN CERTIFICATE-----',
        'MIIB...',
        '-----END CERTIFICATE-----',
        '-----BEGIN PRIVATE KEY-----',
        'MIGH...',
        '-----END PRIVATE KEY-----',
      ].join('\n'),
    );
    const { importKeyFromPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/no s\/mime keys yet/i);
    fireEvent.click(screen.getByRole('button', { name: /import pem/i }));

    // Plain PEM: no prompt; import called with undefined passphrase.
    await waitFor(() => {
      expect(importKeyFromPath).toHaveBeenCalledWith('acct', '/fake/plain.pem', undefined);
    });
    expect(screen.queryByPlaceholderText(/bundle passphrase/i)).toBeNull();
  });

  it('Import PEM falls back to no-prompt when the fs read fails (binary .crt / permission)', async () => {
    await renderWithKeys([]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.open).mockResolvedValue('/fake/strange.crt');
    const fs = await import('@tauri-apps/plugin-fs');
    vi.mocked(fs.readTextFile).mockRejectedValue(new Error('permission denied'));
    const { importKeyFromPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/no s\/mime keys yet/i);
    fireEvent.click(screen.getByRole('button', { name: /import pem/i }));

    // Read failed → skip the prompt and let the backend surface any real
    // error. Import IS attempted with an undefined passphrase.
    await waitFor(() => {
      expect(importKeyFromPath).toHaveBeenCalledWith('acct', '/fake/strange.crt', undefined);
    });
    expect(screen.queryByPlaceholderText(/bundle passphrase/i)).toBeNull();
  });

  // ── M1: global Enter handler must not misfire on Cancel ─────────────────
  //
  // Regression: `PassphrasePrompt` previously had BOTH a `<form onSubmit>`
  // (Enter from the input submits correctly) AND a `window.addEventListener
  // ('keydown', …)` global Enter handler. When focus was on the Cancel
  // button, pressing Enter fired the global handler → `onSubmit(value)` →
  // import was attempted even though the user intended to cancel. The fix
  // removes the global Enter handler; Enter only submits when typed in the
  // input (form onSubmit).

  it('Pressing Enter while the Cancel button has focus does NOT submit (M1)', async () => {
    await renderWithKeys([]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.open).mockResolvedValue('/fake/bundle.p12');
    const { importKeyFromPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/no s\/mime keys yet/i);
    fireEvent.click(screen.getByRole('button', { name: /import pem/i }));

    const passphraseInput = await screen.findByPlaceholderText(/bundle passphrase/i);
    // Type a non-empty value so the legacy global handler (if still present)
    // would call `onSubmit(value)`.
    fireEvent.change(passphraseInput, { target: { value: 'test-secret' } });

    // Move focus to the Cancel button — the user's intent is to cancel.
    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    cancelBtn.focus();
    expect(document.activeElement).toBe(cancelBtn);

    // Dispatch Enter directly on `window`, where the (buggy) global listener
    // was attached. This deterministically reproduces the bug in jsdom;
    // `fireEvent.keyDown(cancelBtn, …)` can short-circuit inside RAC's
    // Button before bubbling, masking the regression.
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    window.dispatchEvent(evt);

    // Drain any queued microtasks so a would-be submit would have fired.
    await Promise.resolve();
    await Promise.resolve();
    expect(importKeyFromPath).not.toHaveBeenCalled();
  });

  // Note: the "Enter in the input submits" path is exercised by the existing
  // ".p12 opens passphrase prompt; submitting calls importKeyFromPath" test
  // above (clicking the OK button triggers the same `<form onSubmit>` that a
  // real-browser Enter from the input would trigger — jsdom does not simulate
  // the native "Enter in a single-input form submits" behavior, so we rely on
  // the click-OK test + manual verification for the submit arm).

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
    // The DER-export button's accessible name is the exact "Export"
    // (aria-label); the .p12 button's is "Export .p12". Pin to the exact
    // name so this test doesn't also match the .p12 export button.
    fireEvent.click(screen.getByRole('button', { name: /^Export$/ }));
    await waitFor(() => {
      expect(exportPublicToPath).toHaveBeenCalledWith('acct', 'smime', 'fpFFF666', '/out/cert.der');
    });
  });

  // ── Plan 3b: Export .p12 (identity backup) ───────────────────────────────
  //
  // The export mirror of the import flow: confirm-passphrase prompt (TWO
  // inputs that must match — the user is creating a passphrase that protects
  // a private key backup, so a typo would lock them out) → save dialog →
  // exportP12ToPath. The button is disabled for cert-only / public-only rows.

  it('Export .p12 button is disabled when the row has no private key', async () => {
    await renderWithKeys([makeKey({ id: 'k-pub', fingerprint: 'fpPUB001', hasPrivate: false })]);
    await screen.findByText(/fpPUB001/i);
    const exportP12Btn = screen.getByRole('button', { name: /export \.p12/i });
    expect(exportP12Btn).toBeDisabled();
  });

  it('Export .p12 button is enabled when the row has a private key', async () => {
    await renderWithKeys([makeKey({ id: 'k-priv', fingerprint: 'fpPRV001', hasPrivate: true })]);
    await screen.findByText(/fpPRV001/i);
    const exportP12Btn = screen.getByRole('button', { name: /export \.p12/i });
    expect(exportP12Btn).not.toBeDisabled();
  });

  it('Export .p12 opens the confirm-passphrase prompt with two inputs', async () => {
    await renderWithKeys([makeKey({ fingerprint: 'fpGGG777', hasPrivate: true })]);
    await screen.findByText(/fpGGG777/i);

    fireEvent.click(screen.getByRole('button', { name: /export \.p12/i }));

    // Primary passphrase input + confirm input both render.
    const primary = await screen.findByPlaceholderText(/bundle passphrase/i);
    const confirm = await screen.findByPlaceholderText(/re-enter passphrase/i);
    expect(primary).toBeInTheDocument();
    expect(confirm).toBeInTheDocument();
  });

  it('Export .p12 with matching passphrases → save dialog → exportP12ToPath', async () => {
    await renderWithKeys([
      makeKey({ fingerprint: 'fpHHH888', email: 'hank@example.com', hasPrivate: true }),
    ]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.save).mockResolvedValue('/out/identity.p12');
    const { exportP12ToPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/fpHHH888/i);
    // Use the exact accessible name (aria-label). Regex escaping of the period
    // should work too, but jsdom's accessible-name computation occasionally
    // normalizes whitespace; pin to the exact string for stability.
    fireEvent.click(screen.getByRole('button', { name: 'Export .p12' }));

    // Type matching passphrases in both inputs.
    const primary = await screen.findByPlaceholderText(/bundle passphrase/i);
    const confirm = await screen.findByPlaceholderText(/re-enter passphrase/i);
    fireEvent.change(primary, { target: { value: 'backup-pass' } });
    fireEvent.change(confirm, { target: { value: 'backup-pass' } });

    fireEvent.click(screen.getByRole('button', { name: /^OK$/i }));

    await waitFor(() => {
      expect(exportP12ToPath).toHaveBeenCalledWith(
        'acct',
        'smime',
        'fpHHH888',
        'backup-pass',
        '/out/identity.p12',
      );
    });
  });

  it('Export .p12 confirm-mismatch blocks submit (no save dialog, no exportP12ToPath)', async () => {
    await renderWithKeys([
      makeKey({ fingerprint: 'fpIII999', email: 'iris@example.com', hasPrivate: true }),
    ]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.save).mockResolvedValue('/out/identity.p12');
    const { exportP12ToPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/fpIII999/i);
    fireEvent.click(screen.getByRole('button', { name: /export \.p12/i }));

    const primary = await screen.findByPlaceholderText(/bundle passphrase/i);
    const confirm = await screen.findByPlaceholderText(/re-enter passphrase/i);
    // Mismatched values.
    fireEvent.change(primary, { target: { value: 'first-pass' } });
    fireEvent.change(confirm, { target: { value: 'second-pass' } });

    // The OK button is disabled while inputs mismatch — querying by role
    // + name still returns it (disabled buttons are reachable in the a11y
    // tree), so we assert `disabled` explicitly rather than expecting
    // `getByRole` to throw.
    const okBtn = screen.getByRole('button', { name: /^OK$/i });
    expect(okBtn).toBeDisabled();
    // The mismatch error must render (a11y: aria-describedby + role=alert).
    expect(await screen.findByText(/passphrases do not match/i)).toBeInTheDocument();

    // Even a forced form-submit (Enter from the confirm input) must NOT fire
    // exportP12ToPath — the form's onSubmit gates on `canSubmit`.
    fireEvent.submit(okBtn.closest('form')!);
    await Promise.resolve();
    await Promise.resolve();
    expect(exportP12ToPath).not.toHaveBeenCalled();
    expect(dialog.save).not.toHaveBeenCalled();
  });

  it('Export .p12 cancelling the passphrase prompt does NOT open the save dialog', async () => {
    await renderWithKeys([
      makeKey({ fingerprint: 'fpJJJ000', email: 'jane@example.com', hasPrivate: true }),
    ]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    const { exportP12ToPath } = await import('../../../src/services/db/cryptoKeys');

    await screen.findByText(/fpJJJ000/i);
    fireEvent.click(screen.getByRole('button', { name: /export \.p12/i }));

    // The confirm-passphrase prompt opens; cancel it.
    await screen.findByPlaceholderText(/re-enter passphrase/i);
    // The Cancel button lives in the same modal — pick the LAST cancel-typed
    // button (the imperative portal mounts after the section, so it's after
    // any other cancel-typed control).
    const cancelBtns = screen.getAllByRole('button', { name: /cancel/i });
    fireEvent.click(cancelBtns[cancelBtns.length - 1]!);

    await Promise.resolve();
    await Promise.resolve();
    expect(dialog.save).not.toHaveBeenCalled();
    expect(exportP12ToPath).not.toHaveBeenCalled();
  });
});

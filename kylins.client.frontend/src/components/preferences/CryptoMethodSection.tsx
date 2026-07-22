// Task 5: Per-account crypto-method picker (None / PGP / S/MIME) mounted in
// SecurityPreferences. The selected method is the account's DEFAULT crypto
// standard: the composer reads it at send time to dispatch between PGP/MIME
// and S/MIME (Task 4's `send_op` dispatches on `account.crypto_method`).
//
// Structural mirror of CryptoGranularitySection.tsx:
//   - account-picker <select> (defaults to first account via useEffect)
//   - detail <select> for the method itself
//   - handleMethodChange: optimistic `setMethod` → `updateAccount(id, {...})`
//     → `updateAccountInPlace(id, {...})` to mirror into the Zustand store;
//     on error, revert the dropdown to the persisted value so the control
//     never shows a failed optimistic update.
//
// The `'none'` option (the default) means "no crypto configured" — toggling
// Encrypt/Sign in the composer with this setting produces a fail-closed
// failure (see `sendEmail`'s guard in `services/composer/send.ts`); the user
// is prompted to pick PGP or S/MIME here first.

import { useEffect, useState } from 'react';
import { useAccountStore } from '@/stores/accountStore';
import { updateAccount } from '@/services/accounts';

const METHOD_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'openpgp', label: 'PGP (OpenPGP)' },
  { value: 'smime', label: 'S/MIME' },
] as const;

const DEFAULT_METHOD = 'none';

export function CryptoMethodSection() {
  const accounts = useAccountStore((s) => s.accounts);
  const updateAccountInPlace = useAccountStore((s) => s.updateAccountInPlace);
  const [pickedAccountId, setPickedAccountId] = useState<string>('');
  const [method, setMethod] = useState<string>(DEFAULT_METHOD);
  const [error, setError] = useState<string | null>(null);

  // Default to the first account once the store has loaded any.
  useEffect(() => {
    if (!pickedAccountId && accounts.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPickedAccountId(accounts[0]?.id ?? '');
    }
  }, [accounts, pickedAccountId]);

  // Re-seed the method control when the picked account changes (so the
  // dropdown always reflects the persisted value for the visible row).
  useEffect(() => {
    const picked = accounts.find((a) => a.id === pickedAccountId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMethod(picked?.cryptoMethod ?? DEFAULT_METHOD);
    setError(null);
  }, [pickedAccountId, accounts]);

  async function handleMethodChange(next: string) {
    if (!pickedAccountId) return;
    setMethod(next);
    setError(null);
    try {
      await updateAccount(pickedAccountId, { cryptoMethod: next as 'none' | 'openpgp' | 'smime' });
      updateAccountInPlace(pickedAccountId, { cryptoMethod: next as 'none' | 'openpgp' | 'smime' });
    } catch (e) {
      setError(String(e));
      // Revert to the persisted value so the control reflects what's
      // actually in the DB, not the failed optimistic update.
      const picked = accounts.find((a) => a.id === pickedAccountId);
      setMethod(picked?.cryptoMethod ?? DEFAULT_METHOD);
    }
  }

  if (accounts.length === 0) {
    return (
      <span className="text-sm text-[var(--muted-text)]">
        Add an account first to set its crypto method.
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="crypto-method-account" className="text-xs text-[var(--muted-text)]">
          Choose account
        </label>
        <select
          id="crypto-method-account"
          value={pickedAccountId}
          onChange={(e) => setPickedAccountId(e.target.value)}
          className="h-11 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName ? `${a.displayName} (${a.email})` : a.email}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="crypto-method" className="text-xs text-[var(--muted-text)]">
          Crypto method
        </label>
        <select
          id="crypto-method"
          value={method}
          onChange={(e) => void handleMethodChange(e.target.value)}
          className="h-11 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
        >
          {METHOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {method === 'none' && (
          <span className="text-xs text-[var(--muted-text)]">
            Encrypt/Sign in the composer will be blocked until you pick PGP or S/MIME.
          </span>
        )}
      </div>
      {error && <span className="text-xs text-[var(--destructive)]">{error}</span>}
    </div>
  );
}

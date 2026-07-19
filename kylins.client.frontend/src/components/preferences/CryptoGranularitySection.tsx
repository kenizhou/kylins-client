// Task 2 (CU): Encryption-granularity picker mounted inside SecurityPreferences.
//
// Surfaces the `accounts.crypto_granularity` column (settable via
// `db_update_account` — see `services/accounts.ts:updateAccount`) as a
// per-account dropdown. Mirrors the master/detail shape of KeyManagerSection
// (account picker + a detail control) but is much simpler: a single
// `<select>` whose commit goes through `updateAccount` (persisted to SQLite)
// then `updateAccountInPlace` (mirror into the local Zustand store so any
// downstream reader sees the new value immediately).
//
// Granularity is stored as a STRING column on the `accounts` row, so unknown
// or future values never break the type. The dropdown only enumerates the
// three currently-meaningful options; an unknown persisted value would simply
// show a blank `<select>` entry, and the user can re-pick a known one.

import { useEffect, useState } from 'react';
import { useAccountStore } from '@/stores/accountStore';
import { updateAccount } from '@/services/accounts';

const GRANULARITY_OPTIONS = [
  { value: 'whole_message', label: 'Whole message (standard)' },
  { value: 'body_inline_per_attachment', label: 'Per-attachment' },
  { value: 'body_inline_merged_attachments', label: 'Merged attachments (one part)' },
] as const;

const DEFAULT_GRANULARITY = 'whole_message';

export function CryptoGranularitySection() {
  const accounts = useAccountStore((s) => s.accounts);
  const updateAccountInPlace = useAccountStore((s) => s.updateAccountInPlace);
  const [pickedAccountId, setPickedAccountId] = useState<string>('');
  const [granularity, setGranularity] = useState<string>(DEFAULT_GRANULARITY);
  const [error, setError] = useState<string | null>(null);

  // Default to the first account once the store has loaded any.
  useEffect(() => {
    if (!pickedAccountId && accounts.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPickedAccountId(accounts[0]?.id ?? '');
    }
  }, [accounts, pickedAccountId]);

  // Re-seed the granularity control when the picked account changes (so
  // the dropdown always reflects the persisted value for the visible row).
  useEffect(() => {
    const picked = accounts.find((a) => a.id === pickedAccountId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGranularity(picked?.cryptoGranularity ?? DEFAULT_GRANULARITY);
     
    setError(null);
  }, [pickedAccountId, accounts]);

  async function handleGranularityChange(next: string) {
    if (!pickedAccountId) return;
    setGranularity(next);
    setError(null);
    try {
      await updateAccount(pickedAccountId, { cryptoGranularity: next });
      updateAccountInPlace(pickedAccountId, { cryptoGranularity: next });
    } catch (e) {
      setError(String(e));
      // Revert to the persisted value so the control reflects what's
      // actually in the DB, not the failed optimistic update.
      const picked = accounts.find((a) => a.id === pickedAccountId);
      setGranularity(picked?.cryptoGranularity ?? DEFAULT_GRANULARITY);
    }
  }

  if (accounts.length === 0) {
    return (
      <span className="text-sm text-[var(--muted-text)]">
        Add an account first to set its encryption granularity.
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="crypto-granularity-account" className="text-xs text-[var(--muted-text)]">
          Choose account
        </label>
        <select
          id="crypto-granularity-account"
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
        <label htmlFor="crypto-granularity" className="text-xs text-[var(--muted-text)]">
          Encryption granularity
        </label>
        <select
          id="crypto-granularity"
          value={granularity}
          onChange={(e) => void handleGranularityChange(e.target.value)}
          className="h-11 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
        >
          {GRANULARITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {granularity === 'body_inline_per_attachment' && (
          <span className="text-xs text-[var(--muted-text)]">
            No visible effect on standard S/MIME yet — for future E2EE.
          </span>
        )}
      </div>
      {error && <span className="text-xs text-[var(--destructive)]">{error}</span>}
    </div>
  );
}

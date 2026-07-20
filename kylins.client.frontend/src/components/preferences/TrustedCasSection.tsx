// G6 Task 6 (Plan 4): "Trusted CAs" subsection of SecurityPreferences.
// Mirrors the master/detail pattern of KeyManagerSection (Plan 4b) but for
// CA-root trust anchors: a per-account Import PEM button + a list filtered to
// `keyType === 'cert'` rows + per-row Delete.
//
// The CA-root import path is SEPARATE from the signing-key import path
// (`crypto_import_key_from_path` expects a cert+key bundle; a CA root has no
// private key). Instead we read the PEM client-side (`readTextFile`), decode
// it to DER, SHA-256 the DER for the fingerprint, HEX-encode the DER for
// `publicData`, and `db_upsert_crypto_key` a `key_type='cert'` row. G5's
// `list_trust_anchor_certs` reads exactly that slice and feeds the DER to the
// chain validator. See `services/db/cryptoKeys.ts#importTrustAnchorFromPath`.
//
// Listing uses the existing `listCryptoKeysForAccount(accountId, 'smime')` and
// filters client-side to `keyType === 'cert'` (G5's `list_trust_anchor_certs`
// is a Rust helper, not a Tauri command, so we reuse the existing list call).
//
// UI conventions mirror KeyManagerSection: `window.confirm` for delete +
// `pushToast` for results; `PreferencesSectionCard` wrapper; optional
// `accountId` prop for parent-controlled usage (tests).

import { useEffect, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useAccountStore } from '@/stores/accountStore';
import { useToastStore } from '@/stores/toastStore';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { ShieldCheckIcon, TrashIcon, UploadIcon } from '../icons';
import {
  listCryptoKeysForAccount,
  deleteCryptoKey,
  importTrustAnchorFromPath,
  type CryptoKeyRow,
} from '@/services/db/cryptoKeys';

const SMIME = 'smime';
// G5's `list_trust_anchor_certs` selects rows with `key_type='cert'`; the
// signing-key path writes `key_type='private'`. Filter client-side because
// `list_trust_anchor_certs` is not exposed as a Tauri command.
const TRUST_ANCHOR_KEY_TYPE = 'cert';

interface TrustedCasSectionProps {
  /**
   * If provided, the section manages trust anchors for this account directly
   * (used by tests + when a parent already owns the account context). If
   * omitted, the section renders its own account picker seeded from
   * `useAccountStore` — matching how KeyManagerSection works.
   */
  accountId?: string;
}

export function TrustedCasSection({ accountId: accountIdProp }: TrustedCasSectionProps) {
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const pushToast = useToastStore((s) => s.push);

  // Local override selected via the in-section picker. When the prop is
  // provided we always defer to it.
  const [pickedAccountId, setPickedAccountId] = useState<string | null>(activeAccountId);
  const effectiveAccountId = accountIdProp ?? pickedAccountId ?? accounts[0]?.id ?? null;

  // All S/MIME keys for the account; we filter to cert rows below. Kept as
  // the full list (not pre-filtered) so the empty-state branch can tell
  // "no keys at all" from "keys exist but none are CAs" — both render the
  // same empty message but the distinction is useful for future telemetry.
  const [allKeys, setAllKeys] = useState<CryptoKeyRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const trustAnchors = allKeys.filter((k) => k.keyType === TRUST_ANCHOR_KEY_TYPE);

  useEffect(() => {
    if (!effectiveAccountId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    listCryptoKeysForAccount(effectiveAccountId, SMIME)
      .then((rows) => {
        if (!cancelled) setAllKeys(rows);
      })
      .catch((err) => {
        if (!cancelled) pushToast(`Failed to list CA roots: ${formatErr(err)}`, 'error');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveAccountId, pushToast]);

  async function refresh() {
    if (!effectiveAccountId) return;
    setIsLoading(true);
    try {
      const rows = await listCryptoKeysForAccount(effectiveAccountId, SMIME);
      setAllKeys(rows);
    } catch (err) {
      pushToast(`Failed to list CA roots: ${formatErr(err)}`, 'error');
    } finally {
      setIsLoading(false);
    }
  }

  async function onImport() {
    if (!effectiveAccountId) return;
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: 'PEM', extensions: ['pem', 'crt', 'cer', 'txt'] }],
    });
    // `open` returns `string | string[] | null` depending on options; with
    // `multiple: false` we get `string | null`, but guard for both shapes.
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    try {
      await importTrustAnchorFromPath(effectiveAccountId, path);
      pushToast('CA root imported', 'success');
      await refresh();
    } catch (err) {
      pushToast(`Import failed: ${formatErr(err)}`, 'error');
    }
  }

  async function onDelete(fingerprint: string) {
    if (!effectiveAccountId) return;
    if (
      !window.confirm(
        'Remove this trusted CA root? Signed mails verified against it will re-prompt for trust.',
      )
    )
      return;
    try {
      await deleteCryptoKey(effectiveAccountId, SMIME, fingerprint);
      pushToast('CA root removed', 'success');
      await refresh();
    } catch (err) {
      pushToast(`Remove failed: ${formatErr(err)}`, 'error');
    }
  }

  return (
    <PreferencesSectionCard title="Trusted CAs" icon={ShieldCheckIcon}>
      <p className="text-xs text-[var(--muted-text)]">
        CA-root certificates you trust for verifying signed mail. Importing a CA root here lets the
        chain validator accept signatures from certificates it issues (otherwise the signer shows as
        &ldquo;chain unverified&rdquo;).
      </p>

      {/* Account picker — only when no accountId prop was supplied. */}
      {!accountIdProp && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--muted-text)]">Choose account</span>
          {accounts.length === 0 ? (
            <span className="text-sm text-[var(--muted-text)]">
              Add an account first to manage trusted CAs.
            </span>
          ) : (
            <select
              value={effectiveAccountId ?? ''}
              onChange={(e) => setPickedAccountId(e.target.value)}
              className="h-11 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName ? `${a.displayName} (${a.email})` : a.email}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void onImport()}
          disabled={!effectiveAccountId}
          className="inline-flex items-center gap-1.5 h-11 px-3 text-sm font-medium rounded-lg bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          <UploadIcon size={14} />
          Import CA PEM…
        </button>
      </div>

      {/* Trust-anchor list */}
      {isLoading && trustAnchors.length === 0 ? (
        <div className="text-sm text-[var(--muted-text)]">Loading…</div>
      ) : trustAnchors.length === 0 ? (
        <p className="text-sm text-[var(--muted-text)]">
          No trusted CA roots yet. Import a PEM-encoded CA certificate to trust signers it issues.
        </p>
      ) : (
        <ul className="space-y-2">
          {trustAnchors.map((k) => (
            <li
              key={k.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2.5"
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-medium text-[var(--foreground)] truncate">
                  CA root
                </span>
                <span className="text-xs text-[var(--muted-text)] font-mono">
                  {k.fingerprint.slice(0, 20)}
                  {k.fingerprint.length > 20 ? '…' : ''}
                  <span className="ml-2 normal-case">· {k.origin}</span>
                </span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => void onDelete(k.fingerprint)}
                  className="flex h-11 w-11 items-center justify-center rounded text-[var(--muted-text)] hover:text-[var(--destructive)] hover:bg-[color-mix(in_oklab,var(--destructive),transparent_90%)] transition-colors"
                  title="Remove"
                  aria-label="Delete"
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PreferencesSectionCard>
  );
}

/** Normalize unknown error values into a short human-readable string. */
function formatErr(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

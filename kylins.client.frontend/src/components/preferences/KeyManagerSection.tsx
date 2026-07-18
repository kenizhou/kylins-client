// S/MIME key manager section, mounted inside SecurityPreferences.
// Mirrors the master/detail pattern of SignaturesPreferences: account picker +
// list + Default chip + action buttons, all wrapped in a `PreferencesSectionCard`.
//
// All heavy lifting (PEM parse, cert generate, DER export, default-flag
// atomic swap) is delegated to the Rust backend via the typed wrappers in
// `services/db/cryptoKeys`. The UI layer never sees private key material —
// only the `hasPrivate` boolean flag is surfaced (e.g. as a small badge).
//
// `createdAt`/`expiresAt` on `CryptoKeyRow` are STRINGS (unix-seconds from
// SQLite `strftime('%s','now')`); we format via `Number(row.createdAt) * 1000`
// if displayed. Currently we surface only email + fingerprint + origin +
// hasPrivate + Default chip — enough context without cluttering the row.

import { useEffect, useState } from 'react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { useAccountStore } from '@/stores/accountStore';
import { useToastStore } from '@/stores/toastStore';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { ShieldCheckIcon, TrashIcon, DownloadIcon, UploadIcon } from '../icons';
import {
  listCryptoKeysForAccount,
  generateKey,
  importKeyFromPath,
  setDefaultSigningKey,
  deleteCryptoKey,
  exportPublicToPath,
  type CryptoKeyRow,
} from '@/services/db/cryptoKeys';

const SMIME = 'smime';

interface KeyManagerSectionProps {
  /**
   * If provided, the section manages keys for this account directly (used by
   * tests + when a parent already owns the account context). If omitted, the
   * section renders its own account picker seeded from `useAccountStore` —
   * matching how SignaturesPreferences works.
   */
  accountId?: string;
}

export function KeyManagerSection({ accountId: accountIdProp }: KeyManagerSectionProps) {
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const pushToast = useToastStore((s) => s.push);

  // Local override selected via the in-section picker. When the prop is
  // provided we always defer to it.
  const [pickedAccountId, setPickedAccountId] = useState<string | null>(activeAccountId);
  const effectiveAccountId = accountIdProp ?? pickedAccountId ?? accounts[0]?.id ?? null;

  const [keys, setKeys] = useState<CryptoKeyRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!effectiveAccountId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    listCryptoKeysForAccount(effectiveAccountId, SMIME)
      .then((rows) => {
        if (!cancelled) setKeys(rows);
      })
      .catch((err) => {
        if (!cancelled) pushToast(`Failed to list keys: ${formatErr(err)}`, 'error');
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
      setKeys(rows);
    } catch (err) {
      pushToast(`Failed to list keys: ${formatErr(err)}`, 'error');
    } finally {
      setIsLoading(false);
    }
  }

  async function onImport() {
    if (!effectiveAccountId) return;
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: 'PEM', extensions: ['pem', 'crt', 'cer', 'key', 'txt'] }],
    });
    // `open` returns `string | string[] | null` depending on options; with
    // `multiple: false` we get `string | null`, but guard for both shapes.
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    try {
      await importKeyFromPath(effectiveAccountId, path);
      pushToast('Key imported', 'success');
      await refresh();
    } catch (err) {
      pushToast(`Import failed: ${formatErr(err)}`, 'error');
    }
  }

  async function onGenerate() {
    if (!effectiveAccountId) return;
    const account = useAccountStore.getState().accounts.find((a) => a.id === effectiveAccountId);
    const email = account?.email;
    if (!email) {
      pushToast('Account has no email address', 'error');
      return;
    }
    try {
      await generateKey(effectiveAccountId, email);
      pushToast('Self-signed key generated', 'success');
      await refresh();
    } catch (err) {
      pushToast(`Generate failed: ${formatErr(err)}`, 'error');
    }
  }

  async function onSetDefault(fingerprint: string) {
    if (!effectiveAccountId) return;
    try {
      await setDefaultSigningKey(effectiveAccountId, SMIME, fingerprint);
      pushToast('Default signing key set', 'success');
      await refresh();
    } catch (err) {
      pushToast(`Failed to set default: ${formatErr(err)}`, 'error');
    }
  }

  async function onDelete(fingerprint: string) {
    if (!effectiveAccountId) return;
    if (!window.confirm('Delete this key? This cannot be undone.')) return;
    try {
      await deleteCryptoKey(effectiveAccountId, SMIME, fingerprint);
      pushToast('Key deleted', 'success');
      await refresh();
    } catch (err) {
      pushToast(`Delete failed: ${formatErr(err)}`, 'error');
    }
  }

  async function onExport(fingerprint: string) {
    if (!effectiveAccountId) return;
    const outPath = await saveDialog({
      defaultPath: 'smime-cert.der',
      filters: [{ name: 'DER', extensions: ['der'] }],
    });
    if (!outPath) return;
    try {
      await exportPublicToPath(effectiveAccountId, SMIME, fingerprint, outPath);
      pushToast('Certificate exported', 'success');
    } catch (err) {
      pushToast(`Export failed: ${formatErr(err)}`, 'error');
    }
  }

  return (
    <PreferencesSectionCard title="Your S/MIME Keys" icon={ShieldCheckIcon}>
      {/* Account picker — only when no accountId prop was supplied. */}
      {!accountIdProp && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--muted-text)]">Choose account</span>
          {accounts.length === 0 ? (
            <span className="text-sm text-[var(--muted-text)]">
              Add an account first to manage keys.
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
          Import PEM…
        </button>
        <button
          type="button"
          onClick={() => void onGenerate()}
          disabled={!effectiveAccountId}
          className="inline-flex items-center justify-center h-11 px-3 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors disabled:opacity-40"
        >
          Generate self-signed
        </button>
      </div>

      {/* Key list */}
      {isLoading && keys.length === 0 ? (
        <div className="text-sm text-[var(--muted-text)]">Loading…</div>
      ) : keys.length === 0 ? (
        <p className="text-sm text-[var(--muted-text)]">
          No S/MIME keys yet. Import a PEM cert+key or generate a self-signed one.
        </p>
      ) : (
        <ul className="space-y-2">
          {keys.map((k) => (
            <li
              key={k.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2.5"
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-medium text-[var(--foreground)] truncate">
                  {k.email ?? '(no email)'}
                  {k.isDefaultSign && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-[var(--highlight)] px-2 py-0.5 text-[10px] font-medium text-[var(--highlight-text)]">
                      Default
                    </span>
                  )}
                  {k.hasPrivate && (
                    <span
                      className="ml-1 inline-flex items-center rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--muted-text)]"
                      title="Private key stored locally"
                    >
                      has private
                    </span>
                  )}
                </span>
                <span className="text-xs text-[var(--muted-text)] font-mono">
                  {k.fingerprint.slice(0, 20)}
                  {k.fingerprint.length > 20 ? '…' : ''}
                  <span className="ml-2 normal-case">· {k.origin}</span>
                </span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!k.isDefaultSign && (
                  <button
                    type="button"
                    onClick={() => void onSetDefault(k.fingerprint)}
                    className="inline-flex items-center justify-center h-11 px-2 text-xs rounded text-[var(--muted-text)] hover:text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
                    title="Set as default signing key"
                  >
                    Set default
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void onExport(k.fingerprint)}
                  className="flex h-11 w-11 items-center justify-center rounded text-[var(--muted-text)] hover:text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
                  title="Export certificate"
                  aria-label="Export"
                >
                  <DownloadIcon size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => void onDelete(k.fingerprint)}
                  className="flex h-11 w-11 items-center justify-center rounded text-[var(--muted-text)] hover:text-[var(--destructive)] hover:bg-[color-mix(in_oklab,var(--destructive),transparent_90%)] transition-colors"
                  title="Delete"
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

import { useEffect, useMemo, useState } from 'react';
import { useAccountStore } from '@/stores/accountStore';
import {
  getSignaturesForAccount,
  insertSignature,
  updateSignature,
  deleteSignature,
  CONTEXT_LABELS,
  type DbSignature,
  type SignatureContext,
} from '@/services/db/signatures';
import { SignatureEditor } from './SignatureEditor';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { PreferencesSignaturesIcon, PlusIcon, TrashIcon, PreferencesComposingIcon } from '../icons';

const DEFAULT_SIGNATURE: Omit<DbSignature, 'id' | 'account_id' | 'sort_order'> = {
  name: '',
  body_html: '<p></p>',
  is_default: 0,
  context: 'all',
};

export function SignaturesPreferences() {
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(activeAccountId);
  const [signatures, setSignatures] = useState<DbSignature[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const effectiveAccountId = selectedAccountId ?? accounts[0]?.id ?? null;

  useEffect(() => {
    if (!effectiveAccountId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    getSignaturesForAccount(effectiveAccountId)
      .then((sigs) => {
        if (!cancelled) setSignatures(sigs);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    setEditingId(null);
    return () => {
      cancelled = true;
    };
  }, [effectiveAccountId]);

  const editingSignature = useMemo(
    () => signatures.find((s) => s.id === editingId) ?? null,
    [editingId, signatures],
  );

  async function refresh() {
    if (!effectiveAccountId) return;
    setIsLoading(true);
    try {
      const sigs = await getSignaturesForAccount(effectiveAccountId);
      setSignatures(sigs);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave(values: {
    name: string;
    bodyHtml: string;
    context: SignatureContext;
    isDefault: boolean;
  }) {
    if (!effectiveAccountId) return;
    if (editingSignature) {
      await updateSignature(editingSignature.id, values);
    } else {
      await insertSignature({ accountId: effectiveAccountId, ...values });
    }
    await refresh();
    setEditingId(null);
  }

  async function handleDelete(id: string) {
    await deleteSignature(id);
    await refresh();
    if (editingId === id) setEditingId(null);
  }

  if (accounts.length === 0) {
    return (
      <div className="p-6">
        <PreferencesSectionCard title="Signatures" icon={PreferencesSignaturesIcon}>
          <p className="text-sm text-[var(--muted-text)]">
            Add an account first to manage signatures.
          </p>
        </PreferencesSectionCard>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="grid grid-cols-1 gap-5">
        <div className="space-y-5">
          <PreferencesSectionCard title="Account" icon={PreferencesSignaturesIcon}>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-[var(--muted-text)]">Choose account</span>
              <select
                value={effectiveAccountId ?? ''}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="h-9 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName ? `${a.displayName} (${a.email})` : a.email}
                  </option>
                ))}
              </select>
            </div>
          </PreferencesSectionCard>

          <PreferencesSectionCard title="Your signatures" icon={PreferencesSignaturesIcon}>
            {isLoading ? (
              <div className="text-sm text-[var(--muted-text)]">Loading…</div>
            ) : signatures.length === 0 ? (
              <div className="text-sm text-[var(--muted-text)]">
                No signatures yet. Create one to get started.
              </div>
            ) : (
              <ul className="space-y-2">
                {signatures.map((sig) => (
                  <li
                    key={sig.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2.5"
                  >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-medium text-[var(--foreground)] truncate">
                        {sig.name}
                        {sig.is_default === 1 && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-[var(--highlight)] px-2 py-0.5 text-[10px] font-medium text-[var(--highlight-text)]">
                            Default
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-[var(--muted-text)]">
                        {CONTEXT_LABELS[sig.context]}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => setEditingId(sig.id)}
                        className="rounded p-1.5 text-[var(--muted-text)] hover:text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
                        title="Edit"
                        aria-label={`Edit ${sig.name}`}
                      >
                        <PreferencesComposingIcon size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(sig.id)}
                        className="rounded p-1.5 text-[var(--muted-text)] hover:text-[var(--destructive)] hover:bg-[color-mix(in_oklab,var(--destructive),transparent_90%)] transition-colors"
                        title="Delete"
                        aria-label={`Delete ${sig.name}`}
                      >
                        <TrashIcon size={14} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {editingId !== 'new' && (
              <button
                type="button"
                onClick={() => setEditingId('new')}
                className="mt-4 flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity"
              >
                <PlusIcon size={14} />
                Add signature
              </button>
            )}
          </PreferencesSectionCard>
        </div>

        <div className="space-y-5">
          {editingId ? (
            <SignatureEditor
              key={editingId}
              initial={
                editingSignature ?? {
                  ...DEFAULT_SIGNATURE,
                  id: 'new',
                  account_id: effectiveAccountId!,
                  sort_order: 0,
                }
              }
              onSave={handleSave}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <PreferencesSectionCard title="Signature editor" icon={PreferencesSignaturesIcon}>
              <p className="text-sm text-[var(--muted-text)]">
                Select a signature to edit, or create a new one.
              </p>
            </PreferencesSectionCard>
          )}
        </div>
      </div>
    </div>
  );
}

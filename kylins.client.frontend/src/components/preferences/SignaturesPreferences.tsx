// Signatures preferences tab: per-account signature CRUD. Account chips mirror
// AccountsPreferences; the list shows name/context/default and create/edit use
// the shared SignatureEditor (TipTap, same extensions as the composer).

import { useCallback, useEffect, useState } from 'react';
import { Button, ToggleButton } from 'react-aria-components';
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
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { PreferencesTabLayout } from './PreferencesTabLayout';
import { SignatureEditor } from './SignatureEditor';
import { PreferencesSignaturesIcon, PlusIcon } from '@/components/icons';

const NEW_SIGNATURE: DbSignature = {
  id: 'new',
  account_id: '',
  name: '',
  body_html: '',
  is_default: 0,
  sort_order: 0,
  context: 'all',
};

export function SignaturesPreferences() {
  const accounts = useAccountStore((s) => s.accounts);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [signatures, setSignatures] = useState<DbSignature[]>([]);
  const [editing, setEditing] = useState<DbSignature | null>(null);
  // Loading is derived: the list belongs to another account until the fetch
  // for the current one lands (avoids setState-in-effect for a loading flag).
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const effectiveAccountId = selectedAccountId ?? accounts[0]?.id ?? null;
  const selectedAccount = accounts.find((a) => a.id === effectiveAccountId) ?? null;
  const isLoading = effectiveAccountId !== null && loadedFor !== effectiveAccountId;

  const load = useCallback(async (accountId: string) => {
    const sigs = await getSignaturesForAccount(accountId);
    setSignatures([...sigs].sort((a, b) => a.sort_order - b.sort_order));
    setLoadedFor(accountId);
  }, []);

  useEffect(() => {
    if (!effectiveAccountId) return;
    // Data-loading effect — same pattern as AccountsPreferences.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(effectiveAccountId);
  }, [effectiveAccountId, load]);

  async function handleSave(values: {
    name: string;
    bodyHtml: string;
    context: SignatureContext;
    isDefault: boolean;
  }) {
    if (!effectiveAccountId || !editing) return;
    if (editing.id === 'new') {
      await insertSignature({ accountId: effectiveAccountId, ...values });
    } else {
      await updateSignature(editing.id, values);
    }
    setEditing(null);
    await load(effectiveAccountId);
  }

  async function handleDelete(id: string) {
    if (!effectiveAccountId) return;
    await deleteSignature(id);
    await load(effectiveAccountId);
  }

  if (accounts.length === 0) {
    return (
      <PreferencesTabLayout>
        <PreferencesSectionCard title="Signatures" icon={PreferencesSignaturesIcon}>
          <p className="text-sm text-[var(--muted-text)]">
            Add an account before creating signatures.
          </p>
        </PreferencesSectionCard>
      </PreferencesTabLayout>
    );
  }

  return (
    <PreferencesTabLayout>
      <PreferencesSectionCard title="Signatures" icon={PreferencesSignaturesIcon}>
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {accounts.map((account) => {
            const active = account.id === effectiveAccountId;
            return (
              <ToggleButton
                key={account.id}
                isSelected={active}
                onPress={() => {
                  // Close any in-progress edit — it belongs to the previous
                  // account's list.
                  setEditing(null);
                  setSelectedAccountId(account.id);
                }}
                className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] selected:border-[var(--primary)] selected:bg-[var(--selected)] selected:text-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                <span className="max-w-[180px] truncate">
                  {account.accountLabel || account.email}
                </span>
                {account.isDefault && (
                  <span className="inline-flex items-center rounded-full bg-[var(--highlight)] px-2 py-0.5 text-[10px] font-medium text-[var(--highlight-text)]">
                    Default
                  </span>
                )}
              </ToggleButton>
            );
          })}
        </div>

        {selectedAccount && (
          <div className="mb-4 text-sm text-[var(--muted-text)]">
            Signatures for <span className="text-[var(--foreground)]">{selectedAccount.email}</span>
          </div>
        )}

        {editing ? (
          <SignatureEditor
            key={editing.id}
            initial={editing}
            onSave={handleSave}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <>
            {isLoading ? (
              <p className="mb-4 text-sm text-[var(--muted-text)]">Loading signatures…</p>
            ) : signatures.length === 0 ? (
              <p className="mb-4 text-sm text-[var(--muted-text)]">
                No signatures for this account yet.
              </p>
            ) : (
              <div className="mb-4 space-y-2">
                {signatures.map((sig) => (
                  <div
                    key={sig.id}
                    className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="truncate text-sm font-medium text-[var(--foreground)]">
                        {sig.name}
                      </span>
                      <span className="text-xs text-[var(--muted-text)]">
                        {CONTEXT_LABELS[sig.context]}
                      </span>
                      {sig.is_default === 1 && (
                        <span className="inline-flex items-center rounded-full bg-[var(--highlight)] px-2 py-0.5 text-[10px] font-medium text-[var(--highlight-text)]">
                          Default
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Button
                        onPress={() => setEditing(sig)}
                        className="text-xs text-[var(--primary)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                      >
                        Edit
                      </Button>
                      <Button
                        onPress={() => void handleDelete(sig.id)}
                        className="text-xs text-[var(--destructive)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <Button
              onPress={() => setEditing({ ...NEW_SIGNATURE, account_id: effectiveAccountId ?? '' })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              <PlusIcon size={14} />
              Add signature
            </Button>
          </>
        )}
      </PreferencesSectionCard>
    </PreferencesTabLayout>
  );
}

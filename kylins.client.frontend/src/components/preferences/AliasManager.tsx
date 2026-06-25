import { useEffect, useMemo, useState } from 'react';
import type { Account } from '../../types';
import {
  getMappedAliasesForAccount,
  insertAlias,
  updateAlias,
  deleteAlias,
  accountAsAlias,
  type SendAsAlias,
} from '../../services/db/sendAsAliases';
import { PlusIcon, TrashIcon, PreferencesComposingIcon } from '../icons';

interface AliasManagerProps {
  account: Account;
}

function AliasRow({
  alias,
  onEdit,
  onDelete,
}: {
  alias: SendAsAlias;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2.5">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-medium text-[var(--foreground)] truncate">
          {alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email}
        </span>
        {alias.replyTo && (
          <span className="text-xs text-[var(--muted-text)]">Reply-to: {alias.replyTo}</span>
        )}
        <div className="flex items-center gap-1.5">
          {alias.isPrimary && (
            <span className="inline-flex items-center rounded-full bg-[color-mix(in_oklab,var(--primary),transparent_88%)] px-2 py-0.5 text-[10px] font-medium text-[var(--primary)]">
              Primary
            </span>
          )}
          {alias.isDefault && (
            <span className="inline-flex items-center rounded-full bg-[color-mix(in_oklab,var(--primary),transparent_88%)] px-2 py-0.5 text-[10px] font-medium text-[var(--primary)]">
              Default
            </span>
          )}
          {alias.treatAsAlias === false && (
            <span className="text-[10px] text-[var(--muted-text)]">On behalf of</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {!alias.isPrimary && (
          <>
            <button
              type="button"
              onClick={onEdit}
              className="rounded p-1.5 text-[var(--muted-text)] hover:text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
              title="Edit"
              aria-label={`Edit ${alias.email}`}
            >
              <PreferencesComposingIcon size={14} />
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="rounded p-1.5 text-[var(--muted-text)] hover:text-[var(--destructive)] hover:bg-[color-mix(in_oklab,var(--destructive),transparent_90%)] transition-colors"
              title="Delete"
              aria-label={`Delete ${alias.email}`}
            >
              <TrashIcon size={14} />
            </button>
          </>
        )}
      </div>
    </li>
  );
}

export function AliasManager({ account }: AliasManagerProps) {
  const [aliases, setAliases] = useState<SendAsAlias[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [treatAsAlias, setTreatAsAlias] = useState(true);

  async function refresh() {
    setIsLoading(true);
    try {
      const mapped = await getMappedAliasesForAccount(account.id);
      setAliases([accountAsAlias(account), ...mapped.filter((a) => !a.isPrimary)]);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    refresh().then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id]);

  const editingAlias = useMemo(
    () => aliases.find((a) => a.id === editingId) ?? null,
    [aliases, editingId],
  );

  function resetForm() {
    setEditingId(null);
    setEmail('');
    setDisplayName('');
    setReplyTo('');
    setIsDefault(false);
    setTreatAsAlias(true);
  }

  function startEdit(alias: SendAsAlias) {
    setEditingId(alias.id);
    setEmail(alias.email);
    setDisplayName(alias.displayName ?? '');
    setReplyTo(alias.replyTo ?? '');
    setIsDefault(alias.isDefault);
    setTreatAsAlias(alias.treatAsAlias !== false);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    if (editingAlias) {
      await updateAlias(editingAlias.id, {
        displayName: displayName.trim() || undefined,
        replyTo: replyTo.trim() || undefined,
        isDefault,
        treatAsAlias,
      });
    } else {
      await insertAlias({
        accountId: account.id,
        email: email.trim(),
        displayName: displayName.trim() || undefined,
        replyTo: replyTo.trim() || undefined,
        isDefault,
        treatAsAlias,
      });
    }
    await refresh();
    resetForm();
  }

  async function handleDelete(id: string) {
    await deleteAlias(id);
    await refresh();
    if (editingId === id) resetForm();
  }

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-semibold text-[var(--foreground)]">Send-as aliases</h4>

      {isLoading ? (
        <div className="text-sm text-[var(--muted-text)]">Loading…</div>
      ) : (
        <ul className="space-y-2">
          {aliases.map((alias) => (
            <AliasRow
              key={alias.id}
              alias={alias}
              onEdit={() => startEdit(alias)}
              onDelete={() => void handleDelete(alias.id)}
            />
          ))}
        </ul>
      )}

      <form onSubmit={handleSave} className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 space-y-3">
        <div className="text-sm font-medium text-[var(--foreground)]">
          {editingAlias ? 'Edit alias' : 'Add alias'}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--muted-text)]">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="alias@example.com"
              disabled={!!editingAlias}
              required
              className="h-9 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none disabled:opacity-60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--muted-text)]">Display name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Alias Name"
              className="h-9 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-xs text-[var(--muted-text)]">Reply-to address (optional)</span>
            <input
              type="email"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="replies@example.com"
              className="h-9 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-[var(--foreground)] cursor-pointer">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--ring)]"
            />
            Default alias
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--foreground)] cursor-pointer">
            <input
              type="checkbox"
              checked={treatAsAlias}
              onChange={(e) => setTreatAsAlias(e.target.checked)}
              className="rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--ring)]"
            />
            Treat as alias
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity"
          >
            <PlusIcon size={14} />
            {editingAlias ? 'Save changes' : 'Add alias'}
          </button>
          {editingAlias && (
            <button
              type="button"
              onClick={resetForm}
              className="px-3 py-1.5 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

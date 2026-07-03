import { useEffect, useState } from 'react';
import { ContactAvatar } from '@/components/contacts/ContactAvatar';
import type { Contact, ContactGroup } from '@/services/db/contacts';
import { renameContactGroup, deleteContactGroup } from '@/services/db/contacts';
import { PencilIcon, TrashIcon, CheckIcon, CloseIcon, ContactsIcon } from '@/components/icons';

interface GroupDetailProps {
  group: ContactGroup;
  members: Contact[];
  onUpdate: () => void;
}

export function GroupDetail({ group, members, onUpdate }: GroupDetailProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Reset local edit state when the selected group changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(group.name);
    setIsEditing(false);
  }, [group.id, group.name]);

  async function handleRename() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === group.name) {
      setIsEditing(false);
      setName(group.name);
      return;
    }
    setIsLoading(true);
    try {
      await renameContactGroup(group.id, trimmed);
      setIsEditing(false);
      onUpdate();
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete group "${group.name}"?`)) return;
    setIsLoading(true);
    try {
      await deleteContactGroup(group.id);
      onUpdate();
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start gap-4 p-5 border-b border-[var(--border)]">
        <span className="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-[var(--secondary)] text-[var(--secondary-foreground)]">
          <ContactsIcon size={32} />
        </span>
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <input
              type="text"
              aria-label="Group name"
              value={name}
              disabled={isLoading}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleRename();
                } else if (e.key === 'Escape') {
                  setIsEditing(false);
                  setName(group.name);
                }
              }}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-lg font-semibold text-[var(--foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            />
          ) : (
            <h2 className="text-lg font-semibold text-[var(--foreground)] truncate">
              {group.name}
            </h2>
          )}
          {!group.isReadonly && (
            <div className="flex flex-wrap items-center gap-2 mt-3">
              {isEditing ? (
                <>
                  <button
                    type="button"
                    onClick={() => void handleRename()}
                    disabled={isLoading}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-11 min-w-11 text-xs font-medium rounded-md bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50"
                  >
                    <CheckIcon size={13} />
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditing(false);
                      setName(group.name);
                    }}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-11 min-w-11 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  >
                    <CloseIcon size={13} />
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-11 min-w-11 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                >
                  <PencilIcon size={13} />
                  Rename
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={isLoading}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-11 min-w-11 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--destructive)] hover:bg-[var(--hover)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50"
              >
                <TrashIcon size={13} />
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto kylins-scrollbar p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-text)] mb-2">
          Members
        </h3>
        {members.length === 0 ? (
          <p className="text-sm text-[var(--muted-text)]">No members yet</p>
        ) : (
          <ul className="space-y-2">
            {members.map((member) => (
              <li key={member.id} className="flex items-center gap-3">
                <ContactAvatar contact={member} size={32} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--foreground)] truncate">
                    {member.displayName || member.email}
                  </div>
                  {member.displayName && (
                    <div className="text-xs text-[var(--muted-text)] truncate">{member.email}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

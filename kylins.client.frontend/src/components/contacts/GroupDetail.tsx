import { useEffect, useMemo, useState } from 'react';
import { ContactAvatar } from '@/components/contacts/ContactAvatar';
import { Modal } from '@/components/ui/Modal';
import type { Contact, ContactGroup } from '@/services/db/contacts';
import {
  renameContactGroup,
  deleteContactGroup,
  getContactIdsForGroup,
  addContactToGroup,
} from '@/services/db/contacts';
import {
  PencilIcon,
  TrashIcon,
  CheckIcon,
  CloseIcon,
  ContactsIcon,
  PlusIcon,
} from '@/components/icons';

interface GroupDetailProps {
  group: ContactGroup;
  contacts: Contact[];
  onUpdate: () => void;
}

export function GroupDetail({ group, contacts, onUpdate }: GroupDetailProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [isLoading, setIsLoading] = useState(false);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [isAddMemberOpen, setIsAddMemberOpen] = useState(false);

  useEffect(() => {
    // Reset local edit state when the selected group changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(group.name);
    setIsEditing(false);
  }, [group.id, group.name]);

  useEffect(() => {
    let cancelled = false;
    getContactIdsForGroup(group.id)
      .then((ids) => {
        if (cancelled) return;
        setMemberIds(new Set(ids));
      })
      .catch((error) => {
        console.error('Failed to load group members', error);
        if (!cancelled) {
          setMemberIds(new Set());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [group.id]);

  const members = contacts.filter((c) => memberIds.has(c.id));

  const nonMembers = useMemo(() => {
    return contacts
      .filter((c) => !memberIds.has(c.id))
      .sort((a, b) => {
        const aKey = (a.displayName ?? a.email).trim().toLowerCase();
        const bKey = (b.displayName ?? b.email).trim().toLowerCase();
        return aKey.localeCompare(bKey);
      });
  }, [contacts, memberIds]);

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

  async function handleAddContact(contactId: string) {
    setIsLoading(true);
    try {
      await addContactToGroup(contactId, group.id);
      setMemberIds((prev) => new Set([...prev, contactId]));
      setIsAddMemberOpen(false);
      onUpdate();
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start gap-4 p-5 border-b border-[var(--border-subtle)]">
        <span className="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-surface-elevated text-[var(--secondary-foreground)]">
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
              className="w-full rounded-md border border-[var(--border-subtle)] bg-surface-elevated px-3 py-1.5 text-lg font-semibold text-[var(--foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
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
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-11 min-w-11 text-xs font-medium rounded-md bg-[var(--primary)] text-[var(--primary-fg)] shadow-[var(--shadow-sm)] hover:opacity-90 transition-opacity focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50"
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
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-11 min-w-11 text-xs font-medium rounded-lg border border-[var(--border-subtle)] bg-surface-elevated text-[var(--foreground)] hover:bg-[var(--primary-subtle)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  >
                    <CloseIcon size={13} />
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setIsEditing(true)}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-11 min-w-11 text-xs font-medium rounded-lg border border-[var(--border-subtle)] bg-surface-elevated text-[var(--foreground)] hover:bg-[var(--primary-subtle)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  >
                    <PencilIcon size={13} />
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete()}
                    disabled={isLoading}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-11 min-w-11 text-xs font-medium rounded-lg border border-[var(--border-subtle)] bg-surface-elevated text-[var(--destructive)] hover:bg-[var(--primary-subtle)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50"
                  >
                    <TrashIcon size={13} />
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsAddMemberOpen(true)}
                    disabled={isLoading}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-11 min-w-11 text-xs font-medium rounded-lg border border-[var(--border-subtle)] bg-surface-elevated text-[var(--foreground)] hover:bg-[var(--primary-subtle)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50"
                  >
                    <PlusIcon size={13} />
                    Add member
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto kylins-scrollbar p-5">
        <h3 className="type-overline text-[var(--muted-text)] mb-2">Members</h3>
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

      <Modal
        isOpen={isAddMemberOpen}
        onClose={() => setIsAddMemberOpen(false)}
        title={`Add member to ${group.name}`}
        size="md"
        footer={
          <button
            type="button"
            onClick={() => setIsAddMemberOpen(false)}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 min-h-11 min-w-11 text-sm font-medium rounded-lg border border-[var(--border-subtle)] bg-surface-elevated text-[var(--foreground)] hover:bg-[var(--primary-subtle)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            Cancel
          </button>
        }
      >
        <div className="p-4">
          {nonMembers.length === 0 ? (
            <p className="text-sm text-[var(--muted-text)]">All contacts are already members.</p>
          ) : (
            <ul className="max-h-[320px] overflow-y-auto kylins-scrollbar space-y-1">
              {nonMembers.map((contact) => (
                <li key={contact.id}>
                  <button
                    type="button"
                    onClick={() => void handleAddContact(contact.id)}
                    disabled={isLoading}
                    className="w-full flex items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-surface-elevated px-3 py-2 min-h-11 text-left hover:bg-[var(--primary-subtle)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50"
                  >
                    <ContactAvatar contact={contact} size={32} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--foreground)] truncate">
                        {contact.displayName || contact.email}
                      </div>
                      {contact.displayName && (
                        <div className="text-xs text-[var(--muted-text)] truncate">
                          {contact.email}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
    </div>
  );
}

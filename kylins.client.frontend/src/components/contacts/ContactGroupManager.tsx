import { useState } from 'react';
import { useContactStore } from '../../stores/contactStore';
import {
  createContactGroup,
  renameContactGroup,
  deleteContactGroup,
  type ContactGroup,
} from '../../services/db/contacts';
import { PlusIcon, TrashIcon, PencilIcon, CheckIcon, CloseIcon } from '../icons';

interface ContactGroupManagerProps {
  onUpdate: () => void;
}

export function ContactGroupManager({ onUpdate }: ContactGroupManagerProps) {
  const groups = useContactStore((s) => s.groups);
  const addGroup = useContactStore((s) => s.addGroup);
  const updateGroupInPlace = useContactStore((s) => s.updateGroup);
  const removeGroup = useContactStore((s) => s.removeGroup);

  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const group = await createContactGroup(newName.trim());
    addGroup(group);
    setNewName('');
    onUpdate();
  }

  async function handleRename(groupId: string) {
    if (!editName.trim()) return;
    await renameContactGroup(groupId, editName.trim());
    updateGroupInPlace(groupId, { name: editName.trim() });
    setEditingId(null);
    onUpdate();
  }

  async function handleDelete(group: ContactGroup) {
    if (!confirm(`Delete group "${group.name}"?`)) return;
    await deleteContactGroup(group.id);
    removeGroup(group.id);
    onUpdate();
  }

  return (
    <div className="space-y-3">
      <form onSubmit={handleCreate} className="flex items-center gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New group name"
          className="flex-1 rounded-md border border-[var(--border-subtle)] bg-surface-elevated px-3 py-1.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
        />
        <button
          type="submit"
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--primary)] text-[var(--primary-fg)] shadow-[var(--shadow-sm)] hover:opacity-90 transition-opacity"
        >
          <PlusIcon size={13} />
          Add
        </button>
      </form>

      <ul className="space-y-1">
        {groups.length === 0 && (
          <li className="text-sm text-[var(--muted-text)]">No groups yet.</li>
        )}
        {groups.map((group) => (
          <li
            key={group.id}
            className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-surface-elevated px-3 py-2"
          >
            {editingId === group.id ? (
              <div className="flex items-center gap-2 flex-1">
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="flex-1 rounded-md border border-[var(--border-subtle)] bg-surface-elevated px-2 py-1 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => handleRename(group.id)}
                  className="rounded p-1 text-[var(--primary)] hover:bg-[var(--primary-subtle)] transition-colors"
                  aria-label="Save"
                >
                  <CheckIcon size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="rounded p-1 text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] transition-colors"
                  aria-label="Cancel"
                >
                  <CloseIcon size={14} />
                </button>
              </div>
            ) : (
              <>
                <span className="text-sm text-[var(--foreground)]">{group.name}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(group.id);
                      setEditName(group.name);
                    }}
                    className="rounded p-1 text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] transition-colors"
                    aria-label="Rename"
                  >
                    <PencilIcon size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(group)}
                    className="rounded p-1 text-[var(--destructive)] hover:bg-[var(--primary-subtle)] transition-colors"
                    aria-label="Delete"
                  >
                    <TrashIcon size={13} />
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

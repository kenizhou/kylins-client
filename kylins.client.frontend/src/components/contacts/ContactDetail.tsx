import { useEffect, useRef, useState } from 'react';
import { useComposerStore } from '../../stores/composerStore';
import { useContactStore } from '../../stores/contactStore';
import { ContactAvatar } from './ContactAvatar';
import {
  updateContact,
  deleteContact,
  getGroupsForContact,
  addContactToGroup,
  removeContactFromGroup,
  type Contact,
  type ContactGroup,
  type ContactEmail,
  type ContactPhone,
  type ContactAddress,
  type UpdateContactInput,
} from '../../services/db/contacts';
import { MailIcon, TrashIcon, CopyIcon, PencilIcon, CheckIcon, CloseIcon } from '../icons';

interface ContactDetailProps {
  contact: Contact;
  groups: ContactGroup[];
  onUpdate: () => void;
}

export function ContactDetail({ contact, groups, onUpdate }: ContactDetailProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [contactGroups, setContactGroups] = useState<ContactGroup[]>([]);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const removeContact = useContactStore((s) => s.removeContact);
  const updateContactInPlace = useContactStore((s) => s.updateContact);

  const [draft, setDraft] = useState<
    UpdateContactInput & {
      emails: ContactEmail[];
      phones: ContactPhone[];
      addresses: ContactAddress[];
    }
  >({
    displayName: contact.displayName,
    company: contact.company,
    jobTitle: contact.jobTitle,
    notes: contact.notes,
    emails: contact.emails,
    phones: contact.phones,
    addresses: contact.addresses,
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft({
      displayName: contact.displayName,
      company: contact.company,
      jobTitle: contact.jobTitle,
      notes: contact.notes,
      emails: contact.emails,
      phones: contact.phones,
      addresses: contact.addresses,
    });
  }, [contact.id]);

  useEffect(() => {
    let cancelled = false;
    getGroupsForContact(contact.id).then((g) => {
      if (!cancelled) setContactGroups(g);
    });
    return () => {
      cancelled = true;
    };
  }, [contact.id]);

  async function handleSave() {
    setIsLoading(true);
    try {
      await updateContact(contact.id, {
        ...draft,
        emails: draft.emails,
        phones: draft.phones,
        addresses: draft.addresses,
      });
      updateContactInPlace(contact.id, {
        displayName: draft.displayName,
        company: draft.company,
        jobTitle: draft.jobTitle,
        notes: draft.notes,
        emails: draft.emails,
        phones: draft.phones,
        addresses: draft.addresses,
      });
      setIsEditing(false);
      onUpdate();
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete ${contact.displayName || contact.email}?`)) return;
    await deleteContact(contact.id);
    removeContact(contact.id);
  }

  function handleCompose() {
    useComposerStore.getState().openComposer({
      mode: 'new',
      to: [{ name: contact.displayName || contact.email, email: contact.email }],
    });
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(contact.email);
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
  }

  async function toggleGroup(groupId: string) {
    const isMember = contactGroups.some((g) => g.id === groupId);
    if (isMember) {
      await removeContactFromGroup(contact.id, groupId);
    } else {
      await addContactToGroup(contact.id, groupId);
    }
    const updated = await getGroupsForContact(contact.id);
    setContactGroups(updated);
    onUpdate();
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start gap-4 p-5 border-b border-[var(--border)]">
        <ContactAvatar contact={contact} size={64} />
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <input
              type="text"
              value={draft.displayName ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, displayName: e.target.value }))}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-lg font-semibold text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
              placeholder="Display name"
            />
          ) : (
            <>
              <h2 className="text-lg font-semibold text-[var(--foreground)] truncate">
                {contact.displayName || contact.email}
              </h2>
              {contact.displayName && (
                <p className="text-sm text-[var(--muted-text)] truncate">{contact.email}</p>
              )}
            </>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button
              type="button"
              onClick={handleCompose}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity"
            >
              <MailIcon size={13} />
              Compose
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
            >
              <CopyIcon size={13} />
              {copied ? 'Copied' : 'Copy email'}
            </button>
            {isEditing ? (
              <>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  <CheckIcon size={13} />
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft({
                      displayName: contact.displayName,
                      company: contact.company,
                      jobTitle: contact.jobTitle,
                      notes: contact.notes,
                      emails: contact.emails,
                      phones: contact.phones,
                      addresses: contact.addresses,
                    });
                    setIsEditing(false);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
                >
                  <CloseIcon size={13} />
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
              >
                <PencilIcon size={13} />
                Edit
              </button>
            )}
            <button
              type="button"
              onClick={handleDelete}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--destructive)] hover:bg-[var(--hover)] transition-colors"
            >
              <TrashIcon size={13} />
              Delete
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto kylins-scrollbar p-5 space-y-5">
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-text)] mb-2">
            Contact info
          </h3>
          <div className="space-y-3">
            <Labeled label="Company">
              {isEditing ? (
                <input
                  type="text"
                  value={draft.company ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, company: e.target.value }))}
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                />
              ) : (
                <span className="text-sm text-[var(--foreground)]">{contact.company || '—'}</span>
              )}
            </Labeled>
            <Labeled label="Job title">
              {isEditing ? (
                <input
                  type="text"
                  value={draft.jobTitle ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, jobTitle: e.target.value }))}
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                />
              ) : (
                <span className="text-sm text-[var(--foreground)]">{contact.jobTitle || '—'}</span>
              )}
            </Labeled>
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-text)]">
              Emails
            </h3>
            {isEditing && (
              <button
                type="button"
                onClick={() => setDraft((d) => ({ ...d, emails: [...d.emails, { value: '' }] }))}
                className="kylins-link text-xs"
              >
                + Add
              </button>
            )}
          </div>
          <div className="space-y-2">
            {isEditing ? (
              draft.emails.map((email, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={email.value}
                    placeholder="Email"
                    onChange={(e) => {
                      const next = [...draft.emails];
                      next[idx] = { ...email, value: e.target.value };
                      setDraft((d) => ({ ...d, emails: next }));
                    }}
                    className="flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const next = draft.emails.filter((_, i) => i !== idx);
                      setDraft((d) => ({ ...d, emails: next }));
                    }}
                    className="text-[var(--destructive)] hover:opacity-80"
                    aria-label="Remove email"
                  >
                    <CloseIcon size={14} />
                  </button>
                </div>
              ))
            ) : contact.emails.length > 0 ? (
              contact.emails.map((e, i) => (
                <div key={i} className="text-sm text-[var(--foreground)]">
                  {e.value}
                  {e.label && <span className="text-[var(--muted-text)] ml-2">({e.label})</span>}
                </div>
              ))
            ) : (
              <span className="text-sm text-[var(--muted-text)]">No additional emails.</span>
            )}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-text)]">
              Phone numbers
            </h3>
            {isEditing && (
              <button
                type="button"
                onClick={() => setDraft((d) => ({ ...d, phones: [...d.phones, { value: '' }] }))}
                className="kylins-link text-xs"
              >
                + Add
              </button>
            )}
          </div>
          <div className="space-y-2">
            {isEditing ? (
              draft.phones.map((phone, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={phone.value}
                    placeholder="Phone"
                    onChange={(e) => {
                      const next = [...draft.phones];
                      next[idx] = { ...phone, value: e.target.value };
                      setDraft((d) => ({ ...d, phones: next }));
                    }}
                    className="flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const next = draft.phones.filter((_, i) => i !== idx);
                      setDraft((d) => ({ ...d, phones: next }));
                    }}
                    className="text-[var(--destructive)] hover:opacity-80"
                    aria-label="Remove phone"
                  >
                    <CloseIcon size={14} />
                  </button>
                </div>
              ))
            ) : contact.phones.length > 0 ? (
              contact.phones.map((p, i) => (
                <div key={i} className="text-sm text-[var(--foreground)]">
                  {p.value}
                  {p.label && <span className="text-[var(--muted-text)] ml-2">({p.label})</span>}
                </div>
              ))
            ) : (
              <span className="text-sm text-[var(--muted-text)]">No phone numbers.</span>
            )}
          </div>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-text)] mb-2">
            Notes
          </h3>
          {isEditing ? (
            <textarea
              value={draft.notes ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
              rows={4}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)] resize-y"
            />
          ) : (
            <p className="text-sm text-[var(--foreground)] whitespace-pre-wrap">
              {contact.notes || 'No notes.'}
            </p>
          )}
        </section>

        {groups.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-text)] mb-2">
              Groups
            </h3>
            <div className="flex flex-wrap gap-2">
              {groups.map((g) => {
                const active = contactGroups.some((cg) => cg.id === g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggleGroup(g.id)}
                    className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                      active
                        ? 'border-[var(--primary)] bg-[var(--selected)] text-[var(--selected-text)]'
                        : 'border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)]'
                    }`}
                  >
                    {g.name}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-text)] mb-2">
            Activity
          </h3>
          <div className="text-sm text-[var(--muted-text)]">
            Frequency: <span className="text-[var(--foreground)]">{contact.frequency}</span>
          </div>
          {contact.lastContactedAt && (
            <div className="text-sm text-[var(--muted-text)]">
              Last contacted:{' '}
              <span className="text-[var(--foreground)]">
                {new Date(contact.lastContactedAt * 1000).toLocaleString()}
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-[var(--muted-text)]">{label}</span>
      {children}
    </div>
  );
}

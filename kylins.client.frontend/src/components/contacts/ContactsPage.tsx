import { useEffect, useState, useCallback, useMemo } from 'react';
import { useContactStore } from '../../stores/contactStore';
import { useToastStore } from '../../stores/toastStore';
import { ContactList } from './ContactList';
import { ContactDetail } from './ContactDetail';
import { ContactGroupManager } from './ContactGroupManager';
import { PreferencesSectionCard } from '../preferences/PreferencesSectionCard';
import { Modal } from '../ui/Modal';
import { getContacts, getContactGroups, createContact } from '../../services/db/contacts';
import { ContactsIcon, PlusIcon, UploadIcon, DownloadIcon } from '../icons';

import { importVCard, exportVCard } from '../../services/sync/vcard';

export function ContactsPage() {
  const contacts = useContactStore((s) => s.contacts);
  const groups = useContactStore((s) => s.groups);
  const selectedContactId = useContactStore((s) => s.selectedContactId);
  const setContacts = useContactStore((s) => s.setContacts);
  const setGroups = useContactStore((s) => s.setGroups);
  const setIsLoading = useContactStore((s) => s.setIsLoading);
  const addContact = useContactStore((s) => s.addContact);
  const pushToast = useToastStore((s) => s.push);

  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');

  const selectedContact = useMemo(
    () => contacts.find((c) => c.id === selectedContactId) ?? contacts[0] ?? null,
    [contacts, selectedContactId],
  );

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const [loadedContacts, loadedGroups] = await Promise.all([getContacts(), getContactGroups()]);
      setContacts(loadedContacts);
      setGroups(loadedGroups);
    } finally {
      setIsLoading(false);
    }
  }, [setContacts, setGroups, setIsLoading]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleAddContact() {
    const email = newEmail.trim();
    if (!email || !email.includes('@')) {
      pushToast('Please enter a valid email address.', 'error');
      return;
    }
    try {
      const contact = await createContact({ email });
      addContact(contact);
      setNewEmail('');
      setIsAddOpen(false);
      pushToast('Contact added.', 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to add contact.', 'error');
    }
  }

  async function handleImport() {
    setImporting(true);
    try {
      const count = await importVCard();
      if (count > 0) await refresh();
      pushToast(`Imported ${count} contact${count === 1 ? '' : 's'}.`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Import failed.', 'error');
    } finally {
      setImporting(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const path = await exportVCard(contacts);
      if (path) pushToast(`Exported to ${path}`, 'success');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Export failed.', 'error');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <ContactsIcon size={20} className="text-[var(--foreground)]" />
          <h1 className="text-base font-semibold text-[var(--foreground)]">Contacts</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsAddOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity"
          >
            <PlusIcon size={13} />
            Add contact
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={importing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors disabled:opacity-50"
          >
            <UploadIcon size={13} />
            {importing ? 'Importing…' : 'Import'}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors disabled:opacity-50"
          >
            <DownloadIcon size={13} />
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden p-2 gap-2">
        <div className="w-80 rounded-xl border border-[var(--border)] bg-[var(--card)] flex flex-col overflow-hidden">
          <ContactList />
        </div>
        <div className="flex-1 min-w-0 rounded-xl border border-[var(--border)] bg-[var(--card)] flex flex-col overflow-hidden">
          {selectedContact ? (
            <ContactDetail
              key={selectedContact.id}
              contact={selectedContact}
              groups={groups}
              onUpdate={() => void refresh()}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-[var(--muted-text)] text-sm">
              Select a contact to view details.
            </div>
          )}
        </div>
        <div className="w-72 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 overflow-y-auto kylins-scrollbar hidden xl:block">
          <PreferencesSectionCard title="Groups" icon={ContactsIcon}>
            <ContactGroupManager onUpdate={() => void refresh()} />
          </PreferencesSectionCard>
        </div>
      </div>

      <Modal
        isOpen={isAddOpen}
        onClose={() => {
          setIsAddOpen(false);
          setNewEmail('');
        }}
        title="Add contact"
        size="md"
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setIsAddOpen(false);
                setNewEmail('');
              }}
              className="h-11 rounded-md px-3 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--hover)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleAddContact()}
              disabled={!newEmail.trim() || !newEmail.includes('@')}
              className="h-11 rounded-md bg-[var(--primary)] px-3 text-sm text-[var(--primary-fg)] transition-colors hover:opacity-90 disabled:opacity-50"
            >
              Add
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-1">
          <label htmlFor="contact-email" className="text-sm text-[var(--foreground)]">
            Email address
          </label>
          <input
            id="contact-email"
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleAddContact();
              }
            }}
            placeholder="name@example.com"
            className="h-11 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          />
        </div>
      </Modal>
    </div>
  );
}

import { useEffect, useState, useCallback } from 'react';
import { useContactStore } from '../../stores/contactStore';
import { ContactList } from './ContactList';
import { ContactDetail } from './ContactDetail';
import { ContactGroupManager } from './ContactGroupManager';
import { PreferencesSectionCard } from '../preferences/PreferencesSectionCard';
import {
  getContacts,
  getContactGroups,
  createContact,
  type Contact,
} from '../../services/db/contacts';
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

  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const [loadedContacts, loadedGroups] = await Promise.all([
        getContacts(),
        getContactGroups(),
      ]);
      setContacts(loadedContacts);
      setGroups(loadedGroups);
    } finally {
      setIsLoading(false);
    }
  }, [setContacts, setGroups, setIsLoading]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const contact = contacts.find((c) => c.id === selectedContactId) ?? contacts[0] ?? null;
    setSelectedContact(contact);
  }, [contacts, selectedContactId]);

  async function handleAddContact() {
    const email = prompt('Enter email address for the new contact:');
    if (!email || !email.includes('@')) return;
    const contact = await createContact({ email });
    addContact(contact);
  }

  async function handleImport() {
    setImporting(true);
    try {
      const count = await importVCard();
      if (count > 0) await refresh();
      alert(`Imported ${count} contact${count === 1 ? '' : 's'}.`);
    } catch (err) {
      alert(String(err));
    } finally {
      setImporting(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const path = await exportVCard(contacts);
      if (path) alert(`Exported to ${path}`);
    } catch (err) {
      alert(String(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-[var(--surface)]">
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <ContactsIcon size={20} className="text-[var(--primary)]" />
          <h1 className="text-base font-semibold text-[var(--foreground)]">Contacts</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleAddContact}
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

      <div className="flex flex-1 overflow-hidden">
        <div className="w-80 border-r border-[var(--border)] flex flex-col">
          <ContactList />
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
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
        <div className="w-72 border-l border-[var(--border)] p-4 overflow-y-auto kylins-scrollbar hidden xl:block">
          <PreferencesSectionCard title="Groups" icon={ContactsIcon}>
            <ContactGroupManager onUpdate={() => void refresh()} />
          </PreferencesSectionCard>
        </div>
      </div>
    </div>
  );
}

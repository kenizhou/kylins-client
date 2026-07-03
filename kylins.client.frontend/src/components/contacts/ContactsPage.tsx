import { useEffect, useState, useCallback, useMemo } from 'react';
import { useContactStore } from '@/stores/contactStore';
import { useAccountStore } from '@/stores/accountStore';
import { useToastStore } from '@/stores/toastStore';
import { ContactAccountPane } from '@/components/contacts/ContactAccountPane';
import { ContactList } from '@/components/contacts/ContactList';
import { ContactDetail } from '@/components/contacts/ContactDetail';
import { GroupDetail } from '@/components/contacts/GroupDetail';
import { Modal } from '@/components/ui/Modal';
import { getContacts, getContactGroups, createContact } from '@/services/db/contacts';
import { ContactsIcon, PlusIcon, UploadIcon, DownloadIcon } from '@/components/icons';
import { importVCard, exportVCard } from '@/services/sync/vcard';

export function ContactsPage() {
  const contacts = useContactStore((s) => s.contacts);
  const groups = useContactStore((s) => s.groups);
  const selectedContactId = useContactStore((s) => s.selectedContactId);
  const selectedGroupId = useContactStore((s) => s.selectedGroupId);
  const selectedAccountId = useContactStore((s) => s.selectedAccountId);
  const setContacts = useContactStore((s) => s.setContacts);
  const setGroups = useContactStore((s) => s.setGroups);
  const setIsLoading = useContactStore((s) => s.setIsLoading);
  const setSelectedAccountId = useContactStore((s) => s.setSelectedAccountId);
  const addContact = useContactStore((s) => s.addContact);
  const pushToast = useToastStore((s) => s.push);
  const accounts = useAccountStore((s) => s.accounts);

  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');

  const selectedContact = useMemo(
    () => contacts.find((c) => c.id === selectedContactId) ?? null,
    [contacts, selectedContactId],
  );
  const selectedGroup = useMemo(
    () => groups.find((g) => g.id === selectedGroupId) ?? null,
    [groups, selectedGroupId],
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
            className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-11 min-w-11 text-xs font-medium rounded-md bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <PlusIcon size={13} />
            Add contact
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={importing}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-11 min-w-11 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <UploadIcon size={13} />
            {importing ? 'Importing…' : 'Import'}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-11 min-w-11 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <DownloadIcon size={13} />
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden p-2 gap-2">
        <div className="w-56 rounded-xl border border-[var(--border)] bg-[var(--card)] flex flex-col overflow-hidden">
          <ContactAccountPane
            accounts={accounts}
            selectedAccountId={selectedAccountId}
            onSelect={setSelectedAccountId}
          />
        </div>
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
          ) : selectedGroup ? (
            <GroupDetail
              key={selectedGroup.id}
              group={selectedGroup}
              contacts={contacts}
              onUpdate={() => void refresh()}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-[var(--muted-text)] text-sm">
              Select a contact or group to view details.
            </div>
          )}
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
              className="h-11 rounded-md px-3 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleAddContact()}
              disabled={!newEmail.trim() || !newEmail.includes('@')}
              className="h-11 rounded-md bg-[var(--primary)] px-3 text-sm text-[var(--primary-fg)] transition-colors hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
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

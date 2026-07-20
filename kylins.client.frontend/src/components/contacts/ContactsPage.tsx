import { useEffect, useState, useCallback, useMemo } from 'react';
import { useContactStore } from '@/stores/contactStore';
import { useAccountStore } from '@/stores/accountStore';
import { useToastStore } from '@/stores/toastStore';
import { ContactAccountPane } from '@/components/contacts/ContactAccountPane';
import { ContactList } from '@/components/contacts/ContactList';
import { ContactDetail } from '@/components/contacts/ContactDetail';
import { GroupDetail } from '@/components/contacts/GroupDetail';
import { ContactsCommandRibbon } from '@/components/contacts/ContactsCommandRibbon';
import { Modal } from '@/components/ui/Modal';
import { ResizablePaneGroup } from '@/components/layout/ResizablePaneGroup';
import { getContacts, getContactGroups, createContact } from '@/services/db/contacts';
import { importVCard, exportVCard } from '@/services/sync/vcard';
import type { ContactPanelSizes } from '@/stores/contactStore';
import type { ResizablePanelDef } from '@/components/layout/ResizablePaneGroup';

const CONSTRAINTS = {
  account: { min: 12 },
  list: { min: 12 },
  detail: { min: 20 },
} as const;

function normalizeSizes(sizes: ContactPanelSizes): ContactPanelSizes {
  const sum = sizes.account + sizes.list + sizes.detail;
  if (sum === 0) return sizes;
  return {
    account: (sizes.account / sum) * 100,
    list: (sizes.list / sum) * 100,
    detail: (sizes.detail / sum) * 100,
  };
}

function scaleTo(total: number, values: [number, number]): [number, number] {
  const sum = values[0] + values[1];
  if (sum === 0) return [total / 2, total / 2];
  return [(values[0] / sum) * total, (values[1] / sum) * total];
}

function buildLayout(sizes: ContactPanelSizes, showAccountPane: boolean): Record<string, number> {
  if (showAccountPane) {
    const normalized = normalizeSizes(sizes);
    return {
      'contacts-accounts': normalized.account,
      'contacts-list': normalized.list,
      'contacts-detail': normalized.detail,
    };
  }
  const [list, detail] = scaleTo(100, [sizes.list, sizes.detail]);
  return {
    'contacts-list': list,
    'contacts-detail': detail,
  };
}

function writeLayout(
  layout: Record<string, number>,
  sizes: ContactPanelSizes,
  showAccountPane: boolean,
  setContactPanelSizes: (sizes: ContactPanelSizes) => void,
) {
  if (showAccountPane) {
    const next: ContactPanelSizes = {
      account: layout['contacts-accounts'] ?? sizes.account,
      list: layout['contacts-list'] ?? sizes.list,
      detail: layout['contacts-detail'] ?? sizes.detail,
    };
    setContactPanelSizes(normalizeSizes(next));
    return;
  }

  // Account pane is hidden: convert the visible list/detail percentages back to
  // the full three-pane scale so toggling the account pane restores the layout.
  const available = 100 - sizes.account;
  const listScaled = layout['contacts-list'] ?? 50;
  const detailScaled = layout['contacts-detail'] ?? 50;
  setContactPanelSizes({
    account: sizes.account,
    list: (listScaled / 100) * available,
    detail: (detailScaled / 100) * available,
  });
}

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
  const accountPaneVisible = useContactStore((s) => s.accountPaneVisible);
  const contactPanelSizes = useContactStore((s) => s.contactPanelSizes);
  const setContactPanelSizes = useContactStore((s) => s.setContactPanelSizes);
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

  const layout = buildLayout(contactPanelSizes, accountPaneVisible);

  function handleLayoutChanged(nextLayout: Record<string, number>) {
    writeLayout(nextLayout, contactPanelSizes, accountPaneVisible, setContactPanelSizes);
  }

  const panels: ResizablePanelDef[] = [
    {
      id: 'contacts-accounts',
      content: (
        <ContactAccountPane
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          onSelect={setSelectedAccountId}
        />
      ),
      defaultSize: layout['contacts-accounts'] ?? 20,
      minSize: CONSTRAINTS.account.min,
      visible: accountPaneVisible,
      card: true,
    },
    {
      id: 'contacts-list',
      content: <ContactList />,
      defaultSize: layout['contacts-list'] ?? 35,
      minSize: CONSTRAINTS.list.min,
      card: true,
    },
    {
      id: 'contacts-detail',
      content: selectedContact ? (
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
      ),
      defaultSize: layout['contacts-detail'] ?? 45,
      minSize: CONSTRAINTS.detail.min,
      card: true,
    },
  ];

  return (
    <div className="flex flex-1 flex-col h-full">
      <ContactsCommandRibbon
        onAddContact={() => setIsAddOpen(true)}
        onImport={handleImport}
        onExport={handleExport}
        importing={importing}
        exporting={exporting}
      />

      <ResizablePaneGroup
        key={accountPaneVisible ? 'with-account' : 'no-account'}
        className="flex-1 w-full p-2"
        panels={panels}
        onLayoutChanged={handleLayoutChanged}
      />

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
            className="h-11 w-full rounded-md border border-[var(--border-subtle)] bg-surface-elevated px-3 text-sm text-[var(--foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          />
        </div>
      </Modal>
    </div>
  );
}

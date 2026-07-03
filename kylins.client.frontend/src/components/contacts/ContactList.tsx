import { useMemo } from 'react';
import { SearchField, Input, Button } from 'react-aria-components';
import { useContactStore } from '@/stores/contactStore';
import { ContactAvatar } from '@/components/contacts/ContactAvatar';
import type { Contact, ContactGroup } from '@/services/db/contacts';
import { SearchIcon, CloseIcon, ContactsIcon } from '@/components/icons';

const LOCAL_SENTINEL = 'local';

type ListItem =
  | { kind: 'contact'; id: string; sortKey: string; data: Contact }
  | { kind: 'group'; id: string; sortKey: string; data: ContactGroup };

function matchesAccount(item: ListItem, selectedAccountId: string | null): boolean {
  if (selectedAccountId === null) return true;
  const accountId = item.data.accountId ?? null;
  if (selectedAccountId === LOCAL_SENTINEL) return accountId === null;
  return accountId === selectedAccountId;
}

function matchesSearch(item: ListItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (item.kind === 'contact') {
    const c = item.data;
    return (
      (c.displayName?.toLowerCase().includes(q) ?? false) ||
      c.email.toLowerCase().includes(q) ||
      (c.company?.toLowerCase().includes(q) ?? false)
    );
  }
  return item.data.name.toLowerCase().includes(q);
}

export function ContactList() {
  const contacts = useContactStore((s) => s.contacts);
  const groups = useContactStore((s) => s.groups);
  const selectedContactId = useContactStore((s) => s.selectedContactId);
  const selectedGroupId = useContactStore((s) => s.selectedGroupId);
  const selectedAccountId = useContactStore((s) => s.selectedAccountId);
  const searchQuery = useContactStore((s) => s.searchQuery);
  const isLoading = useContactStore((s) => s.isLoading);
  const setSelectedContactId = useContactStore((s) => s.setSelectedContactId);
  const setSelectedGroupId = useContactStore((s) => s.setSelectedGroupId);
  const setSearchQuery = useContactStore((s) => s.setSearchQuery);

  const items = useMemo<ListItem[]>(() => {
    const list: ListItem[] = [
      ...contacts.map((c) => ({
        kind: 'contact' as const,
        id: c.id,
        sortKey: (c.displayName ?? c.email).trim().toLowerCase(),
        data: c,
      })),
      ...groups.map((g) => ({
        kind: 'group' as const,
        id: g.id,
        sortKey: g.name.trim().toLowerCase(),
        data: g,
      })),
    ];
    return list
      .filter((item) => matchesAccount(item, selectedAccountId))
      .filter((item) => matchesSearch(item, searchQuery))
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }, [contacts, groups, selectedAccountId, searchQuery]);

  return (
    <div className="flex flex-col h-full min-w-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
        <SearchField
          value={searchQuery}
          onChange={setSearchQuery}
          className="relative flex-1"
          aria-label="Search contacts and groups"
        >
          <SearchIcon
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted-text)]"
          />
          <Input className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] pl-8 pr-14 py-1.5 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-text)]/60 focus:border-[var(--primary)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] min-h-11" />
          {searchQuery !== '' && (
            <Button
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center rounded p-0.5 min-h-11 min-w-11 text-[var(--muted-text)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              <CloseIcon size={14} />
            </Button>
          )}
        </SearchField>
      </div>

      <div className="flex-1 overflow-y-auto kylins-scrollbar p-2">
        {isLoading ? (
          <div className="p-4 text-sm text-[var(--muted-text)]">Loading contacts…</div>
        ) : items.length === 0 ? (
          <div className="p-4 text-sm text-[var(--muted-text)]">
            {searchQuery || selectedAccountId ? 'No matching contacts.' : 'No contacts yet.'}
          </div>
        ) : (
          <ul className="space-y-1" role="listbox">
            {items.map((item) => {
              if (item.kind === 'group') {
                const active = item.id === selectedGroupId;
                return (
                  <li
                    key={`group-${item.id}`}
                    role="option"
                    tabIndex={0}
                    aria-selected={active}
                    onClick={() => setSelectedGroupId(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedGroupId(item.id);
                      }
                    }}
                    className={`flex items-center gap-3 rounded-lg border px-3 py-2 min-h-11 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
                      active
                        ? 'border-[var(--primary)] bg-[var(--selected)]'
                        : 'border-[var(--border)] bg-[var(--background)] hover:bg-[var(--hover)]'
                    }`}
                  >
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--secondary)] text-[var(--secondary-foreground)]">
                      <ContactsIcon size={16} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--foreground)] truncate">
                        {item.data.name}
                      </div>
                      <div className="text-xs text-[var(--muted-text)]">Group</div>
                    </div>
                  </li>
                );
              }

              const contact = item.data;
              const active = contact.id === selectedContactId;
              return (
                <li
                  key={`contact-${contact.id}`}
                  role="option"
                  tabIndex={0}
                  aria-selected={active}
                  onClick={() => setSelectedContactId(contact.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedContactId(contact.id);
                    }
                  }}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2 min-h-11 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
                    active
                      ? 'border-[var(--primary)] bg-[var(--selected)]'
                      : 'border-[var(--border)] bg-[var(--background)] hover:bg-[var(--hover)]'
                  }`}
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
                  {contact.frequency > 0 && (
                    <span className="text-[10px] text-[var(--muted-text)]">
                      {contact.frequency}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

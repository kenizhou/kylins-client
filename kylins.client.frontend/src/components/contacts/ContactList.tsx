import { useEffect, useMemo, useState } from 'react';
import { useContactStore } from '../../stores/contactStore';
import { ContactAvatar } from './ContactAvatar';
import { getContactIdsForGroup, type Contact } from '../../services/db/contacts';
import { SearchIcon } from '../icons';

export function ContactList() {
  const contacts = useContactStore((s) => s.contacts);
  const groups = useContactStore((s) => s.groups);
  const selectedId = useContactStore((s) => s.selectedContactId);
  const selectedGroupId = useContactStore((s) => s.selectedGroupId);
  const searchQuery = useContactStore((s) => s.searchQuery);
  const isLoading = useContactStore((s) => s.isLoading);
  const setSelectedContactId = useContactStore((s) => s.setSelectedContactId);
  const setSearchQuery = useContactStore((s) => s.setSearchQuery);
  const setSelectedGroupId = useContactStore((s) => s.setSelectedGroupId);

  const [groupContactIds, setGroupContactIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!selectedGroupId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGroupContactIds(new Set());
      return;
    }
    let cancelled = false;
    getContactIdsForGroup(selectedGroupId).then((ids) => {
      if (cancelled) return;
       
      setGroupContactIds(new Set(ids));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedGroupId]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return contacts.filter((c) => {
      if (c.isHidden) return false;
      if (selectedGroupId && !groupContactIds.has(c.id)) return false;
      if (!q) return true;
      return (
        c.displayName?.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.company?.toLowerCase().includes(q)
      );
    });
  }, [contacts, searchQuery, selectedGroupId, groupContactIds]);

  const grouped = useMemo(() => {
    const map = new Map<string, Contact[]>();
    for (const c of filtered) {
      const letter = (c.displayName ?? c.email).trim()[0]?.toUpperCase() ?? '#';
      const bucket = /^[A-Z]$/.test(letter) ? letter : '#';
      if (!map.has(bucket)) map.set(bucket, []);
      map.get(bucket)!.push(c);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <div className="flex flex-col h-full min-w-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
        <div className="relative flex-1">
          <SearchIcon
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted-text)]"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search contacts…"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] pl-8 pr-3 py-1.5 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-text)]/60 focus:border-[var(--primary)]"
          />
        </div>
        {groups.length > 0 && (
          <select
            value={selectedGroupId ?? ''}
            onChange={(e) => setSelectedGroupId(e.target.value || null)}
            className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)] outline-none"
          >
            <option value="">All contacts</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex-1 overflow-y-auto kylins-scrollbar p-2">
        {isLoading ? (
          <div className="p-4 text-sm text-[var(--muted-text)]">Loading contacts…</div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-sm text-[var(--muted-text)]">
            {searchQuery || selectedGroupId ? 'No matching contacts.' : 'No contacts yet.'}
          </div>
        ) : (
          grouped.map(([letter, items]) => (
            <div key={letter}>
              <div className="sticky top-0 px-2 py-1 text-xs font-semibold text-[var(--muted-text)] bg-[var(--surface)]">
                {letter}
              </div>
              <ul className="space-y-1">
                {items.map((contact) => {
                  const active = contact.id === selectedId;
                  return (
                    <li
                      key={contact.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedContactId(contact.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedContactId(contact.id);
                        }
                      }}
                      className={`flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
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
            </div>
          ))
        )}
      </div>
    </div>
  );
}

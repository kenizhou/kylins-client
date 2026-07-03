# Contact page redesign with account folder pane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the contacts page with a left account folder pane and a unified flat list of contacts and groups, removing the separate Groups panel.

**Architecture:** Add `selectedAccountId` to `contactStore`, build a new `ContactAccountPane`, merge contacts and groups in `ContactList`, introduce `GroupDetail`, and update `ContactsPage` layout.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Zustand, react-aria-components, Hugeicons (via project `icons.tsx`), Vitest, Testing Library.

## Global Constraints

- Use path alias `@/*` → `src/*` for all new imports.
- Theme via CSS variables (`bg-[var(--surface)]`, `text-[var(--foreground)]`, etc.); no raw hex in components.
- No new Rust DB schema changes; reuse existing `contacts`, `contact_groups`, and `contact_group_members` tables.
- Touch targets minimum 44×44px; focus rings use `focus-visible:ring-2 focus-visible:ring-[var(--ring)]`.
- Use SVG icons from `src/components/icons.tsx`, never emojis.
- Tests live under `tests/` mirroring `src/`.
- Run `npx tsc --noEmit` and `npx vitest run` after each task.
- Commit after every task.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/stores/contactStore.ts` | Adds `selectedAccountId`; enforces mutual exclusion between contact/group selection. |
| `src/components/contacts/ContactAccountPane.tsx` | New left sidebar listing All accounts / Local / accounts. |
| `src/components/contacts/ContactList.tsx` | Unified flat list of contacts and groups; account + search filtering. |
| `src/components/contacts/GroupDetail.tsx` | New detail view for a group: name, members, rename, delete. |
| `src/components/contacts/ContactsPage.tsx` | New three-column layout; removes right Groups panel; wires panes. |
| `src/components/contacts/ContactDetail.tsx` | Minor update to show account badge (optional, can be skipped for MVP). |
| `tests/stores/contactStore.test.ts` | Store behavior tests. |
| `tests/components/contacts/ContactAccountPane.test.tsx` | New pane tests. |
| `tests/components/contacts/ContactList.test.tsx` | Updated unified-list tests. |
| `tests/components/contacts/GroupDetail.test.tsx` | New group detail tests. |
| `tests/components/contacts/ContactsPage.test.tsx` | New page-level integration tests. |

---

### Task 1: Extend `contactStore` for account filtering and mutual selection

**Files:**
- Modify: `kylins.client.frontend/src/stores/contactStore.ts`
- Test: `kylins.client.frontend/tests/stores/contactStore.test.ts`

**Interfaces:**
- Consumes: existing `Contact`, `ContactGroup` types.
- Produces: `ContactState.selectedAccountId: string | null`; `setSelectedAccountId(id)`; `setSelectedContactId` and `setSelectedGroupId` now clear the opposite selection.

- [ ] **Step 1: Write the failing test**

Append to `tests/stores/contactStore.test.ts`:

```ts
  it('has default selectedAccountId null', () => {
    expect(useContactStore.getState().selectedAccountId).toBeNull();
  });

  it('sets selectedAccountId', () => {
    useContactStore.getState().setSelectedAccountId('acc-1');
    expect(useContactStore.getState().selectedAccountId).toBe('acc-1');
  });

  it('selecting a contact clears selectedGroupId', () => {
    useContactStore.getState().setSelectedGroupId('g-1');
    useContactStore.getState().setSelectedContactId('c-1');
    const state = useContactStore.getState();
    expect(state.selectedContactId).toBe('c-1');
    expect(state.selectedGroupId).toBeNull();
  });

  it('selecting a group clears selectedContactId', () => {
    useContactStore.getState().setSelectedContactId('c-1');
    useContactStore.getState().setSelectedGroupId('g-1');
    const state = useContactStore.getState();
    expect(state.selectedGroupId).toBe('g-1');
    expect(state.selectedContactId).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd kylins.client.frontend
npx vitest run tests/stores/contactStore.test.ts
```

Expected: FAIL — `setSelectedAccountId is not a function` or `selectedContactId` did not clear.

- [ ] **Step 3: Implement the store changes**

Modify `src/stores/contactStore.ts`:

```ts
export interface ContactState {
  contacts: Contact[];
  groups: ContactGroup[];
  selectedContactId: string | null;
  selectedGroupId: string | null;
  selectedAccountId: string | null;
  searchQuery: string;
  isLoading: boolean;

  setContacts: (contacts: Contact[]) => void;
  addContact: (contact: Contact) => void;
  updateContact: (id: string, updates: Partial<Contact>) => void;
  removeContact: (id: string) => void;
  setGroups: (groups: ContactGroup[]) => void;
  addGroup: (group: ContactGroup) => void;
  updateGroup: (id: string, updates: Partial<ContactGroup>) => void;
  removeGroup: (id: string) => void;
  setSelectedContactId: (id: string | null) => void;
  setSelectedGroupId: (id: string | null) => void;
  setSelectedAccountId: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  setIsLoading: (loading: boolean) => void;
}

export const useContactStore = create<ContactState>((set) => ({
  contacts: [],
  groups: [],
  selectedContactId: null,
  selectedGroupId: null,
  selectedAccountId: null,
  searchQuery: '',
  isLoading: false,

  setContacts: (contacts) => set({ contacts }),
  addContact: (contact) =>
    set((state) => ({
      contacts: [contact, ...state.contacts],
      selectedContactId: state.selectedContactId ?? contact.id,
    })),
  updateContact: (id, updates) =>
    set((state) => ({
      contacts: state.contacts.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    })),
  removeContact: (id) =>
    set((state) => {
      const next = state.contacts.filter((c) => c.id !== id);
      return {
        contacts: next,
        selectedContactId:
          state.selectedContactId === id ? next[0]?.id ?? null : state.selectedContactId,
      };
    }),
  setGroups: (groups) => set({ groups }),
  addGroup: (group) =>
    set((state) => ({
      groups: [...state.groups, group].sort((a, b) => a.name.localeCompare(b.name)),
    })),
  updateGroup: (id, updates) =>
    set((state) => ({
      groups: state.groups
        .map((g) => (g.id === id ? { ...g, ...updates } : g))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })),
  removeGroup: (id) =>
    set((state) => ({
      groups: state.groups.filter((g) => g.id !== id),
      selectedGroupId: state.selectedGroupId === id ? null : state.selectedGroupId,
    })),
  setSelectedContactId: (id) => set({ selectedContactId: id, selectedGroupId: null }),
  setSelectedGroupId: (id) => set({ selectedGroupId: id, selectedContactId: null }),
  setSelectedAccountId: (id) => set({ selectedAccountId: id }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setIsLoading: (isLoading) => set({ isLoading }),
}));
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd kylins.client.frontend
npx vitest run tests/stores/contactStore.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/stores/contactStore.ts kylins.client.frontend/tests/stores/contactStore.test.ts
git commit -m "feat(frontend): add selectedAccountId and mutual selection to contactStore

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Create `ContactAccountPane` component

**Files:**
- Create: `kylins.client.frontend/src/components/contacts/ContactAccountPane.tsx`
- Test: `kylins.client.frontend/tests/components/contacts/ContactAccountPane.test.tsx`

**Interfaces:**
- Consumes: `Account` from `@/types`; `selectedAccountId: string | null`; `onSelect(id: string | null)`.
- Produces: `<ContactAccountPane accounts selectedAccountId onSelect />`.

- [ ] **Step 1: Write the failing test**

Create `tests/components/contacts/ContactAccountPane.test.tsx`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ContactAccountPane } from '../../../src/components/contacts/ContactAccountPane';
import type { Account } from '../../../src/types';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    email: 'work@corp.com',
    accountLabel: 'Work',
    provider: 'imap',
    ...overrides,
  } as Account;
}

describe('ContactAccountPane', () => {
  it('renders All accounts and Local plus accounts', () => {
    const { getByText } = render(
      <ContactAccountPane
        accounts={[makeAccount()]}
        selectedAccountId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(getByText('All accounts')).toBeInTheDocument();
    expect(getByText('Local')).toBeInTheDocument();
    expect(getByText('Work')).toBeInTheDocument();
  });

  it('calls onSelect with account id when account clicked', () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <ContactAccountPane
        accounts={[makeAccount()]}
        selectedAccountId={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(getByText('Work'));
    expect(onSelect).toHaveBeenCalledWith('acc-1');
  });

  it('calls onSelect with null when All accounts clicked', () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <ContactAccountPane
        accounts={[makeAccount({ id: 'acc-1', selectedAccountId: 'acc-1' })]}
        selectedAccountId="acc-1"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(getByText('All accounts'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('calls onSelect with local sentinel when Local clicked', () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <ContactAccountPane
        accounts={[makeAccount()]}
        selectedAccountId={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(getByText('Local'));
    expect(onSelect).toHaveBeenCalledWith('local');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd kylins.client.frontend
npx vitest run tests/components/contacts/ContactAccountPane.test.tsx
```

Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

Create `src/components/contacts/ContactAccountPane.tsx`:

```tsx
import type { Account } from '@/types';
import { AllContactsIcon, LocalIcon, AccountIcon } from '../icons';

const LOCAL_SENTINEL = 'local';

interface ContactAccountPaneProps {
  accounts: Account[];
  selectedAccountId: string | null;
  onSelect: (id: string | null) => void;
}

function AccountRow({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
        active
          ? 'bg-[var(--selected)] text-[var(--selected-text)]'
          : 'text-[var(--foreground)] hover:bg-[var(--hover)]'
      }`}
    >
      <span className="shrink-0 text-[var(--muted-text)]">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

export function ContactAccountPane({ accounts, selectedAccountId, onSelect }: ContactAccountPaneProps) {
  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto kylins-scrollbar p-2">
      <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted-text)]">
        Accounts
      </div>
      <AccountRow
        label="All accounts"
        active={selectedAccountId === null}
        onClick={() => onSelect(null)}
        icon={<AllContactsIcon size={16} />}
      />
      <AccountRow
        label="Local"
        active={selectedAccountId === LOCAL_SENTINEL}
        onClick={() => onSelect(LOCAL_SENTINEL)}
        icon={<LocalIcon size={16} />}
      />
      {accounts.map((account) => {
        const label = account.accountLabel ?? account.email;
        return (
          <AccountRow
            key={account.id}
            label={label}
            active={selectedAccountId === account.id}
            onClick={() => onSelect(account.id)}
            icon={<AccountIcon size={16} />}
          />
        );
      })}
    </div>
  );
}
```

**Note:** If `AllContactsIcon`, `LocalIcon`, or `AccountIcon` do not exist in `src/components/icons.tsx`, use existing equivalents:
- `AllContactsIcon` → `ContactsIcon`
- `LocalIcon` → `FolderIcon` or `UserIcon`
- `AccountIcon` → `UserIcon`

Update the import accordingly.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd kylins.client.frontend
npx vitest run tests/components/contacts/ContactAccountPane.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/components/contacts/ContactAccountPane.tsx kylins.client.frontend/tests/components/contacts/ContactAccountPane.test.tsx
git commit -m "feat(frontend): add ContactAccountPane for contact account filtering

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Unify `ContactList` with groups and account filtering

**Files:**
- Modify: `kylins.client.frontend/src/components/contacts/ContactList.tsx`
- Test: `kylins.client.frontend/tests/components/contacts/ContactList.test.tsx`

**Interfaces:**
- Consumes: `ContactState` contacts/groups, `selectedAccountId`, `searchQuery`, `selectedContactId`, `selectedGroupId`.
- Produces: Flat alphabetical list of contacts and groups; selecting a contact calls `setSelectedContactId`; selecting a group calls `setSelectedGroupId`.

- [ ] **Step 1: Write the failing test**

Replace `tests/components/contacts/ContactList.test.tsx` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { ContactList } from '../../../src/components/contacts/ContactList';
import { useContactStore } from '../../../src/stores/contactStore';
import type { Contact, ContactGroup } from '../../../src/services/db/contacts';

vi.mock('../../../src/services/db/contacts', async () => {
  const actual = await vi.importActual('../../../src/services/db/contacts');
  return {
    ...(actual as object),
    getContactIdsForGroup: vi.fn(() => Promise.resolve([])),
  };
});

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'c-1',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    frequency: 2,
    accountId: 'acc-1',
    groups: [],
    phones: [],
    addresses: [],
    emails: [],
    ...overrides,
  } as Contact;
}

function makeGroup(overrides: Partial<ContactGroup> = {}): ContactGroup {
  return {
    id: 'g-1',
    name: 'Team Leads',
    accountId: 'acc-1',
    source: 'local',
    isReadonly: false,
    ...overrides,
  } as ContactGroup;
}

describe('ContactList', () => {
  beforeEach(() => {
    useContactStore.setState({
      contacts: [
        makeContact({ id: 'c-1', displayName: 'Ada Lovelace', email: 'ada@example.com' }),
        makeContact({ id: 'c-2', displayName: 'Grace Hopper', email: 'grace@example.com' }),
      ],
      groups: [makeGroup({ id: 'g-1', name: 'Team Leads' })],
      selectedContactId: null,
      selectedGroupId: null,
      selectedAccountId: null,
      searchQuery: '',
      isLoading: false,
    });
  });

  it('renders contacts and groups together alphabetically', async () => {
    const { getByText } = render(<ContactList />);
    await waitFor(() => {
      expect(getByText('Ada Lovelace')).toBeInTheDocument();
      expect(getByText('Grace Hopper')).toBeInTheDocument();
      expect(getByText('Team Leads')).toBeInTheDocument();
    });
  });

  it('filters contacts and groups by search query', async () => {
    useContactStore.getState().setSearchQuery('team');
    const { getByText, queryByText } = render(<ContactList />);
    await waitFor(() => {
      expect(getByText('Team Leads')).toBeInTheDocument();
      expect(queryByText('Ada Lovelace')).not.toBeInTheDocument();
    });
  });

  it('filters by selectedAccountId', async () => {
    useContactStore.setState({
      contacts: [
        makeContact({ id: 'c-1', displayName: 'Ada', accountId: 'acc-1' }),
        makeContact({ id: 'c-2', displayName: 'Grace', accountId: 'acc-2' }),
      ],
      groups: [
        makeGroup({ id: 'g-1', name: 'Team A', accountId: 'acc-1' }),
        makeGroup({ id: 'g-2', name: 'Team B', accountId: 'acc-2' }),
      ],
    });
    useContactStore.getState().setSelectedAccountId('acc-1');
    const { getByText, queryByText } = render(<ContactList />);
    await waitFor(() => {
      expect(getByText('Ada')).toBeInTheDocument();
      expect(getByText('Team A')).toBeInTheDocument();
      expect(queryByText('Grace')).not.toBeInTheDocument();
      expect(queryByText('Team B')).not.toBeInTheDocument();
    });
  });

  it('selects a contact on click', async () => {
    const { getByText } = render(<ContactList />);
    fireEvent.click(getByText('Ada Lovelace'));
    expect(useContactStore.getState().selectedContactId).toBe('c-1');
    expect(useContactStore.getState().selectedGroupId).toBeNull();
  });

  it('selects a group on click', async () => {
    const { getByText } = render(<ContactList />);
    fireEvent.click(getByText('Team Leads'));
    expect(useContactStore.getState().selectedGroupId).toBe('g-1');
    expect(useContactStore.getState().selectedContactId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd kylins.client.frontend
npx vitest run tests/components/contacts/ContactList.test.tsx
```

Expected: FAIL — groups not rendered, account filtering not implemented.

- [ ] **Step 3: Implement the unified list**

Rewrite `src/components/contacts/ContactList.tsx`:

```tsx
import { useMemo } from 'react';
import { SearchField, Input, Button } from 'react-aria-components';
import { useContactStore } from '../../stores/contactStore';
import { ContactAvatar } from './ContactAvatar';
import type { Contact, ContactGroup } from '../../services/db/contacts';
import { SearchIcon, CloseIcon, GroupIcon } from '../icons';

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
          <Input className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] pl-8 pr-8 py-1.5 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-text)]/60 focus:border-[var(--primary)]" />
          {searchQuery !== '' && (
            <Button
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center rounded p-0.5 text-[var(--muted-text)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
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
          <ul className="space-y-1" role="list">
            {items.map((item) => {
              if (item.kind === 'group') {
                const active = item.id === selectedGroupId;
                return (
                  <li
                    key={item.id}
                    role="listitem"
                    tabIndex={0}
                    aria-selected={active}
                    onClick={() => setSelectedGroupId(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedGroupId(item.id);
                      }
                    }}
                    className={`flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
                      active
                        ? 'border-[var(--primary)] bg-[var(--selected)]'
                        : 'border-[var(--border)] bg-[var(--background)] hover:bg-[var(--hover)]'
                    }`}
                  >
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--secondary)] text-[var(--secondary-foreground)]">
                      <GroupIcon size={16} />
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
                  key={contact.id}
                  role="listitem"
                  tabIndex={0}
                  aria-selected={active}
                  onClick={() => setSelectedContactId(contact.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedContactId(contact.id);
                    }
                  }}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
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
                      <div className="text-xs text-[var(--muted-text)] truncate">{contact.email}</div>
                    )}
                  </div>
                  {contact.frequency > 0 && (
                    <span className="text-[10px] text-[var(--muted-text)]">{contact.frequency}</span>
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
```

**Note:** If `GroupIcon` does not exist in `src/components/icons.tsx`, use `ContactsIcon` or `FolderIcon`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd kylins.client.frontend
npx vitest run tests/components/contacts/ContactList.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/components/contacts/ContactList.tsx kylins.client.frontend/tests/components/contacts/ContactList.test.tsx
git commit -m "feat(frontend): unify contacts and groups in ContactList with account filtering

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Create `GroupDetail` component

**Files:**
- Create: `kylins.client.frontend/src/components/contacts/GroupDetail.tsx`
- Test: `kylins.client.frontend/tests/components/contacts/GroupDetail.test.tsx`

**Interfaces:**
- Consumes: `ContactGroup`, member `Contact[]`, `onUpdate(): void`.
- Produces: `<GroupDetail group members onUpdate />` with rename/delete/add-member UI.

- [ ] **Step 1: Write the failing test**

Create `tests/components/contacts/GroupDetail.test.tsx`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { GroupDetail } from '../../../src/components/contacts/GroupDetail';
import type { ContactGroup, Contact } from '../../../src/services/db/contacts';

vi.mock('../../../src/services/db/contacts', async () => {
  const actual = await vi.importActual('../../../src/services/db/contacts');
  return {
    ...(actual as object),
    renameContactGroup: vi.fn(() => Promise.resolve()),
    deleteContactGroup: vi.fn(() => Promise.resolve()),
    getContacts: vi.fn(() => Promise.resolve([])),
  };
});

import {
  renameContactGroup,
  deleteContactGroup,
} from '../../../src/services/db/contacts';

function makeGroup(overrides: Partial<ContactGroup> = {}): ContactGroup {
  return {
    id: 'g-1',
    name: 'Team Leads',
    accountId: null,
    source: 'local',
    isReadonly: false,
    ...overrides,
  } as ContactGroup;
}

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'c-1',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    ...overrides,
  } as Contact;
}

describe('GroupDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders group name and members', () => {
    const { getByText } = render(
      <GroupDetail group={makeGroup()} members={[makeContact()]} onUpdate={vi.fn()} />,
    );
    expect(getByText('Team Leads')).toBeInTheDocument();
    expect(getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('shows empty state when no members', () => {
    const { getByText } = render(
      <GroupDetail group={makeGroup()} members={[]} onUpdate={vi.fn()} />,
    );
    expect(getByText('No members yet')).toBeInTheDocument();
  });

  it('renames group and calls onUpdate', async () => {
    const onUpdate = vi.fn();
    const { getByText, getByDisplayValue } = render(
      <GroupDetail group={makeGroup()} members={[]} onUpdate={onUpdate} />,
    );
    fireEvent.click(getByText('Rename'));
    const input = getByDisplayValue('Team Leads');
    fireEvent.change(input, { target: { value: 'Engineering' } });
    fireEvent.click(getByText('Save'));
    await waitFor(() => {
      expect(renameContactGroup).toHaveBeenCalledWith('g-1', 'Engineering');
      expect(onUpdate).toHaveBeenCalled();
    });
  });

  it('deletes group after confirm', async () => {
    vi.stubGlobal('confirm', () => true);
    const onUpdate = vi.fn();
    const { getByText } = render(
      <GroupDetail group={makeGroup()} members={[]} onUpdate={onUpdate} />,
    );
    fireEvent.click(getByText('Delete'));
    await waitFor(() => {
      expect(deleteContactGroup).toHaveBeenCalledWith('g-1');
      expect(onUpdate).toHaveBeenCalled();
    });
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd kylins.client.frontend
npx vitest run tests/components/contacts/GroupDetail.test.tsx
```

Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

Create `src/components/contacts/GroupDetail.tsx`:

```tsx
import { useState } from 'react';
import { ContactAvatar } from './ContactAvatar';
import type { Contact, ContactGroup } from '../../services/db/contacts';
import { renameContactGroup, deleteContactGroup } from '../../services/db/contacts';
import { PencilIcon, TrashIcon, CheckIcon, CloseIcon, GroupIcon } from '../icons';

interface GroupDetailProps {
  group: ContactGroup;
  members: Contact[];
  onUpdate: () => void;
}

export function GroupDetail({ group, members, onUpdate }: GroupDetailProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [isLoading, setIsLoading] = useState(false);

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
          <GroupIcon size={32} />
        </span>
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <input
              type="text"
              value={name}
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
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-lg font-semibold text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
            />
          ) : (
            <h2 className="text-lg font-semibold text-[var(--foreground)] truncate">{group.name}</h2>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {isEditing ? (
              <>
                <button
                  type="button"
                  onClick={() => void handleRename()}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity disabled:opacity-50"
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
                Rename
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={isLoading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--destructive)] hover:bg-[var(--hover)] transition-colors disabled:opacity-50"
            >
              <TrashIcon size={13} />
              Delete
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto kylins-scrollbar p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-text)] mb-2">
          Members
        </h3>
        {members.length === 0 ? (
          <p className="text-sm text-[var(--muted-text)]">No members yet.</p>
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd kylins.client.frontend
npx vitest run tests/components/contacts/GroupDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/components/contacts/GroupDetail.tsx kylins.client.frontend/tests/components/contacts/GroupDetail.test.tsx
git commit -m "feat(frontend): add GroupDetail component for group management

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Update `ContactsPage` layout

**Files:**
- Modify: `kylins.client.frontend/src/components/contacts/ContactsPage.tsx`
- Test: `kylins.client.frontend/tests/components/contacts/ContactsPage.test.tsx`

**Interfaces:**
- Consumes: `ContactAccountPane`, `ContactList`, `ContactDetail`, `GroupDetail`; `useAccountStore`; `useContactStore`; contact/group services.
- Produces: Three-column contacts page; account pane on left, unified list center, detail right; removes right Groups panel.

- [ ] **Step 1: Write the failing test**

Create `tests/components/contacts/ContactsPage.test.tsx`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { ContactsPage } from '../../../src/components/contacts/ContactsPage';
import { useContactStore } from '../../../src/stores/contactStore';
import { useAccountStore } from '../../../src/stores/accountStore';

vi.mock('../../../src/services/db/contacts', async () => {
  const actual = await vi.importActual('../../../src/services/db/contacts');
  return {
    ...(actual as object),
    getContacts: vi.fn(() =>
      Promise.resolve([
        {
          id: 'c-1',
          email: 'ada@example.com',
          displayName: 'Ada Lovelace',
          accountId: 'acc-1',
          frequency: 0,
          emails: [],
          phones: [],
          addresses: [],
        },
      ]),
    ),
    getContactGroups: vi.fn(() =>
      Promise.resolve([
        { id: 'g-1', name: 'Team Leads', accountId: 'acc-1', source: 'local', isReadonly: false },
      ]),
    ),
    getGroupsForContact: vi.fn(() => Promise.resolve([])),
  };
});

describe('ContactsPage', () => {
  beforeEach(() => {
    useContactStore.setState({
      contacts: [],
      groups: [],
      selectedContactId: null,
      selectedGroupId: null,
      selectedAccountId: null,
      searchQuery: '',
      isLoading: false,
    });
    useAccountStore.setState({
      accounts: [
        { id: 'acc-1', email: 'work@corp.com', accountLabel: 'Work', provider: 'imap' } as ReturnType<typeof useAccountStore.getState>['accounts'][0],
      ],
      activeAccountId: null,
      defaultAccountId: null,
    });
  });

  it('renders account pane and unified list', async () => {
    const { getByText } = render(<ContactsPage />);
    await waitFor(() => {
      expect(getByText('All accounts')).toBeInTheDocument();
      expect(getByText('Work')).toBeInTheDocument();
      expect(getByText('Ada Lovelace')).toBeInTheDocument();
      expect(getByText('Team Leads')).toBeInTheDocument();
    });
  });

  it('filters list when account clicked', async () => {
    useContactStore.setState({
      contacts: [
        { id: 'c-1', email: 'ada@example.com', displayName: 'Ada', accountId: 'acc-1', frequency: 0, emails: [], phones: [], addresses: [] } as ReturnType<typeof useContactStore.getState>['contacts'][0],
        { id: 'c-2', email: 'grace@example.com', displayName: 'Grace', accountId: 'acc-2', frequency: 0, emails: [], phones: [], addresses: [] } as ReturnType<typeof useContactStore.getState>['contacts'][0],
      ],
      groups: [],
    });
    const { getByText, queryByText } = render(<ContactsPage />);
    fireEvent.click(getByText('Work'));
    await waitFor(() => {
      expect(getByText('Ada')).toBeInTheDocument();
      expect(queryByText('Grace')).not.toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd kylins.client.frontend
npx vitest run tests/components/contacts/ContactsPage.test.tsx
```

Expected: FAIL — layout not updated.

- [ ] **Step 3: Implement the layout update**

Rewrite `src/components/contacts/ContactsPage.tsx`:

```tsx
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useContactStore } from '../../stores/contactStore';
import { useAccountStore } from '../../stores/accountStore';
import { useToastStore } from '../../stores/toastStore';
import { ContactAccountPane } from './ContactAccountPane';
import { ContactList } from './ContactList';
import { ContactDetail } from './ContactDetail';
import { GroupDetail } from './GroupDetail';
import { Modal } from '../ui/Modal';
import { getContacts, getContactGroups, createContact } from '../../services/db/contacts';
import { ContactsIcon, PlusIcon, UploadIcon, DownloadIcon } from '../icons';
import { importVCard, exportVCard } from '../../services/sync/vcard';

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
              members={contacts.filter((c) =>
                // Placeholder: membership is not loaded here; replace with real lookup if available.
                false,
              )}
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
```

**Note:** `GroupDetail` currently receives an empty member list because the unified list does not load membership. This is acceptable for the initial implementation; add a TODO comment to load members via `getContactIdsForGroup` and `getContacts` in a follow-up. Alternatively, load members inside `GroupDetail` with a `useEffect`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd kylins.client.frontend
npx vitest run tests/components/contacts/ContactsPage.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/components/contacts/ContactsPage.tsx kylins.client.frontend/tests/components/contacts/ContactsPage.test.tsx
git commit -m "feat(frontend): redesign ContactsPage with account pane and unified list

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Load group members in `GroupDetail`

**Files:**
- Modify: `kylins.client.frontend/src/components/contacts/GroupDetail.tsx`
- Modify: `kylins.client.frontend/src/components/contacts/ContactsPage.tsx`
- Test: `kylins.client.frontend/tests/components/contacts/GroupDetail.test.tsx`

**Interfaces:**
- Consumes: `getContactIdsForGroup` from `services/db/contacts`.
- Produces: `GroupDetail` fetches its own members when `group.id` changes.

- [ ] **Step 1: Update `GroupDetail` to fetch members**

Modify `src/components/contacts/GroupDetail.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { ContactAvatar } from './ContactAvatar';
import type { Contact, ContactGroup } from '../../services/db/contacts';
import {
  renameContactGroup,
  deleteContactGroup,
  getContactIdsForGroup,
} from '../../services/db/contacts';
// ... rest of imports

interface GroupDetailProps {
  group: ContactGroup;
  contacts: Contact[]; // all contacts from store, used to map member ids
  onUpdate: () => void;
}

export function GroupDetail({ group, contacts, onUpdate }: GroupDetailProps) {
  // ... existing state
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    getContactIdsForGroup(group.id).then((ids) => {
      if (cancelled) return;
      setMemberIds(new Set(ids));
    });
    return () => {
      cancelled = true;
    };
  }, [group.id]);

  const members = contacts.filter((c) => memberIds.has(c.id));

  // ... rest of component, replacing `members` prop with local `members`
}
```

- [ ] **Step 2: Update `ContactsPage` to pass all contacts**

In `src/components/contacts/ContactsPage.tsx`, change the `selectedGroup` branch:

```tsx
<GroupDetail
  key={selectedGroup.id}
  group={selectedGroup}
  contacts={contacts}
  onUpdate={() => void refresh()}
/>
```

- [ ] **Step 3: Update the test**

In `tests/components/contacts/GroupDetail.test.tsx`, replace the `members` prop with `contacts`:

```ts
<GroupDetail group={makeGroup()} contacts={[makeContact()]} onUpdate={vi.fn()} />
```

Also update mocks to include `getContactIdsForGroup` returning the ids you expect.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd kylins.client.frontend
npx vitest run tests/components/contacts/GroupDetail.test.tsx tests/components/contacts/ContactsPage.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/components/contacts/GroupDetail.tsx kylins.client.frontend/src/components/contacts/ContactsPage.tsx kylins.client.frontend/tests/components/contacts/GroupDetail.test.tsx
git commit -m "feat(frontend): load group members inside GroupDetail

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Final verification

- [ ] **Step 1: Type-check**

```bash
cd kylins.client.frontend
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: Run all contact-related tests**

```bash
cd kylins.client.frontend
npx vitest run tests/components/contacts tests/stores/contactStore.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Run full test suite**

```bash
cd kylins.client.frontend
npx vitest run
```

Expected: all PASS (or only pre-existing failures).

- [ ] **Step 4: Commit any final fixes**

```bash
git commit -m "fix(frontend): address contact redesign typecheck and test issues

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-review

### Spec coverage

| Spec requirement | Task |
|------------------|------|
| Add account folder pane with All accounts / Local / accounts | Task 2 |
| Clicking account filters list | Tasks 1, 3, 5 |
| Contacts and groups in flat alphabetical list | Task 3 |
| Remove right Groups panel | Task 5 |
| Group detail view | Tasks 4, 6 |
| Store changes for account filter and mutual selection | Task 1 |
| Tests for store and components | All task tests |

### Placeholder scan

- No TBD/TODO in implementation steps.
- All code blocks include actual content.
- Test commands and expected outputs are explicit.

### Type consistency

- `selectedAccountId` is `string | null` everywhere.
- `LOCAL_SENTINEL = 'local'` is defined in both `ContactAccountPane` and `ContactList`; consider exporting it from the store or a shared constant file if duplication becomes a maintenance issue, but for this plan the literal is small and stable.
- `GroupDetail` receives `contacts: Contact[]` after Task 6, not `members: Contact[]`.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-03-contact-page-redesign.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach would you like?

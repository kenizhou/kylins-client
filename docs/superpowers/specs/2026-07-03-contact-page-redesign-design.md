# Contact page redesign with account folder pane

**Date:** 2026-07-03  
**Status:** Approved — ready for implementation planning

## Context

The current `ContactsPage` uses a three-column layout: contact list, contact detail, and a right-hand Groups panel. Contacts already store an `accountId`, but the UI never surfaces which account a contact belongs to. The user wants a folder pane so account ownership is clear, and wants groups treated as a first-class kind of contact rather than managed in a separate panel.

## Goals

1. Add a left-hand **account folder pane** that shows:
   - **All accounts** (default)
   - **Local** (contacts/groups with no account)
   - One entry per configured email account
2. Clicking an account filters the contact list to items belonging to that account.
3. Show **contacts and contact groups together** in a single flat, alphabetical list.
4. Remove the separate right-hand **Groups** panel.
5. Selecting a group opens a group detail view (name, members, management).
6. Keep the design consistent with the existing mail-folder-pane pattern, theme tokens, and Tailwind v4 styling.

## Non-goals

- CardDAV/Google People/EAS contact sync is out of scope; we only consume existing local DB data.
- No new Rust DB schema changes. Existing `contacts`, `contact_groups`, and `contact_group_members` tables are sufficient.
- No drag-and-drop reordering of accounts or groups.

## Design

### Layout

```
+-------------------------------------------------------------+
|  Contacts                                    [Add] [Import]  |
+----------------+----------------+---------------------------+
|                |                |                           |
|  Account       |  Unified list  |   Detail pane             |
|  folder pane   |  (contacts +   |   (ContactDetail or       |
|                |   groups)      |    GroupDetail)           |
|                |                |                           |
+----------------+----------------+---------------------------+
```

- **Account folder pane** width: `w-56` (`14rem`).
- **Unified list** width: `w-80` (`20rem`).
- **Detail pane** flexes to fill remaining space.
- On smaller viewports the panes can stack or hide behind a toggle, but the primary target is the existing desktop Outlook-style shell.

### Folder pane entries

| Entry           | `selectedAccountId` value | Filter applied to list                       |
|-----------------|---------------------------|----------------------------------------------|
| All accounts    | `null`                    | Show all contacts and groups                 |
| Local           | `'local'`                 | Show items where `accountId == null`         |
| `{account}`     | `account.id`              | Show items where `accountId == account.id`   |

The pane reads accounts from `useAccountStore` and renders the account label or email. It can also show a count badge per account if desired.

### Unified list

`ContactList` merges `contacts` and `groups` into a single array of list items:

```ts
type ListItem =
  | { kind: 'contact'; id: string; sortKey: string; data: Contact }
  | { kind: 'group'; id: string; sortKey: string; data: ContactGroup };
```

- `sortKey` is `displayName ?? email` for contacts and `name` for groups.
- Items are filtered by `selectedAccountId` and search query, then sorted alphabetically.
- Each row renders:
  - **Contacts:** `ContactAvatar`, display name, email (if different from name), optional frequency.
  - **Groups:** a group avatar/icon, group name, and a subtle “group” indicator.
- Selecting a contact sets `selectedContactId` and clears `selectedGroupId`.
- Selecting a group sets `selectedGroupId` and clears `selectedContactId`.

### Detail pane

`ContactsPage` decides which detail to render:

```tsx
if (selectedContactId) return <ContactDetail contact={...} />;
if (selectedGroupId) return <GroupDetail group={...} />;
return <EmptyState />;
```

- `ContactDetail` remains largely unchanged; add an account badge if the contact belongs to an account.
- `GroupDetail` is new. It shows:
  - Group name (editable inline)
  - Member list with avatars
  - Actions: rename, delete, add member
  - Empty state when the group has no members

### Store changes (`contactStore`)

Add one new field and repurpose an existing one:

```ts
interface ContactState {
  // existing
  contacts: Contact[];
  groups: ContactGroup[];
  selectedContactId: string | null;
  selectedGroupId: string | null;   // repurposed from filter to selected group item
  searchQuery: string;
  isLoading: boolean;

  // new
  selectedAccountId: string | null; // null = All accounts, 'local' = Local, else account id

  setSelectedAccountId: (id: string | null) => void;
  // existing setters updated for mutual exclusion
}
```

- `setSelectedContactId(id)` sets `selectedContactId` and clears `selectedGroupId`.
- `setSelectedGroupId(id)` sets `selectedGroupId` and clears `selectedContactId`.
- `setSelectedAccountId(id)` simply updates the filter; selection falls through to the first visible item or clears if the current selection is filtered out.

### Data flow

1. `App.tsx` already hydrates accounts into `accountStore` on startup.
2. `ContactsPage` mounts and calls `getContacts()` and `getContactGroups()`, populating `contactStore`.
3. `ContactAccountPane` reads accounts from `accountStore` and the selected account from `contactStore`.
4. `ContactList` reads contacts/groups, `selectedAccountId`, `searchQuery`, and selection state from `contactStore`, computes the filtered unified list, and renders it.
5. `ContactsPage` reads `selectedContactId` / `selectedGroupId` and renders the matching detail.

### Error handling & edge cases

- **No accounts configured:** Pane still shows “All accounts” and “Local.”
- **Deleted account selected:** Fallback to “All accounts.”
- **No matching items:** Empty state with a “Clear filters” action.
- **Empty group:** `GroupDetail` shows “No members yet” and an add-member affordance.
- **Selection filtered out:** When `selectedAccountId` changes, if the selected item no longer matches, select the first visible item or clear.
- **Local sentinel collision:** Account IDs are not allowed to be `'local'`. The UI treats `'local'` as the dedicated Local entry.

## Testing

- `tests/stores/contactStore.test.ts`
  - `selectedAccountId` default and setter
  - selecting a contact clears `selectedGroupId`
  - selecting a group clears `selectedContactId`
  - removing the selected group clears `selectedGroupId`
- `tests/components/contacts/ContactsPage.test.tsx` (create or update)
  - account pane renders All accounts, Local, and configured accounts
  - selecting an account filters the unified list
  - groups render alongside contacts
  - selecting a group renders `GroupDetail`
- `tests/components/contacts/GroupDetail.test.tsx` (new)
  - renders group name and members
  - rename/delete actions call services and invoke `onUpdate`
- Keep existing `ContactDetail` tests passing.

## Risks

- `selectedGroupId` was previously used as a filter. Any code outside `ContactList` that still treats it as a filter group will need updating. A global grep shows it is only used in `ContactList` and the store, so the blast radius is small.
- Merging contacts and groups into one list changes the keyboard navigation and screen-reader flow; we must keep `role="list"` / `role="listitem"` semantics and clear focus management when selection changes.

## Open questions

None — all questions resolved during brainstorming:
- Folder pane filters by account (not just scroll/highlight).
- Default view is all contacts visible.
- Groups are mixed alphabetically with contacts in a flat list.
- No account-level “Groups” entry; only the unified list.

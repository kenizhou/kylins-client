# FolderPane Enhancement Plan

## Context

Kylins Client currently renders `FolderPane` as hardcoded placeholder JSX. The goal is to make it load real folder/label data from the SQLite database for **all configured accounts**, with proper selection, counts, and sync integration.

This plan is based on analysis of two reference implementations:

- **Velo** (`D:/Projects/mailclient/opensource/velo`) — unifies IMAP folders and Gmail labels into a single `labels` table, maps folders to canonical roles via `folderMapper.ts`, and drives the sidebar from a Zustand `labelStore`.
- **Mailspring** (`D:/Projects/mailclient/opensource/Mailspring`) — uses an abstract `Category` model and a C++ `mailsync` worker. The design is powerful but too heavy to port directly into Kylins's Tauri v2 + React architecture.

Kylins's existing schema is already closer to Velo's approach, so this plan follows Velo's labels-as-folders model.

---

## Current State in Kylins

### Schema (already exists)

- `labels` table with `account_id`, `name`, `type`, `sort_order`, `visible`, `imap_folder_path`, `imap_special_use`.
- `thread_labels` junction table linking threads to labels.
- `folder_sync_state` for per-folder IMAP UID tracking.
- `messages.imap_folder` column for raw IMAP path.

### UI / State (missing or stubbed)

- `src/components/layout/FolderPane.tsx` is fully hardcoded; no `onClick`, no DB binding.
- No service for label CRUD.
- No store for selected folder/label.
- `MessageList.tsx` renders `DEMO_MESSAGES` and ignores folder context.
- IMAP/EAS folder discovery commands exist in the backend but results are not persisted to `labels`.

---

## Phase 1 — Label Service, Folder Store, and Data-Driven FolderPane

### 1.1 Create `src/services/db/labels.ts`

Add a thin service wrapper over `@tauri-apps/plugin-sql`:

- `getLabelsByAccount(accountId)` — all labels for one account, ordered by `type, sort_order, name`.
- `getAllLabels()` — all labels across accounts.
- `getLabelByRole(accountId, role)` — find a special folder by `imap_special_use` or by well-known name fallback.
- `upsertLabel(label)` — `INSERT ... ON CONFLICT(account_id, id) DO UPDATE`.
- `deleteLabel(accountId, labelId)`.
- `updateLabelSortOrder(accountId, orders)` — batch reorder.

Types:

```ts
export interface Label {
  id: string;
  accountId: string;
  name: string;
  type: 'system' | 'user';
  visible: boolean;
  sortOrder: number;
  imapFolderPath?: string | null;
  imapSpecialUse?: string | null;
}
```

### 1.2 Create `src/stores/folderStore.ts`

Zustand store:

```ts
interface FolderState {
  labels: Label[];
  selectedLabelId: string | null;
  isLoading: boolean;
  unreadCounts: Record<string, number>;

  loadLabels: () => Promise<void>;
  selectLabel: (id: string | null) => void;
  upsertLabelInPlace: (label: Label) => void;
  removeLabel: (accountId: string, labelId: string) => void;
  setUnreadCounts: (counts: Record<string, number>) => void;
}
```

`loadLabels()` should iterate `useAccountStore.getState().accounts`, call `getLabelsByAccount` for each, and merge the results.

### 1.3 Rewrite `src/components/layout/FolderPane.tsx`

- Read `accounts` from `accountStore`.
- Read `labels`, `selectedLabelId`, `selectLabel` from `folderStore`.
- Render a fixed **Favorites** group at the top with Inbox, Sent, Drafts, Spam, Trash mapped by role.
- Render one `FolderGroup` per account containing that account's labels.
- Make `FolderRow` clickable; set the selected label on click.
- Show unread badges from `folderStore.unreadCounts` (initially zero until Phase 2).

### 1.4 Add special-folder icon mapping

Create `src/utils/folderIcons.ts` that maps canonical roles to existing icons:

| Role | Icon |
|------|------|
| inbox | `MailIcon` |
| sent | `SendIcon` |
| drafts | `FileTextIcon` |
| spam/junk | `BellIcon` |
| trash | `TrashIcon` |
| archive | `ArchiveIcon` (add if missing) |
| user folder | `FolderIcon` (add if missing) |

---

## Phase 2 — Counts and MessageList Filtering

### 2.1 Count queries in `src/services/db/labels.ts`

```ts
getUnreadCountByLabel(accountId: string, labelId: string): Promise<number>
getTotalCountByLabel(accountId: string, labelId: string): Promise<number>
```

Implemented via:

```sql
SELECT COUNT(*) as cnt
FROM thread_labels tl
JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
WHERE tl.account_id = ? AND tl.label_id = ? AND t.is_read = 0
```

### 2.2 Load counts in `folderStore.loadLabels()`

After labels are loaded, run count queries in parallel and populate `unreadCounts`.

### 2.3 Wire folder selection to `MessageList`

- Add `selectedLabelId` to `viewStore` or keep it in `folderStore`.
- Replace `DEMO_MESSAGES` in `MessageList.tsx` with a real query that loads threads joined through `thread_labels` filtered by the selected label.
- When no label is selected, default to the Inbox label of the active account.

---

## Phase 3 — Sync Integration

### 3.1 Persist IMAP folders as labels

After `ImapProvider.listFolders()` succeeds:

1. Map each `ImapFolder` to a canonical role using `special_use` first, then well-known name fallback.
2. Build `Label` rows with deterministic IDs such as `{accountId}:{role}` or `folder-{path}`.
3. Call `upsertLabel()` for each folder.
4. Trigger `folderStore.loadLabels()`.

Port the role-mapping logic from Velo's `src/services/imap/folderMapper.ts`.

### 3.2 Persist EAS folders as labels

After `EasProvider.folderSync()` succeeds:

1. Map each returned EAS folder to a `Label` row.
2. Use EAS folder type/class to determine `type` (`system` vs `user`) and role.
3. Upsert and refresh the folder store.

### 3.3 Refresh trigger

Add an event or direct store call so the folder list refreshes automatically after account sync completes, without requiring a manual reload.

---

## Files to Create / Modify

### New files

- `src/services/db/labels.ts`
- `src/stores/folderStore.ts`
- `src/utils/folderIcons.ts`

### Modified files

- `src/components/layout/FolderPane.tsx` — replace hardcoded content with DB-driven rendering.
- `src/features/view/viewStore.ts` — add `selectedLabelId` if not kept in `folderStore`.
- `src/components/layout/MessageList.tsx` — filter by selected label.
- `src/services/mail/imapProvider.ts` — persist folders after listing.
- `src/services/mail/easProvider.ts` — persist folders after folder sync.

### Tests to add

- `tests/services/db/labels.test.ts` — CRUD, role lookup, count queries.
- `tests/stores/folderStore.test.ts` — selection, loading, counts.
- `tests/components/layout/FolderPane.test.tsx` — rendering per account, selection.

---

## Verification

Run after each phase:

```bash
cd kylins.client.frontend
npx tsc --noEmit
npx vitest run
npm run build

cd ../kylins.client.backend
cargo test --lib
cargo build
```

This phased approach keeps the codebase buildable and testable at every step.

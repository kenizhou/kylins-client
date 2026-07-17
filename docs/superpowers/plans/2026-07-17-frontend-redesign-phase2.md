# Frontend Redesign Phase 2 — Message List, Reading Pane & Ribbon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the core mail triage and reading experience by making the message-list columns real, adding hover quick actions, introducing a Focused Inbox view, polishing the reading-pane header, consuming reader zoom, and making the command ribbon responsive.

**Architecture:** Keep the existing store layer (`threadStore`, `viewStore`, `folderStore`) and virtualized list. The changes are localized to React components, CSS tokens, and a small `useElementWidth` hook. No backend RPC changes are required.

**Tech Stack:** Tauri v2, React 19, TypeScript 5.9, Tailwind CSS v4, `react-aria-components`, `react-resizable-panels`, Hugeicons, Vitest 4 + jsdom.

## Global Constraints

- Run all frontend commands from `kylins.client.frontend/`.
- TypeScript `strict` + `noUnusedLocals` + `noUncheckedIndexedAccess` must pass: `npx tsc --noEmit`.
- Vitest must pass: `npx vitest run`.
- ESLint must pass: `npm run lint`.
- Prettier must pass: `npm run format:check`.
- No new `any` or `@ts-ignore`.
- Do not edit applied backend migrations.
- Secrets must still route through Rust crypto; no plaintext secrets in frontend state.
- All interactive elements need accessible labels and visible focus rings.
- Prefer Hugeicons from `src/components/icons.tsx`; do not introduce new icon libraries.

---

## File Structure

| File | Responsibility |
|---|---|
| `kylins.client.frontend/src/features/view/defaults.ts` | Default `visibleColumnIds` and column registry; add `threadRibbon`, `snippet`, `attachments`. |
| `kylins.client.frontend/src/features/view/types.ts` | `ColumnDef.renderer` union update. |
| `kylins.client.frontend/src/components/layout/MessageList.tsx` | Virtualized list, column-aware `MessageRow`, hover quick actions, Focused Inbox tabs. |
| `kylins.client.frontend/src/features/viewer/MessageHeader.tsx` | Reading-pane header: security badges, recipient hierarchy, relative time. |
| `kylins.client.frontend/src/components/layout/ReadingPane.tsx` | Zoom wrapper for `EmailRenderer`; already scaled, will add width compensation. |
| `kylins.client.frontend/src/components/email/EmailRenderer.tsx` | Already consumes `readerZoom` for font size; keep and verify. |
| `kylins.client.frontend/src/hooks/useElementWidth.ts` | ResizeObserver-based element width hook for ribbon responsive logic. |
| `kylins.client.frontend/src/components/layout/ribbon/RibbonShell.tsx` | Forward ref so `ReadRibbon` can measure width. |
| `kylins.client.frontend/src/components/layout/ribbon/RibbonPrimitives.tsx` | Add `iconOnly` support to `RibbonButton` / `SplitRibbonButton`. |
| `kylins.client.frontend/src/components/layout/ribbon/ReadRibbon.tsx` | Responsive layout, overflow menu, archive handler, remove stub Categorize/Pin. |
| `kylins.client.frontend/src/services/mail/actions.ts` | Provider-agnostic archive/trash/junk helpers (already exist). |

---

## Task 1: Make MessageList Columns Respect `visibleColumnIds`

**Files:**
- Modify: `kylins.client.frontend/src/features/view/defaults.ts`
- Modify: `kylins.client.frontend/src/features/view/types.ts`
- Modify: `kylins.client.frontend/src/components/layout/MessageList.tsx`
- Test: `tests/components/layout/MessageList.test.tsx` (update)

**Interfaces:**
- Consumes: `visibleColumnIds` from `viewStore`; `COLUMN_REGISTRY` from `defaults.ts`; `Thread` from `services/db/threads`.
- Produces: A `MessageRow` whose cells correspond to visible columns and align with the list header.

### Step 1: Add missing column definitions

```ts
// kylins.client.frontend/src/features/view/defaults.ts
import type { ColumnDef, PanelSizeMap, ViewState } from './types';

export const DEFAULT_MESSAGE_LIST_COLUMNS: ColumnDef[] = [
  {
    id: 'threadRibbon',
    label: '',
    defaultVisible: true,
    sortable: false,
    resizable: false,
    renderer: 'threadRibbon',
  },
  {
    id: 'importance',
    label: 'Imp.',
    defaultVisible: false,
    sortable: false,
    resizable: false,
    renderer: 'importance',
  },
  {
    id: 'flag',
    label: 'Flag',
    defaultVisible: true,
    sortable: true,
    resizable: false,
    renderer: 'flag',
  },
  {
    id: 'from',
    label: 'From',
    defaultVisible: true,
    width: 180,
    sortable: true,
    resizable: true,
    renderer: 'from',
  },
  {
    id: 'subject',
    label: 'Subject',
    defaultVisible: true,
    width: 320,
    sortable: true,
    resizable: true,
    renderer: 'subject',
  },
  {
    id: 'snippet',
    label: 'Snippet',
    defaultVisible: false,
    width: 200,
    sortable: false,
    resizable: true,
    renderer: 'snippet',
  },
  {
    id: 'category',
    label: 'Category',
    defaultVisible: false,
    width: 120,
    sortable: false,
    resizable: true,
    renderer: 'category',
  },
  {
    id: 'received',
    label: 'Received',
    defaultVisible: true,
    width: 140,
    sortable: true,
    resizable: true,
    renderer: 'received',
  },
  {
    id: 'size',
    label: 'Size',
    defaultVisible: false,
    width: 80,
    sortable: true,
    resizable: true,
    renderer: 'size',
  },
  {
    id: 'attachments',
    label: '',
    defaultVisible: false,
    sortable: false,
    resizable: false,
    renderer: 'attachments',
  },
];

export const DEFAULT_PANEL_SIZES: PanelSizeMap = {
  right: { folder: 18, list: 38, reader: 44 },
  bottom: { folder: 20, list: 48, reader: 32 },
  off: { folder: 22, list: 78 },
};

export const DEFAULT_VIEW_STATE: ViewState = {
  readingPanePosition: 'right',
  folderPaneVisible: true,
  commandRibbonVisible: true,
  statusBarVisible: true,
  conversationView: false,
  messageListDensity: 'normal',
  visibleColumnIds: DEFAULT_MESSAGE_LIST_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id),
  panelSizes: DEFAULT_PANEL_SIZES,
  calendarPaneVisible: true,
  calendarPaneSize: 22,
};

export const COLUMN_REGISTRY = new Map(DEFAULT_MESSAGE_LIST_COLUMNS.map((c) => [c.id, c]));
```

### Step 2: Update the renderer union

```ts
// kylins.client.frontend/src/features/view/types.ts
export type ColumnRenderer =
  | 'threadRibbon'
  | 'from'
  | 'subject'
  | 'snippet'
  | 'received'
  | 'size'
  | 'flag'
  | 'category'
  | 'read'
  | 'importance'
  | 'attachments';

export interface ColumnDef {
  id: string;
  label: string;
  defaultVisible: boolean;
  width?: number;
  sortable: boolean;
  resizable: boolean;
  renderer: ColumnRenderer;
}
```

### Step 3: Rewrite `MessageRow` to render per-column cells

Replace the fixed layout inside `MessageList.tsx` with a cell renderer. Keep the existing imports; add `AttachmentIcon` and `UnfoldIcon`? Use `AttachmentIcon` from `../icons`.

Key structure:

```tsx
// inside MessageList.tsx
function cellWidth(col: ColumnDef): React.CSSProperties {
  if (col.width) return { width: col.width, minWidth: col.width };
  return { width: 'auto', minWidth: 24 };
}

function MessageRowCell({
  col,
  thread,
  density,
}: {
  col: ColumnDef;
  thread: Thread;
  density: MessageListDensity;
}) {
  const { getLevelById } = useClassification();
  const level = getLevelById(thread.classificationId);
  const prominent = level ? isProminent(level) : false;
  const unread = !thread.isRead;

  switch (col.renderer) {
    case 'threadRibbon':
      return (
        <span className="flex h-full items-stretch" style={cellWidth(col)}>
          <span
            className={`w-[3px] rounded-r-[var(--radius-xs)] ${prominent ? '' : RIBBON_COLOR[thread.isRead ? 'read' : unread ? 'unread' : thread.isStarred ? 'flagged' : thread.isImportant ? 'vip' : 'read']}`}
            style={prominent && level ? { backgroundColor: level.color } : undefined}
          />
        </span>
      );
    case 'importance':
      return (
        <span className="flex items-center justify-center" style={cellWidth(col)}>
          {thread.isImportant && <span title="Important" aria-label="Important" className="text-[var(--warning)]">!</span>}
        </span>
      );
    case 'category':
      return (
        <span className="flex items-center" style={cellWidth(col)}>
          {level && <ClassificationBadge level={level} size={density === 'compact' ? 'xs' : 'sm'} />}
        </span>
      );
    case 'from': {
      const sender = thread.fromName ?? thread.fromAddress ?? 'Unknown';
      return (
        <span className="flex items-center gap-2 min-w-0" style={cellWidth(col)}>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--border)] text-[10px] font-bold text-[var(--muted-text)]">
            {getInitials(sender)}
          </span>
          <span className={`truncate ${unread ? 'font-semibold' : ''}`}>{sender}</span>
        </span>
      );
    }
    case 'subject':
      return (
        <span className="flex min-w-0 flex-col justify-center" style={cellWidth(col)}>
          <span className={`truncate ${unread ? 'font-semibold' : ''}`}>{thread.subject ?? '(no subject)'}</span>
          {density === 'comfortable' && thread.snippet && (
            <span className="truncate text-[12px] text-[var(--muted-text)]">{thread.snippet}</span>
          )}
        </span>
      );
    case 'snippet':
      return (
        <span className="flex items-center truncate text-[12px] text-[var(--muted-text)]" style={cellWidth(col)}>
          {thread.snippet}
        </span>
      );
    case 'received':
      return (
        <span className="flex items-center justify-end text-[11px] font-mono text-[var(--muted-text)]" style={cellWidth(col)}>
          {thread.lastMessageAt != null ? formatMessageTime(new Date(thread.lastMessageAt * 1000).toISOString()) : ''}
        </span>
      );
    case 'size':
      return <span className="flex items-center justify-end text-[11px] text-[var(--muted-text)]" style={cellWidth(col)} />;
    case 'attachments':
      return (
        <span className="flex items-center justify-center" style={cellWidth(col)}>
          {thread.hasAttachments && (
            <span title="Has attachments" aria-label="Has attachments" className="text-[var(--muted-text)]">
              <AttachmentIcon size={14} />
            </span>
          )}
        </span>
      );
    case 'flag':
      return (
        <span className="flex items-center justify-center" style={cellWidth(col)}>
          {thread.isStarred && (
            <span title="Flagged" aria-label="Flagged" className="text-[var(--amber)]">
              <FlagIcon size={14} />
            </span>
          )}
        </span>
      );
    case 'read':
      return (
        <span className="flex items-center justify-center" style={cellWidth(col)}>
          {!thread.isRead && <span className="h-2 w-2 rounded-full bg-[var(--primary)]" aria-label="Unread" />}
        </span>
      );
    default:
      return null;
  }
}
```

Update `MessageRow` to render cells:

```tsx
const MessageRow = memo(function MessageRow({ thread, selected, density, ...handlers }: MessageRowProps) {
  const visibleColumnIds = useViewStore((s) => s.visibleColumnIds);
  const visibleColumns = visibleColumnIds
    .map((id) => COLUMN_REGISTRY.get(id))
    .filter((c): c is ColumnDef => c != null);

  return (
    <div
      role="listitem"
      aria-selected={selected}
      tabIndex={0}
      {...handlers}
      className={`group flex cursor-pointer items-stretch gap-1 px-1 ${DENSITY_ROW_CLASSES[density]} ${selected ? 'bg-[var(--selected)]' : 'hover:bg-[var(--hover)]'}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handlers.onClick?.();
        }
      }}
    >
      {visibleColumns.map((col) => (
        <div
          key={col.id}
          className={`message-list-col-${col.id} flex min-w-0 items-center`}
          style={cellWidth(col)}
        >
          <MessageRowCell col={col} thread={thread} density={density} />
        </div>
      ))}
    </div>
  );
});
```

Update the header in `MessageList` to use the same widths and remove the extra gap. Also add `aria-rowcount`/`aria-rowindex` and `aria-selected`.

### Step 4: Update tests

Keep existing tests passing; add one that proves a hidden column is absent:

```ts
it('renders only visible columns', async () => {
  vi.mocked(getThreads).mockResolvedValue({
    threads: [thread({ id: 't1', subject: 'Hello', fromName: 'Bob', isStarred: true })],
    nextCursor: null,
  });
  useViewStore.setState({ visibleColumnIds: ['from', 'received'] });
  useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
  const { getByText, queryByLabelText } = render(<MessageList />);
  await waitFor(() => expect(getByText('Hello')).toBeInTheDocument());
  expect(getByText('Bob')).toBeInTheDocument();
  expect(queryByLabelText('Flagged')).not.toBeInTheDocument();
});
```

### Step 5: Run checks

```bash
npx vitest run tests/components/layout/MessageList.test.tsx
npm run lint
npx tsc --noEmit
```

### Step 6: Commit

```bash
git add kylins.client.frontend/src/features/view/defaults.ts kylins.client.frontend/src/features/view/types.ts kylins.client.frontend/src/components/layout/MessageList.tsx tests/components/layout/MessageList.test.tsx
git commit -m "feat(message-list): render rows by visibleColumnIds"
```

---

## Task 2: Hover Quick Actions on Message Rows

**Files:**
- Modify: `kylins.client.frontend/src/components/layout/MessageList.tsx`
- Test: `tests/components/layout/MessageList.test.tsx` (update)

**Interfaces:**
- Consumes: `archiveThread`, `trashThread` from `services/mail/actions`; `markThreadRead`, `toggleThreadStarred` from `threadStore`.
- Produces: `MessageRowQuickActions` overlay shown on hover/focus.

### Step 1: Create the quick-actions overlay inside MessageList.tsx

```tsx
import { ArchiveIcon, DeleteIcon, FlagIcon, MailIcon } from '../icons';
import { archiveThread, trashThread } from '../../services/mail/actions';

interface QuickActionsProps {
  thread: Thread;
}

function MessageRowQuickActions({ thread }: QuickActionsProps) {
  const markThreadRead = useThreadStore((s) => s.markThreadRead);
  const toggleThreadStarred = useThreadStore((s) => s.toggleThreadStarred);

  return (
    <span
      className="absolute right-2 top-1/2 z-10 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--background)] p-0.5 shadow-sm group-hover:flex group-focus-within:flex"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Archive"
        title="Archive"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        onClick={() => void archiveThread(thread)}
      >
        <ArchiveIcon size={14} />
      </button>
      <button
        type="button"
        aria-label="Delete"
        title="Delete"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--destructive)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        onClick={() => void trashThread(thread)}
      >
        <DeleteIcon size={14} />
      </button>
      <button
        type="button"
        aria-label={thread.isStarred ? 'Unflag' : 'Flag'}
        title={thread.isStarred ? 'Unflag' : 'Flag'}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--amber)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        onClick={() => void toggleThreadStarred(thread)}
      >
        <FlagIcon size={14} className={thread.isStarred ? 'text-[var(--amber)]' : ''} />
      </button>
      <button
        type="button"
        aria-label={thread.isRead ? 'Mark unread' : 'Mark read'}
        title={thread.isRead ? 'Mark unread' : 'Mark read'}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        onClick={() => void markThreadRead(thread, !thread.isRead)}
      >
        <MailIcon size={14} />
      </button>
    </span>
  );
}
```

### Step 2: Make the row relative and render the overlay

Wrap the existing row content in a relative container:

```tsx
<div
  role="listitem"
  aria-selected={selected}
  tabIndex={0}
  {...handlers}
  className={`group relative cursor-pointer ${DENSITY_ROW_CLASSES[density]} ${selected ? 'bg-[var(--selected)]' : 'hover:bg-[var(--hover)]'}`}
  onKeyDown={...}
>
  <div className="flex items-stretch gap-1 px-1">
    {visibleColumns.map(...)}
  </div>
  <MessageRowQuickActions thread={thread} />
</div>
```

### Step 3: Update tests

Add a test that hovers a row and clicks archive:

```ts
it('shows hover quick actions and archives on click', async () => {
  vi.mocked(getThreads).mockResolvedValue({
    threads: [thread({ id: 't1', subject: 'Hello', isRead: true })],
    nextCursor: null,
  });
  useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
  const archiveThread = vi.spyOn(await import('../../../src/services/mail/actions'), 'archiveThread');
  render(<MessageList />);
  await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

  const row = screen.getByRole('listitem');
  fireEvent.mouseEnter(row);
  const archiveBtn = await screen.findByRole('button', { name: 'Archive' });
  fireEvent.click(archiveBtn);
  expect(archiveThread).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  archiveThread.mockRestore();
});
```

### Step 4: Run checks and commit

```bash
npx vitest run tests/components/layout/MessageList.test.tsx
npm run lint && npx tsc --noEmit
```

```bash
git add kylins.client.frontend/src/components/layout/MessageList.tsx tests/components/layout/MessageList.test.tsx
git commit -m "feat(message-list): hover quick actions (archive, delete, flag, mark read)"
```

---

## Task 3: Focused Inbox Tabs

**Files:**
- Modify: `kylins.client.frontend/src/components/layout/MessageList.tsx`
- Test: `tests/components/layout/MessageList.test.tsx` (update)

**Interfaces:**
- Consumes: selected folder role from `folderStore`; `Thread.isImportant`, `isStarred`, `isRead`.
- Produces: `Focused`/`Other` tabs visible only on the Inbox.

### Step 1: Detect Inbox and add tab UI

Inside `MessageList`:

```tsx
const selectedFolder = useFolderStore((s) => s.selected);
const folders = useFolderStore((s) => (selectedFolder ? s.byAccount[selectedFolder.accountId] ?? [] : []));
const selectedRole = useMemo(() => folders.find((f) => f.id === selectedFolder?.labelId)?.role ?? null, [folders, selectedFolder]);
const isInbox = selectedRole === 'inbox';
const [focusedTab, setFocusedTab] = useState<'focused' | 'other'>('focused');

const filteredItems = useMemo(() => {
  if (!isInbox) return items;
  return items.filter((item) => {
    if (item.kind === 'group') return true;
    const t = item.thread;
    const focused = !t.isRead || t.isStarred || t.isImportant;
    return focusedTab === 'focused' ? focused : !focused;
  });
}, [items, isInbox, focusedTab]);
```

Add tab bar above the list:

```tsx
{isInbox && (
  <div className="flex items-center gap-1 border-b border-[var(--border)] px-3 py-1.5">
    <button
      type="button"
      role="tab"
      aria-selected={focusedTab === 'focused'}
      onClick={() => setFocusedTab('focused')}
      className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${focusedTab === 'focused' ? 'bg-[var(--selected)] text-[var(--foreground)]' : 'text-[var(--muted-text)] hover:bg-[var(--hover)]'}`}
    >
      Focused
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={focusedTab === 'other'}
      onClick={() => setFocusedTab('other')}
      className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${focusedTab === 'other' ? 'bg-[var(--selected)] text-[var(--foreground)]' : 'text-[var(--muted-text)] hover:bg-[var(--hover)]'}`}
    >
      Other
    </button>
  </div>
)}
```

Use `filteredItems` in the virtualizer and keyboard navigation. Keep `items` for `nearEnd` infinite scroll to avoid losing cursor.

### Step 2: Update empty state copy

If `filteredItems.length === 0` and `isInbox`, show "No focused messages." vs "No other messages."

### Step 3: Add tests

```ts
it('shows Focused/Other tabs in the inbox and filters threads', async () => {
  vi.mocked(getThreads).mockResolvedValue({
    threads: [
      thread({ id: 't1', subject: 'Focused unread', isRead: false }),
      thread({ id: 't2', subject: 'Other read', isRead: true }),
    ],
    nextCursor: null,
  });
  useFolderStore.setState({
    selected: { accountId: 'a1', labelId: 'inbox' },
    byAccount: {
      a1: [{ id: 'inbox', accountId: 'a1', role: 'inbox' } as MailFolder],
    },
  });
  render(<MessageList />);
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Focused' })).toBeInTheDocument());
  expect(screen.getByText('Focused unread')).toBeInTheDocument();
  expect(screen.queryByText('Other read')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: 'Other' }));
  await waitFor(() => expect(screen.queryByText('Focused unread')).not.toBeInTheDocument());
  expect(screen.getByText('Other read')).toBeInTheDocument();
});
```

### Step 4: Run checks and commit

```bash
npx vitest run tests/components/layout/MessageList.test.tsx
npm run lint && npx tsc --noEmit
```

```bash
git add kylins.client.frontend/src/components/layout/MessageList.tsx tests/components/layout/MessageList.test.tsx
git commit -m "feat(message-list): add Focused Inbox tabs"
```

---

## Task 4: ReadingPane Header Improvements

**Files:**
- Modify: `kylins.client.frontend/src/features/viewer/MessageHeader.tsx`
- Test: `tests/components/layout/ReadingPane.test.tsx` (update or create `tests/features/viewer/MessageHeader.test.tsx`)

**Interfaces:**
- Consumes: `MailMessage` with `isEncrypted`, `isSigned`, `from`, `to`, `cc`, `date`.
- Produces: Cleaner header with security badges, relative time tooltip, collapsed recipients.

### Step 1: Add security badge row and improve meta layout

```tsx
// kylins.client.frontend/src/features/viewer/MessageHeader.tsx
import { SecurityChips } from '@/features/classification/components/SecurityChips';
import { formatMessageTime } from '@/data/demoMessages';

// Replace the date display with:
<span className="group/tooltip relative text-xs text-[var(--muted-text)]">
  {formatMessageTime(message.date)}
  <span className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-[var(--foreground)] px-2 py-1 text-[10px] text-[var(--background)] opacity-0 transition-opacity group-hover/tooltip:opacity-100">
    {formatFullDate(message.date)}
  </span>
</span>
```

Add a security row between the subject and sender row:

```tsx
<div className="mb-2 flex flex-wrap items-center gap-2">
  <SecurityChips isEncrypted={message.isEncrypted} isSigned={message.isSigned} variant="label" size={12} />
  {message.isEncrypted && (
    <span className="inline-flex items-center gap-1 rounded border border-[var(--success)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--success)]">
      <ShieldCheckIcon size={10} /> Encrypted
    </span>
  )}
  {message.isSigned && (
    <span className="inline-flex items-center gap-1 rounded border border-[var(--success)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--success)]">
      <ShieldCheckIcon size={10} /> Signed
    </span>
  )}
</div>
```

Make the subject use `text-2xl` and a serif stack if the UI store prefers serif subjects (optional; keep simple):

```tsx
<h1 className="reading-pane-subject min-w-0 text-[22px] font-semibold leading-[1.25] tracking-tight text-[var(--text)]">
  {message.subject}
</h1>
```

### Step 2: Add tests

Create `tests/features/viewer/MessageHeader.test.tsx` if it does not exist:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageHeader } from '../../../src/features/viewer/MessageHeader';
import type { MailMessage } from '../../../src/features/view/viewStore';

const message: MailMessage = {
  id: 'm1',
  subject: 'Security review',
  from: { name: 'Sec Team', address: 'sec@example.com' },
  to: [{ name: 'You', address: 'you@example.com' }],
  date: new Date().toISOString(),
  preview: '',
  html: '<p>x</p>',
  text: 'x',
  classificationId: null,
  isEncrypted: true,
  isSigned: true,
};

const noop = () => {};

describe('MessageHeader', () => {
  it('renders encrypted and signed badges', () => {
    render(
      <MessageHeader
        message={message}
        onReply={noop}
        onReplyAll={noop}
        onForward={noop}
        onArchive={noop}
        onDelete={noop}
        onJunk={noop}
        onMarkUnread={noop}
        onAddContact={noop}
        contactAdded={false}
      />,
    );
    expect(screen.getByText('Encrypted')).toBeInTheDocument();
    expect(screen.getByText('Signed')).toBeInTheDocument();
  });
});
```

### Step 3: Run checks and commit

```bash
npx vitest run tests/features/viewer/MessageHeader.test.tsx tests/components/layout/ReadingPane.test.tsx
npm run lint && npx tsc --noEmit
```

```bash
git add kylins.client.frontend/src/features/viewer/MessageHeader.tsx tests/features/viewer/MessageHeader.test.tsx
git commit -m "feat(reading-pane): add security badges and relative-time tooltip to header"
```

---

## Task 5: Ensure `readerZoom` Is Applied to `EmailRenderer`

**Files:**
- Modify: `kylins.client.frontend/src/components/layout/ReadingPane.tsx`
- Test: `tests/components/layout/ReadingPane.test.tsx` (update)

**Interfaces:**
- Consumes: `readerZoom` from `uiStore`.
- Produces: Zoomed email body that does not overflow the reading-pane width.

### Step 1: Compensate width when scaling

The current code wraps `EmailRenderer` in a `div` with `transform: scale(...)`. Add `width` compensation so the scaled content fits:

```tsx
<div
  style={{
    transform: `scale(${readerZoom})`,
    transformOrigin: 'top left',
    width: `${100 / readerZoom}%`,
  }}
>
  <EmailRenderer ... />
</div>
```

### Step 2: Verify EmailRenderer still reads zoom

`EmailRenderer.tsx` already reads `readerZoom` from `useUIStore` and scales iframe font size. Confirm it is still imported and used.

### Step 3: Add a regression test

```ts
it('applies reader zoom to the email renderer wrapper', async () => {
  useUIStore.setState({ readerZoom: 1.25 });
  useViewStore.setState({ selectedMessage: message });
  const { container } = render(<ReadingPane />);
  await waitFor(() => expect(container.querySelector('[style*="scale(1.25)"]')).toBeInTheDocument());
});
```

### Step 4: Run checks and commit

```bash
npx vitest run tests/components/layout/ReadingPane.test.tsx
npm run lint && npx tsc --noEmit
```

```bash
git add kylins.client.frontend/src/components/layout/ReadingPane.tsx tests/components/layout/ReadingPane.test.tsx
git commit -m "fix(reading-pane): keep zoom-scaled email body within pane width"
```

---

## Task 6: CommandRibbon Responsive Strategy & Overflow Menu

**Files:**
- Create: `kylins.client.frontend/src/hooks/useElementWidth.ts`
- Modify: `kylins.client.frontend/src/components/layout/ribbon/RibbonShell.tsx`
- Modify: `kylins.client.frontend/src/components/layout/ribbon/RibbonPrimitives.tsx`
- Modify: `kylins.client.frontend/src/components/layout/ribbon/ReadRibbon.tsx`
- Test: `tests/components/layout/ribbon/ReadRibbon.test.tsx` (create)

**Interfaces:**
- Consumes: element width via ResizeObserver.
- Produces: `iconOnly` ribbon under 900px; overflow menu under 640px.

### Step 1: Add `useElementWidth` hook

```ts
// kylins.client.frontend/src/hooks/useElementWidth.ts
import { useEffect, useRef, useState } from 'react';

export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number>(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) setWidth(cr.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}
```

### Step 2: Forward ref through `RibbonShell`

```tsx
// kylins.client.frontend/src/components/layout/ribbon/RibbonShell.tsx
import { forwardRef, type ReactNode } from 'react';

export interface RibbonShellProps {
  children: ReactNode;
}

export const RibbonShell = forwardRef<HTMLElement, RibbonShellProps>(function RibbonShell(
  { children },
  ref,
) {
  return (
    <nav
      ref={ref}
      className="mx-1 mt-1 flex min-h-[var(--ribbon-h)] min-w-0 flex-col items-stretch justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-1 shadow-sm md:mx-2 md:mt-2 md:px-3 md:py-1.5"
      aria-label="Command ribbon"
    >
      <div className="flex min-w-0 flex-wrap items-stretch gap-y-1">{children}</div>
    </nav>
  );
});
```

### Step 3: Add `iconOnly` support to primitives

```tsx
// kylins.client.frontend/src/components/layout/ribbon/RibbonPrimitives.tsx
export interface RibbonButtonProps {
  children?: ReactNode;
  icon?: ReactNode;
  primary?: boolean;
  split?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  iconOnly?: boolean;
  onClick?: () => void;
}

export function RibbonButton({
  children,
  icon,
  primary,
  split,
  disabled,
  title,
  className,
  iconOnly,
  onClick,
}: RibbonButtonProps) {
  return (
    <Button
      isDisabled={disabled}
      onPress={onClick}
      aria-label={title ?? (typeof children === 'string' ? children : undefined)}
      className={`my-auto flex h-11 items-center gap-1.5 rounded px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 ${
        primary
          ? 'bg-primary text-primary-fg hover:opacity-90 disabled:hover:opacity-40'
          : 'text-text hover:bg-hover disabled:hover:bg-transparent'
      } ${iconOnly ? 'w-11 justify-center px-0' : ''} ${className ?? ''}`}
    >
      {icon}
      <span className={`whitespace-nowrap ${iconOnly ? 'sr-only' : ''}`}>{children}</span>
      {split && <CaretDownIcon size={10} className="ml-0.5 opacity-70" />}
    </Button>
  );
}
```

Add `iconOnly` to `SplitRibbonButtonProps` and pass it down; hide the text span when `iconOnly`.

### Step 4: Implement responsive layout in `ReadRibbon`

Use `useElementWidth` on `RibbonShell`. Define breakpoints:

```tsx
const { ref: ribbonRef, width: ribbonWidth } = useElementWidth<HTMLElement>();
const compact = ribbonWidth > 0 && ribbonWidth < 640;
const iconOnly = ribbonWidth > 0 && ribbonWidth < 900;
```

Render secondary actions into an overflow menu when compact. The overflow menu contains:

- Archive
- Delete
- Move (opens the existing Move popover)
- Mark Read/Unread
- Flag/Unflag

Use `react-aria-components` `Menu`, `MenuItem`, `Popover`, `DialogTrigger`.

Example overflow group:

```tsx
{compact && (
  <RibbonGroup>
    <DialogTrigger isOpen={overflowOpen} onOpenChange={setOverflowOpen}>
      <RibbonButton icon={<MoreIcon size={18} />} iconOnly title="More actions">
        More
      </RibbonButton>
      <Popover className="min-w-[180px] rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg">
        <Menu aria-label="More actions" className="outline-none">
          <MenuItem onAction={() => selectedThread && void archiveThread(selectedThread)} className="...">
            <ArchiveIcon size={14} /> Archive
          </MenuItem>
          <MenuItem onAction={() => selectedThread && void deleteThread(selectedThread)} className="...">
            <DeleteIcon size={14} /> Delete
          </MenuItem>
          <MenuItem onAction={() => selectedThread && setMoveOpen(true)} className="...">
            <MoveIcon size={14} /> Move
          </MenuItem>
          <MenuItem onAction={() => selectedThread && void markThreadRead(selectedThread, !selectedThread.isRead)} className="...">
            <MailIcon size={14} /> {selectedThread?.isRead ? 'Mark Unread' : 'Mark Read'}
          </MenuItem>
          <MenuItem onAction={() => selectedThread && void toggleThreadStarred(selectedThread)} className="...">
            <FlagIcon size={14} /> {selectedThread?.isStarred ? 'Unflag' : 'Flag'}
          </MenuItem>
        </Menu>
      </Popover>
    </DialogTrigger>
  </RibbonGroup>
)}
```

Only render the full Manage/Categorize/Follow Up groups when not compact.

Pass `iconOnly={iconOnly}` to all `RibbonButton` and `SplitRibbonButton` instances.

### Step 5: Add tests

Create `tests/components/layout/ribbon/ReadRibbon.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReadRibbon } from '../../../../src/components/layout/ribbon/ReadRibbon';
import { useViewStore } from '../../../../src/features/view/viewStore';
import { useThreadStore } from '../../../../src/stores/threadStore';
import { useAccountStore } from '../../../../src/stores/accountStore';
import { usePreferencesStore } from '../../../../src/stores/preferencesStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  useViewStore.setState({ selectedMessage: null, inlineReplyMode: null });
  useThreadStore.setState({ threads: [], selectedThreadId: null });
  useAccountStore.setState({ accounts: [], activeAccountId: null });
  usePreferencesStore.setState({ defaultReplyBehavior: 'reply' });
});

describe('ReadRibbon', () => {
  it('renders New and Reply groups', () => {
    render(<ReadRibbon />);
    expect(screen.getByRole('button', { name: /new email/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reply$/i })).toBeInTheDocument();
  });

  it('does not render a Pin button', () => {
    render(<ReadRibbon />);
    expect(screen.queryByRole('button', { name: /^pin$/i })).not.toBeInTheDocument();
  });
});
```

### Step 6: Run checks and commit

```bash
npx vitest run tests/components/layout/ribbon/ReadRibbon.test.tsx tests/components/layout/ribbon/RibbonPrimitives.test.tsx
npm run lint && npx tsc --noEmit
```

```bash
git add kylins.client.frontend/src/hooks/useElementWidth.ts kylins.client.frontend/src/components/layout/ribbon/RibbonShell.tsx kylins.client.frontend/src/components/layout/ribbon/RibbonPrimitives.tsx kylins.client.frontend/src/components/layout/ribbon/ReadRibbon.tsx tests/components/layout/ribbon/ReadRibbon.test.tsx
git commit -m "feat(ribbon): responsive icon-only and overflow menu"
```

---

## Task 7: Wire Archive and Remove Stub Buttons in `ReadRibbon`

**Files:**
- Modify: `kylins.client.frontend/src/components/layout/ribbon/ReadRibbon.tsx`
- Modify: `tests/components/layout/ribbon/ReadRibbon.test.tsx` (update)
- Modify: `tests/components/layout/MessageList.test.tsx` (optional: enable archive context-menu item)

**Interfaces:**
- Consumes: `archiveThread` from `services/mail/actions`; `selectedThread` from `threadStore`.
- Produces: Archive button works; Categorize and Pin stubs removed.

### Step 1: Wire Archive

Change the Archive `RibbonButton` from `disabled` to an active handler:

```tsx
<RibbonButton
  icon={<ArchiveIcon size={18} />}
  disabled={!hasThread}
  title="Archive"
  onClick={() => {
    if (!selectedThread) return;
    void archiveThread(selectedThread);
  }}
>
  Archive
</RibbonButton>
```

### Step 2: Remove stubs

Delete the entire `Categorize` group and the `Pin` button from `ReadRibbon`. If any import becomes unused, remove it.

### Step 3: Enable archive in the MessageList context menu

In `MessageList.tsx`, change the Archive context-menu item from `disabled: true` to:

```ts
{
  label: 'Archive',
  icon: ArchiveIcon,
  onSelect: () => {
    if (!menu.thread) return;
    void archiveThread(menu.thread);
  },
}
```

Update the test that asserts `Archive` is disabled.

### Step 4: Update tests

Add to `ReadRibbon.test.tsx`:

```ts
it('archives the selected thread when Archive is clicked', async () => {
  const archiveThread = vi.spyOn(await import('../../../../src/services/mail/actions'), 'archiveThread');
  useThreadStore.setState({
    threads: [{ id: 't1', accountId: 'a1', subject: 'x', isRead: true } as never],
    selectedThreadId: 't1',
  });
  useAccountStore.setState({ accounts: [{ id: 'a1', email: 'me@x.com' } as never], activeAccountId: 'a1' });
  render(<ReadRibbon />);
  fireEvent.click(screen.getByRole('button', { name: /archive/i }));
  expect(archiveThread).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  archiveThread.mockRestore();
});
```

### Step 5: Run checks and commit

```bash
npx vitest run tests/components/layout/ribbon/ReadRibbon.test.tsx tests/components/layout/MessageList.test.tsx
npm run lint && npx tsc --noEmit
```

```bash
git add kylins.client.frontend/src/components/layout/ribbon/ReadRibbon.tsx kylins.client.frontend/src/components/layout/MessageList.tsx tests/components/layout/ribbon/ReadRibbon.test.tsx tests/components/layout/MessageList.test.tsx
git commit -m "fix(ribbon): wire archive, remove categorize/pin stubs"
```

---

## Post-Phase Verification

After all tasks are merged:

```bash
npm run lint
npx tsc --noEmit
npx vitest run
npm run format:check
```

All must pass before moving to Phase 3.

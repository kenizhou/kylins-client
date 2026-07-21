# Composer Window Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the composer pop-out window to the main window's visual standard: glass titlebar with live subject title, Outlook-style Send actions row, close-confirmation dialog, chrome status bar, non-wrapping ribbon with main-window scaling, inset single-row editor toolbar, and consistent 17px ribbon icons.

**Architecture:** Four new focused components under `src/components/composer/window/` (titlebar, actions row, status bar, close dialog) wired into `Composer.tsx` for `windowed` mode only — the inline composer keeps its header/footer. `ComposeRibbon` adopts `ReadRibbon`'s `useElementWidth` scaling (icon-only < 900px, "More" overflow < 640px); `EditorToolbar` becomes an inset single-row card with the same thresholds. Draft flush reuses `draftAutoSave.saveDraftNow` via a new `flushDraftSave` export.

**Tech Stack:** React 19, react-aria-components, TipTap, Zustand, Vitest 4 + Testing Library (jsdom), Tauri window API (mocked in tests).

**Spec:** `docs/superpowers/specs/2026-07-21-composer-window-refresh-design.md`

## Global Constraints

- All frontend commands run from `kylins.client.frontend/`.
- Run tests with `npx vitest run <file>` (NOT `npm test` — that is watch mode).
- TypeScript strict: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess` are on. Indexing an array yields `T | undefined`.
- Tests never hit a real DB or Tauri runtime: `@tauri-apps/api/core`, `@tauri-apps/api/window`, and service modules are mocked. All Tauri window calls (`setTitle`, `onCloseRequested`, `toggleMaximize`) keep try/catch or typeof guards so components render in jsdom.
- The pop-out window (`windowed` mode) gets the new chrome; the inline composer's header/footer are unchanged. `ComposeRibbon`/`EditorToolbar` are shared, so their changes appear in both.
- Every ribbon item icon renders at 17px; icons inside dropdown popover menus stay 14px. New icons come from the Hugeicons wrappers in `src/components/icons.tsx`.
- Known pre-existing noise: 3 failures in `tests/services/theme/contrast.test.ts` unrelated to this work — never touch them.
- The existing `Composer.test.tsx` mocks `draftAutoSave` with only `startAutoSave`/`stopAutoSave` and `getCurrentWindow` returning `{}` — any new import from those modules must be added to the mocks (Task 5 shows how).

---

### Task 1: ComposerTitleBar component

**Files:**
- Create: `kylins.client.frontend/src/components/composer/window/ComposerTitleBar.tsx`
- Test: `kylins.client.frontend/tests/components/composer/window/ComposerTitleBar.test.tsx`

**Interfaces:**
- Consumes: `WindowControls` from `src/components/ui/WindowTitleBar.tsx`; `@tauri-apps/api/window`.
- Produces: `ComposerTitleBar({ title: ReactNode }): JSX.Element` — glass-chrome titlebar used by Task 5. Renders `data-testid="composer-title-bar-drag-region"` for the double-click-maximize area.

- [ ] **Step 1: Write the failing test**

Create `kylins.client.frontend/tests/components/composer/window/ComposerTitleBar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { getCurrentWindow } from '@tauri-apps/api/window';

const toggleMaximize = vi.fn();
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    isMaximized: vi.fn(() => Promise.resolve(false)),
    onResized: vi.fn(() => Promise.resolve(() => {})),
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize,
    close: vi.fn(() => Promise.resolve()),
  })),
}));

import { ComposerTitleBar } from '../../../../src/components/composer/window/ComposerTitleBar';

beforeEach(() => {
  toggleMaximize.mockClear();
  vi.mocked(getCurrentWindow).mockClear();
});

describe('ComposerTitleBar', () => {
  it('renders the given title', () => {
    render(<ComposerTitleBar title="Quarterly report" />);
    expect(screen.getByText('Quarterly report')).toBeInTheDocument();
  });

  it('renders the standard window controls', () => {
    render(<ComposerTitleBar title="New Message" />);
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close window' })).toBeInTheDocument();
  });

  it('toggles maximize on double-click of the drag region', () => {
    render(<ComposerTitleBar title="New Message" />);
    fireEvent.doubleClick(screen.getByTestId('composer-title-bar-drag-region'));
    expect(toggleMaximize).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/components/composer/window/ComposerTitleBar.test.tsx`
Expected: FAIL — module `ComposerTitleBar` does not exist.

- [ ] **Step 3: Implement**

Create `kylins.client.frontend/src/components/composer/window/ComposerTitleBar.tsx`:

```tsx
import { useEffect, useState, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WindowControls } from '@/components/ui/WindowTitleBar';

const dragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'drag',
};
const noDragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'no-drag',
};

function useMaximizedState() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    async function init() {
      try {
        setIsMaximized(await appWindow.isMaximized());
        unlisten = await appWindow.onResized(async () => {
          setIsMaximized(await appWindow.isMaximized());
        });
      } catch {
        // Ignore in non-Tauri contexts (e.g. Vitest/jsdom).
      }
    }
    void init();

    return () => {
      unlisten?.();
    };
  }, []);

  return isMaximized;
}

interface ComposerTitleBarProps {
  title: ReactNode;
}

/**
 * Main-window-style glass titlebar for the composer pop-out window. Mirrors
 * components/layout/TitleBar.tsx chrome (gradient, glass shadow, iris
 * hairline, drag regions, pinned WindowControls) without the menu/search.
 */
export function ComposerTitleBar({ title }: ComposerTitleBarProps) {
  const isMaximized = useMaximizedState();

  async function handleToggleMaximize() {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch {
      // Ignore in non-Tauri contexts.
    }
  }

  return (
    <div
      className="relative z-[var(--z-dropdown)] flex h-[var(--header-h)] shrink-0 items-center pl-4 pr-2 glass bg-gradient-to-b from-[var(--chrome-glass-start)] to-[var(--chrome-glass-end)] shadow-[var(--glass-shadow),var(--chrome-highlight)] select-none"
      style={dragStyle}
    >
      {/* Signature iris hairline along the bottom edge (main-window motif). */}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px iris-line opacity-70" />

      <span className="truncate text-sm font-medium text-[var(--foreground)]">{title}</span>

      <div
        data-testid="composer-title-bar-drag-region"
        className="min-w-[40px] flex-1 cursor-default self-stretch"
        style={dragStyle}
        onDoubleClick={handleToggleMaximize}
        aria-label={
          isMaximized ? 'Double-click to restore window' : 'Double-click to maximize window'
        }
        role="button"
      />

      <div className="flex flex-shrink-0 items-center gap-0.5" style={noDragStyle}>
        <WindowControls />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/components/composer/window/ComposerTitleBar.test.tsx && npx tsc --noEmit`
Expected: PASS (3 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/components/composer/window/ComposerTitleBar.tsx kylins.client.frontend/tests/components/composer/window/ComposerTitleBar.test.tsx
git commit -m "feat(frontend): glass ComposerTitleBar for the pop-out composer"
```

---

### Task 2: ComposerActionsRow component

**Files:**
- Create: `kylins.client.frontend/src/components/composer/window/ComposerActionsRow.tsx`
- Test: `kylins.client.frontend/tests/components/composer/window/ComposerActionsRow.test.tsx`

**Interfaces:**
- Consumes: `SendIcon`, `SpinnerIcon`, `TrashIcon`, `ClockIcon` from `src/components/icons.tsx`.
- Produces: `ComposerActionsRow(props)` used by Task 5:
  ```ts
  interface ComposerActionsRowProps {
    canSend: boolean;
    sending: boolean;
    onSend: () => void;
    onDiscard: () => void;
    onSchedule: () => void;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `kylins.client.frontend/tests/components/composer/window/ComposerActionsRow.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ComposerActionsRow } from '../../../../src/components/composer/window/ComposerActionsRow';

function renderRow(over: Partial<Parameters<typeof ComposerActionsRow>[0]> = {}) {
  const props = {
    canSend: true,
    sending: false,
    onSend: vi.fn(),
    onDiscard: vi.fn(),
    onSchedule: vi.fn(),
    ...over,
  };
  render(<ComposerActionsRow {...props} />);
  return props;
}

describe('ComposerActionsRow', () => {
  it('disables Send when there are no recipients', () => {
    renderRow({ canSend: false });
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
  });

  it('invokes the three callbacks', () => {
    const props = renderRow();
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    fireEvent.click(screen.getByRole('button', { name: /schedule/i }));
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSchedule).toHaveBeenCalledTimes(1);
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
  });

  it('shows a sending state and blocks all actions while sending', () => {
    renderRow({ sending: true });
    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /schedule/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /discard/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/components/composer/window/ComposerActionsRow.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `kylins.client.frontend/src/components/composer/window/ComposerActionsRow.tsx`:

```tsx
import { Button } from 'react-aria-components';
import { SendIcon, SpinnerIcon, TrashIcon, ClockIcon } from '../../icons';

export interface ComposerActionsRowProps {
  canSend: boolean;
  sending: boolean;
  onSend: () => void;
  onDiscard: () => void;
  onSchedule: () => void;
}

/**
 * Outlook-style send actions row: left-aligned above the recipient fields of
 * the composer pop-out window. Replaces the old panel footer's buttons.
 */
export function ComposerActionsRow({
  canSend,
  sending,
  onSend,
  onDiscard,
  onSchedule,
}: ComposerActionsRowProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5">
      <Button
        onPress={onSend}
        isDisabled={!canSend || sending}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-1.5 text-xs font-medium text-[var(--primary-fg)] shadow-[var(--shadow-sm)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {sending ? <SpinnerIcon size={14} /> : <SendIcon size={14} />}
        {sending ? 'Sending…' : 'Send'}
      </Button>
      <Button
        onPress={onSchedule}
        isDisabled={sending}
        className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50"
      >
        <ClockIcon size={14} />
        Schedule
      </Button>
      <Button
        onPress={onDiscard}
        isDisabled={sending}
        className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50"
      >
        <TrashIcon size={14} />
        Discard
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/components/composer/window/ComposerActionsRow.test.tsx && npx tsc --noEmit`
Expected: PASS (3 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/components/composer/window/ComposerActionsRow.tsx kylins.client.frontend/tests/components/composer/window/ComposerActionsRow.test.tsx
git commit -m "feat(frontend): Outlook-style ComposerActionsRow (send/schedule/discard)"
```

---
### Task 3: ComposerStatusBar component

**Files:**
- Create: `kylins.client.frontend/src/components/composer/window/ComposerStatusBar.tsx`
- Test: `kylins.client.frontend/tests/components/composer/window/ComposerStatusBar.test.tsx`

**Interfaces:**
- Consumes: `useComposerStore` (`fromEmail`, `isSaving`, `lastSavedAt`), `useAccountStore`, `useUIStore` (`sendProgress`), `SignatureSelector`, `TemplatePicker`, `SpinnerIcon`.
- Produces: `ComposerStatusBar(props)` used by Task 5:
  ```ts
  interface ComposerStatusBarProps {
    editor: Editor | null; // @tiptap/react — forwarded to TemplatePicker
    wordCount: number;
    charCount: number;
  }
  ```
  Renders a `<footer>` landmark (tests assert on `role="contentinfo"`).

- [ ] **Step 1: Write the failing test**

Create `kylins.client.frontend/tests/components/composer/window/ComposerStatusBar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

// Child pickers hit the DB — render stubs; they are covered by their own tests.
vi.mock('../../../../src/components/composer/SignatureSelector', () => ({
  SignatureSelector: () => <span data-testid="signature-selector" />,
}));
vi.mock('../../../../src/components/composer/TemplatePicker', () => ({
  TemplatePicker: () => <span data-testid="template-picker" />,
}));

import { ComposerStatusBar } from '../../../../src/components/composer/window/ComposerStatusBar';
import { useComposerStore } from '../../../../src/stores/composerStore';
import { useAccountStore } from '../../../../src/stores/accountStore';
import { useUIStore } from '../../../../src/stores/uiStore';

beforeEach(() => {
  useComposerStore.setState({ fromEmail: null, isSaving: false, lastSavedAt: null });
  useAccountStore.setState({
    accounts: [{ id: 'acc-1', email: 'a@example.com', displayName: 'A User', provider: 'imap' }],
    activeAccountId: 'acc-1',
  });
  useUIStore.setState({ sendProgress: { active: false, message: null } });
});

describe('ComposerStatusBar', () => {
  it('renders a footer landmark with the account email and word stats', () => {
    render(<ComposerStatusBar editor={null} wordCount={12} charCount={80} />);
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
    expect(screen.getByText('12 words · 80 characters')).toBeInTheDocument();
    expect(screen.getByTestId('signature-selector')).toBeInTheDocument();
    expect(screen.getByTestId('template-picker')).toBeInTheDocument();
  });

  it('prefers the composer fromEmail over the account email', () => {
    useComposerStore.setState({ fromEmail: 'alias@example.com' });
    render(<ComposerStatusBar editor={null} wordCount={0} charCount={0} />);
    expect(screen.getByText('alias@example.com')).toBeInTheDocument();
    expect(screen.queryByText('a@example.com')).not.toBeInTheDocument();
  });

  it('shows the draft saving/saved indicator', () => {
    useComposerStore.setState({ isSaving: true });
    const { rerender } = render(<ComposerStatusBar editor={null} wordCount={0} charCount={0} />);
    expect(screen.getByText('Saving...')).toBeInTheDocument();
    useComposerStore.setState({ isSaving: false, lastSavedAt: 123 });
    rerender(<ComposerStatusBar editor={null} wordCount={0} charCount={0} />);
    expect(screen.getByText('Draft saved')).toBeInTheDocument();
  });

  it('shows the send-progress indicator only while sending', () => {
    const { rerender } = render(<ComposerStatusBar editor={null} wordCount={0} charCount={0} />);
    expect(screen.queryByText('Sending…')).not.toBeInTheDocument();
    useUIStore.setState({ sendProgress: { active: true, message: null } });
    rerender(<ComposerStatusBar editor={null} wordCount={0} charCount={0} />);
    expect(screen.getByText('Sending…')).toBeInTheDocument();
  });
});
```

(If `useUIStore`'s `sendProgress.message` type is `string | undefined` rather than `null`, adjust the mock values to `undefined` — match the store's type.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/components/composer/window/ComposerStatusBar.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `kylins.client.frontend/src/components/composer/window/ComposerStatusBar.tsx`:

```tsx
import type { Editor } from '@tiptap/react';
import { useComposerStore } from '@/stores/composerStore';
import { useAccountStore } from '@/stores/accountStore';
import { useUIStore } from '@/stores/uiStore';
import { SignatureSelector } from '../SignatureSelector';
import { TemplatePicker } from '../TemplatePicker';
import { SpinnerIcon } from '../../icons';

export interface ComposerStatusBarProps {
  editor: Editor | null;
  wordCount: number;
  charCount: number;
}

/**
 * Main-window-style status bar for the composer pop-out. Left: identity +
 * draft + send state. Right: live word stats and the signature/template
 * pickers (relocated from the old panel footer).
 */
export function ComposerStatusBar({ editor, wordCount, charCount }: ComposerStatusBarProps) {
  const fromEmail = useComposerStore((s) => s.fromEmail);
  const isSaving = useComposerStore((s) => s.isSaving);
  const lastSavedAt = useComposerStore((s) => s.lastSavedAt);
  const activeAccount = useAccountStore((s) =>
    s.accounts.find((a) => a.id === s.activeAccountId),
  );
  const sendProgress = useUIStore((s) => s.sendProgress);

  const savedLabel = isSaving ? 'Saving...' : lastSavedAt ? 'Draft saved' : null;

  return (
    <footer className="flex h-[var(--status-h)] shrink-0 items-center justify-between border-t border-[var(--border-subtle)] bg-[var(--chrome)] px-3 text-xs text-[var(--muted-text)]">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate">{fromEmail ?? activeAccount?.email ?? 'No account'}</span>
        {savedLabel && (
          <span
            className={`italic transition-opacity duration-200 ${isSaving ? 'animate-pulse' : ''}`}
          >
            {savedLabel}
          </span>
        )}
        {sendProgress.active && (
          <span
            className="inline-flex items-center gap-1.5 text-[var(--primary)]"
            title={sendProgress.message}
          >
            <SpinnerIcon size={12} />
            <span>{sendProgress.message ?? 'Sending…'}</span>
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="tabular-nums">
          {wordCount} words · {charCount} characters
        </span>
        <span className="mx-1 h-3 w-px bg-[var(--border-subtle)]" />
        <SignatureSelector />
        <TemplatePicker editor={editor} />
      </div>
    </footer>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/components/composer/window/ComposerStatusBar.test.tsx && npx tsc --noEmit`
Expected: PASS (4 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/components/composer/window/ComposerStatusBar.tsx kylins.client.frontend/tests/components/composer/window/ComposerStatusBar.test.tsx
git commit -m "feat(frontend): chrome ComposerStatusBar with word stats and pickers"
```

---

### Task 4: CloseConfirmDialog + `flushDraftSave` export

**Files:**
- Create: `kylins.client.frontend/src/components/composer/window/CloseConfirmDialog.tsx`
- Modify: `kylins.client.frontend/src/services/composer/draftAutoSave.ts`
- Test: `kylins.client.frontend/tests/components/composer/window/CloseConfirmDialog.test.tsx`

**Interfaces:**
- Consumes: react-aria-components (`ModalOverlay`, `Modal`, `Dialog`, `Heading`, `Button`) — same modal pattern as `src/components/ui/InputDialog.tsx`.
- Produces:
  - `CloseConfirmDialog(props)` used by Task 5:
    ```ts
    interface CloseConfirmDialogProps {
      isOpen: boolean;
      onSaveDraft: () => void;
      onDiscard: () => void;
      onCancel: () => void;
    }
    ```
  - `flushDraftSave(): Promise<void>` exported from `src/services/composer/draftAutoSave.ts` — clears the pending debounce timer and immediately runs the existing `saveDraftNow()`.

- [ ] **Step 1: Write the failing test**

Create `kylins.client.frontend/tests/components/composer/window/CloseConfirmDialog.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CloseConfirmDialog } from '../../../../src/components/composer/window/CloseConfirmDialog';

function renderDialog(over: Partial<Parameters<typeof CloseConfirmDialog>[0]> = {}) {
  const props = {
    isOpen: true,
    onSaveDraft: vi.fn(),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  render(<CloseConfirmDialog {...props} />);
  return props;
}

describe('CloseConfirmDialog', () => {
  it('asks to save the draft', () => {
    renderDialog();
    expect(screen.getByText('Save this draft?')).toBeInTheDocument();
  });

  it('Save Draft invokes onSaveDraft', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }));
    expect(props.onSaveDraft).toHaveBeenCalledTimes(1);
    expect(props.onDiscard).not.toHaveBeenCalled();
  });

  it("Don't Save invokes onDiscard", () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: "Don't Save" }));
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
    expect(props.onSaveDraft).not.toHaveBeenCalled();
  });

  it('Cancel invokes onCancel without saving or discarding', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onSaveDraft).not.toHaveBeenCalled();
    expect(props.onDiscard).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/components/composer/window/CloseConfirmDialog.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

**3a.** Create `kylins.client.frontend/src/components/composer/window/CloseConfirmDialog.tsx`:

```tsx
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';

export interface CloseConfirmDialogProps {
  isOpen: boolean;
  onSaveDraft: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

/**
 * Pop-out close confirmation: shown when the window close is requested with
 * unsaved content. Save Draft / Don't Save / Cancel.
 */
export function CloseConfirmDialog({
  isOpen,
  onSaveDraft,
  onDiscard,
  onCancel,
}: CloseConfirmDialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-[var(--backdrop)]"
    >
      <Modal className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-floating)] shadow-[var(--shadow-lg)]">
        <Dialog className="w-80 p-4 outline-none" aria-label="Save this draft?">
          <Heading slot="title" className="text-sm font-medium text-[var(--foreground)]">
            Save this draft?
          </Heading>
          <p className="mt-1 text-xs text-[var(--muted-text)]">
            Your message has unsaved changes.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              onPress={onCancel}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Cancel
            </Button>
            <Button
              onPress={onDiscard}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--destructive)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Don&apos;t Save
            </Button>
            <Button
              onPress={onSaveDraft}
              className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-fg)] shadow-[var(--shadow-sm)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Save Draft
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
```

**3b.** In `kylins.client.frontend/src/services/composer/draftAutoSave.ts`, append at the end of the file:

```ts
/**
 * Immediately persist the current draft, cancelling any pending debounced
 * save. Used by the pop-out window's close confirmation ("Save Draft").
 * Safe to call when auto-save was never started (saveDraftNow no-ops).
 */
export async function flushDraftSave(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  await saveDraftNow();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/components/composer/window/CloseConfirmDialog.test.tsx && npx tsc --noEmit`
Expected: PASS (4 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/components/composer/window/CloseConfirmDialog.tsx kylins.client.frontend/src/services/composer/draftAutoSave.ts kylins.client.frontend/tests/components/composer/window/CloseConfirmDialog.test.tsx
git commit -m "feat(frontend): close-confirmation dialog + flushDraftSave export"
```

---
### Task 5: Composer wiring (windowed chrome, close interception, live title, word stats)

**Files:**
- Modify: `kylins.client.frontend/src/components/composer/Composer.tsx`
- Test: `kylins.client.frontend/tests/components/composer/Composer.test.tsx`

**Interfaces:**
- Consumes: Task 1 `ComposerTitleBar({ title })`; Task 2 `ComposerActionsRow({ canSend, sending, onSend, onDiscard, onSchedule })`; Task 3 `ComposerStatusBar({ editor, wordCount, charCount })`; Task 4 `CloseConfirmDialog({ isOpen, onSaveDraft, onDiscard, onCancel })` and `flushDraftSave()` from `services/composer/draftAutoSave`.
- Produces: the windowed composer column — ComposerTitleBar → ComposerActionsRow → CommandRibbon → addresses → subject → EditorToolbar → editor → attachments → ComposerStatusBar. No public interface changes (Tasks 6-7 do not consume Composer).

- [ ] **Step 1: Update mocks and write the failing tests**

**1a.** In `kylins.client.frontend/tests/components/composer/Composer.test.tsx`, replace the two Tauri mocks near the top:

```ts
const setTitle = vi.fn(() => Promise.resolve());
const windowClose = vi.fn(() => Promise.resolve());
let closeRequestedHandler: ((event: { preventDefault: () => void }) => void) | null = null;

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    setTitle,
    close: windowClose,
    isMaximized: vi.fn(() => Promise.resolve(false)),
    onResized: vi.fn(() => Promise.resolve(() => {})),
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    onCloseRequested: vi.fn((cb: (event: { preventDefault: () => void }) => void) => {
      closeRequestedHandler = cb;
      return Promise.resolve(() => {
        closeRequestedHandler = null;
      });
    }),
  })),
}));
```

(Replace the existing single-line `vi.mock('@tauri-apps/api/window', ...)`; keep the `vi.mock('@tauri-apps/api/core', ...)` and `vi.mock('@tauri-apps/plugin-dialog', ...)` lines as they are.)

**1b.** Extend the draftAutoSave mock:

```ts
vi.mock('../../../src/services/composer/draftAutoSave', () => ({
  startAutoSave: vi.fn(() => () => {}),
  stopAutoSave: vi.fn(),
  flushDraftSave: vi.fn(() => Promise.resolve()),
}));
```

**1c.** In `beforeEach`, add:

```ts
  setTitle.mockClear();
  windowClose.mockClear();
  closeRequestedHandler = null;
```

**1d.** Append at the end of the file:

```tsx
describe('Composer windowed (pop-out)', () => {
  it('renders the glass titlebar with the subject, the actions row, and the status bar', () => {
    useComposerStore.setState({ subject: 'Quarterly report' });
    render(<Composer windowed />);
    expect(screen.getByTestId('composer-title-bar-drag-region')).toBeInTheDocument();
    expect(screen.getByText('Quarterly report')).toBeInTheDocument();
    expect(setTitle).toHaveBeenCalledWith('Quarterly report');
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /schedule/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByText(/words · /)).toBeInTheDocument();
  });

  it('falls back to the mode label when the subject is empty', () => {
    render(<Composer windowed />);
    expect(screen.getByText('New Message')).toBeInTheDocument();
    expect(setTitle).toHaveBeenCalledWith('New Message');
  });

  it('does not render the inline footer (no footer landmark when inline, status bar when windowed)', () => {
    const { unmount } = render(<Composer />);
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
    unmount();
    render(<Composer windowed />);
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('lets an untouched empty compose close without prompting', async () => {
    render(<Composer windowed />);
    expect(closeRequestedHandler).not.toBeNull();
    const event = { preventDefault: vi.fn() };
    await closeRequestedHandler!(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByText('Save this draft?')).not.toBeInTheDocument();
  });

  it('intercepts close with unsaved content and shows the confirm dialog', async () => {
    useComposerStore.setState({ subject: 'Unsaved work' });
    render(<Composer windowed />);
    const event = { preventDefault: vi.fn() };
    await closeRequestedHandler!(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(screen.getByText('Save this draft?')).toBeInTheDocument();

    // Cancel dismisses without closing.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Save this draft?')).not.toBeInTheDocument();
    expect(windowClose).not.toHaveBeenCalled();
  });

  it("Don't Save discards and closes the window", async () => {
    useComposerStore.setState({ subject: 'Unsaved work' });
    render(<Composer windowed />);
    await closeRequestedHandler!({ preventDefault: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: "Don't Save" }));
    await waitFor(() => expect(windowClose).toHaveBeenCalled());
  });

  it('Save Draft flushes the draft and closes the window', async () => {
    const { flushDraftSave } = await import('../../../src/services/composer/draftAutoSave');
    useComposerStore.setState({ subject: 'Unsaved work' });
    render(<Composer windowed />);
    await closeRequestedHandler!({ preventDefault: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }));
    await waitFor(() => expect(flushDraftSave).toHaveBeenCalled());
    await waitFor(() => expect(windowClose).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kylins.client.frontend && npx vitest run tests/components/composer/Composer.test.tsx`
Expected: FAIL — `ComposerTitleBar` module not found in `Composer.tsx`… actually the new tests fail because the windowed render lacks the titlebar/status bar (`getByTestId('composer-title-bar-drag-region')` not found, `contentinfo` missing, `setTitle` never called, no close interception). The pre-existing inline tests still pass.

- [ ] **Step 3: Implement the Composer.tsx edits**

**3a.** Imports — in `kylins.client.frontend/src/components/composer/Composer.tsx`:

Delete:
```ts
import { WindowTitleBar } from '@/components/ui/WindowTitleBar';
```

Add (near the other component imports):
```ts
import { ComposerTitleBar } from './window/ComposerTitleBar';
import { ComposerActionsRow } from './window/ComposerActionsRow';
import { ComposerStatusBar } from './window/ComposerStatusBar';
import { CloseConfirmDialog } from './window/CloseConfirmDialog';
```

Change:
```ts
import { startAutoSave, stopAutoSave } from '@/services/composer/draftAutoSave';
```
to:
```ts
import { startAutoSave, stopAutoSave, flushDraftSave } from '@/services/composer/draftAutoSave';
```

**3b.** State — next to the existing `const [showSchedule, setShowSchedule] = useState(false);` add:

```ts
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [wordStats, setWordStats] = useState({ words: 0, chars: 0 });
```

**3c.** `modeLabel` — move it above the `if (!isOpen) return null;` early return (it is pure). Insert before that line:

```ts
  const modeLabel =
    mode === 'reply'
      ? 'Reply'
      : mode === 'replyAll'
        ? 'Reply All'
        : mode === 'forward'
          ? 'Forward'
          : 'New Message';
```

and DELETE the duplicate `const modeLabel = ...` declaration that currently sits after the early return (keep the later `savedLabel`, `isFullpage`, `prominent` declarations where they are).

**3d.** Word stats — in the `useEditor` config's `onUpdate`, change its first lines from:

```ts
    onUpdate: ({ editor: ed }) => {
      useComposerStore.getState().setBodyHtml(ed.getHTML());

      // Template shortcut expansion (e.g. ";sig" → signature template body).
      const templates = templateShortcutsRef.current;
      if (templates.length === 0) return;

      const text = ed.state.doc.textContent;
```

to:

```ts
    onUpdate: ({ editor: ed }) => {
      useComposerStore.getState().setBodyHtml(ed.getHTML());

      // Live word/character stats for the pop-out status bar.
      const text = ed.state.doc.textContent;
      setWordStats({
        words: text.split(/\s+/).filter(Boolean).length,
        chars: text.length,
      });

      // Template shortcut expansion (e.g. ";sig" → signature template body).
      const templates = templateShortcutsRef.current;
      if (templates.length === 0) return;

```

(The trailing `const text = ed.state.doc.textContent;` line is removed — `text` is now declared above and the rest of the block is unchanged.)

**3e.** New effects — after the existing start/stop auto-save effect, add:

```ts
  // Seed word stats from the initial editor content (e.g. reopened draft).
  useEffect(() => {
    if (!editor) return;
    const text = editor.state.doc.textContent;
    setWordStats({
      words: text.split(/\s+/).filter(Boolean).length,
      chars: text.length,
    });
  }, [editor]);

  // Keep the OS window title (taskbar / alt-tab) in sync with the subject.
  useEffect(() => {
    if (!windowed) return;
    try {
      void getCurrentWindow().setTitle(subject.trim() || modeLabel);
    } catch {
      // Ignore in non-Tauri contexts.
    }
  }, [windowed, subject, modeLabel]);

  // Intercept the window close with unsaved content → confirm dialog.
  useEffect(() => {
    if (!windowed) return;
    const win = getCurrentWindow();
    if (typeof win.onCloseRequested !== 'function') return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void win
      .onCloseRequested((event) => {
        const state = useComposerStore.getState();
        const bodyEmpty = (editor?.getText().trim() ?? '') === '';
        const untouched = state.to.length === 0 && state.subject.trim() === '' && bodyEmpty;
        if (untouched) return; // empty compose closes without prompting
        event.preventDefault();
        setCloseConfirmOpen(true);
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [windowed, editor]);
```

**3f.** Save-draft-and-close handler — next to `handleClose`, add:

```ts
  const handleSaveDraftAndClose = useCallback(async () => {
    try {
      await flushDraftSave();
    } catch (e) {
      useToastStore
        .getState()
        .push(`Save draft failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
      return; // keep the window open so the user can retry
    }
    stopAutoSave();
    closeComposer();
    await closeWindowIfWindowed();
  }, [closeComposer, closeWindowIfWindowed]);
```

**3g.** Header JSX — replace:

```tsx
      {/* Header */}
      {windowed ? (
        <WindowTitleBar title={modeLabel} />
      ) : (
```

with:

```tsx
      {/* Header */}
      {windowed ? (
        <>
          <ComposerTitleBar title={subject.trim() || modeLabel} />
          <ComposerActionsRow
            canSend={to.length > 0}
            sending={sendProgressActive}
            onSend={() => void handleSendAndCloseWindow()}
            onDiscard={() => void handleDiscard()}
            onSchedule={() => setShowSchedule(true)}
          />
        </>
      ) : (
```

**3h.** Footer JSX — replace:

```tsx
      {/* Footer */}
      <div className="flex items-center justify-between rounded-b-2xl border-t border-[var(--border-subtle)] bg-[var(--chrome-tint)] px-4 py-2.5">
```

with:

```tsx
      {/* Footer (inline) / status bar (windowed) */}
      {windowed ? (
        <ComposerStatusBar
          editor={editor}
          wordCount={wordStats.words}
          charCount={wordStats.chars}
        />
      ) : (
      <div className="flex items-center justify-between rounded-b-2xl border-t border-[var(--border-subtle)] bg-[var(--chrome-tint)] px-4 py-2.5">
```

and replace the footer's closing tag (the `</div>` immediately before `{showSchedule && (`):

```tsx
      </div>
```

with:

```tsx
      </div>
      )}
```

(Keep the footer's inner content byte-identical; only the wrapping changes. If prettier reformats the indentation on commit, that is fine.)

**3i.** Dialog JSX — immediately before `{showSchedule && (`, add:

```tsx
      {windowed && (
        <CloseConfirmDialog
          isOpen={closeConfirmOpen}
          onSaveDraft={() => {
            setCloseConfirmOpen(false);
            void handleSaveDraftAndClose();
          }}
          onDiscard={() => {
            setCloseConfirmOpen(false);
            void handleDiscard();
          }}
          onCancel={() => setCloseConfirmOpen(false)}
        />
      )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kylins.client.frontend && npx vitest run tests/components/composer/Composer.test.tsx tests/components/composer/Composer.a11y.test.tsx && npx tsc --noEmit`
Expected: PASS (all pre-existing + 7 new windowed tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/components/composer/Composer.tsx kylins.client.frontend/tests/components/composer/Composer.test.tsx
git commit -m "feat(frontend): windowed composer chrome — titlebar, actions row, status bar, close confirmation"
```

---
### Task 6: ComposeRibbon — icons, no Link, main-window scaling + RibbonShell no-wrap

**Files:**
- Modify: `kylins.client.frontend/src/components/layout/ribbon/ComposeRibbon.tsx`
- Modify: `kylins.client.frontend/src/components/layout/ribbon/RibbonShell.tsx`
- Test: `kylins.client.frontend/tests/components/layout/ribbon/ComposeRibbon.test.tsx` (new)

**Interfaces:**
- Consumes: `useElementWidth` from `src/hooks/useElementWidth.ts`; `WarningIcon`, `BellIcon`, `MoreIcon`, `CheckIcon` from `src/components/icons.tsx`; `RibbonShell` (forwardRef), `RibbonGroup`, `RibbonButton` (accepts `iconOnly`), `RibbonToggle` from `./RibbonPrimitives`.
- Produces: no API changes — `ComposeRibbon()` keeps its signature. `CommandRibbon mode="compose"` consumers are unaffected.

- [ ] **Step 1: Write the failing tests**

Create `kylins.client.frontend/tests/components/layout/ribbon/ComposeRibbon.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

// Configurable ribbon width for the scaling tests.
let ribbonWidth = 1200;
vi.mock('../../../../src/hooks/useElementWidth', () => ({
  useElementWidth: () => ({ ref: { current: null }, width: ribbonWidth }),
}));

import { ComposeRibbon } from '../../../../src/components/layout/ribbon/ComposeRibbon';
import { useComposerStore } from '../../../../src/stores/composerStore';

beforeEach(() => {
  ribbonWidth = 1200;
  useComposerStore.setState({
    importance: 'normal',
    isEncrypted: false,
    isSigned: false,
    preventCopy: false,
    requestReadReceipt: false,
    requestDeliveryReceipt: false,
    deliverAt: null,
  });
});

describe('ComposeRibbon', () => {
  it('shows every ribbon item with an icon and no Link button', () => {
    const { container } = render(<ComposeRibbon />);
    // Link removed; insert-link lives in the editor toolbar / Ctrl+K.
    expect(screen.queryByRole('button', { name: /^link$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delay delivery/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /attach/i })).toBeInTheDocument();

    // Every labeled ribbon item renders a leading svg icon.
    for (const name of ['Delay Delivery', 'Attach', 'Importance', 'Tracking']) {
      const btn = screen.getByRole('button', { name: new RegExp(name, 'i') });
      expect(btn.querySelector('svg')).not.toBeNull();
    }
    // Toggle icons unified at 17px.
    const encrypt = screen.getByRole('checkbox', { name: /encrypt/i });
    expect(encrypt.querySelector('svg')?.getAttribute('width')).toBe('17');
    void container;
  });

  it('collapses labels to icons below 900px', () => {
    ribbonWidth = 800;
    render(<ComposeRibbon />);
    // Accessible names remain (aria-label), visible label text is gone.
    const attach = screen.getByRole('button', { name: /attach/i });
    expect(attach.textContent).not.toContain('Attach');
    // Importance trigger keeps its icon and caret but hides the text.
    const importance = screen.getByRole('button', { name: /importance/i });
    expect(importance.textContent).not.toContain('Importance');
    expect(importance.querySelector('svg')).not.toBeNull();
  });

  it('collapses secondary groups into a More overflow menu below 640px', () => {
    ribbonWidth = 500;
    render(<ComposeRibbon />);
    expect(screen.queryByRole('checkbox', { name: /encrypt/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /importance/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /tracking/i })).not.toBeInTheDocument();
    // Primary actions stay visible.
    expect(screen.getByRole('button', { name: /delay delivery/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /attach/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    expect(screen.getByRole('menuitem', { name: /high/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /read receipt/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /encrypt/i })).toBeInTheDocument();
  });

  it('overflow menu actions update composer state', () => {
    ribbonWidth = 500;
    render(<ComposeRibbon />);
    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^high$/i }));
    expect(useComposerStore.getState().importance).toBe('high');
    fireEvent.click(screen.getByRole('menuitem', { name: /encrypt/i }));
    expect(useComposerStore.getState().isEncrypted).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kylins.client.frontend && npx vitest run tests/components/layout/ribbon/ComposeRibbon.test.tsx`
Expected: FAIL — Link button still present, no icons on Importance/Tracking triggers, toggle icons at 14px, no iconOnly/compact behavior.

- [ ] **Step 3: Implement**

**3a.** `kylins.client.frontend/src/components/layout/ribbon/RibbonShell.tsx` — the inner row becomes single-line (the main window's ReadRibbon already scales via overflow instead of wrapping):

```tsx
      <div className="flex min-w-0 flex-nowrap items-stretch overflow-hidden">{children}</div>
```

(replacing `flex min-w-0 flex-wrap items-stretch gap-y-1`).

**3b.** `kylins.client.frontend/src/components/layout/ribbon/ComposeRibbon.tsx`:

Update imports — add `useState`, `DialogTrigger`, `useElementWidth`, and the new icons; remove `LinkIcon`:

```tsx
import { useState } from 'react';
import {
  MenuTrigger,
  Button,
  Popover,
  Menu,
  MenuItem,
  DialogTrigger,
  Separator,
} from 'react-aria-components';
import {
  ClockIcon,
  AttachmentIcon,
  CopySlashIcon,
  ArrowUpIcon,
  MinusIcon,
  ArrowDownIcon,
  LockIcon,
  ShieldCheckIcon,
  CaretDownIcon,
  MailOpenIcon,
  MailIcon,
  CheckIcon,
  WarningIcon,
  BellIcon,
  MoreIcon,
} from '../../icons';
import { useElementWidth } from '../../../hooks/useElementWidth';
```

Inside `ComposeRibbon()`, after the existing store/classification setup, add:

```tsx
  const [overflowOpen, setOverflowOpen] = useState(false);
  const { ref: ribbonRef, width: ribbonWidth } = useElementWidth<HTMLElement>();
  const compact = ribbonWidth > 0 && ribbonWidth < 640;
  const iconOnly = ribbonWidth > 0 && ribbonWidth < 900;
```

Pass the ref to the shell: `<RibbonShell ref={ribbonRef}>`.

Delay Delivery button — add `iconOnly`:

```tsx
        <RibbonButton
          icon={<ClockIcon size={17} />}
          split
          iconOnly={iconOnly}
          title={...unchanged...}
          className={...unchanged...}
          onClick={...unchanged...}
        >
          {scheduleActive ? 'Scheduled' : 'Delay Delivery'}
        </RibbonButton>
```

Importance group — wrap in `{!compact && (...)}` and give the trigger an icon + conditional label:

```tsx
      {!compact && (
      <RibbonGroup>
        <MenuTrigger>
          <Button
            className="flex items-center gap-1.5 rounded px-2.5 h-11 my-auto text-sm text-[var(--text)] transition-colors hover:bg-[var(--primary-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            aria-label="Importance"
          >
            <WarningIcon size={17} />
            {!iconOnly && <span className="whitespace-nowrap">Importance: {importanceLabel}</span>}
            <CaretDownIcon size={10} className="opacity-70" />
          </Button>
          <Popover ...unchanged...>
            ...unchanged importance Menu...
          </Popover>
        </MenuTrigger>
      </RibbonGroup>
      )}
```

Tracking group — same treatment (`{!compact && (...)}`), trigger gains `<BellIcon size={17} />` and `{!iconOnly && <span className="whitespace-nowrap">Tracking</span>}` (keep the active-dot span and caret).

Security group — wrap in `{!compact && (...)}` and bump all three toggle icons to 17:

```tsx
      {!compact && (
      <RibbonGroup>
        <RibbonToggle
          icon={<LockIcon size={17} />}
          label="Encrypt"
          checked={isEncrypted}
          disabled={requiresCrypto}
          onChange={setIsEncrypted}
        />
        <RibbonToggle
          icon={<ShieldCheckIcon size={17} />}
          label="Sign"
          checked={isSigned}
          disabled={requiresCrypto}
          onChange={setIsSigned}
        />
        <RibbonToggle
          icon={<CopySlashIcon size={17} />}
          label="Prevent Copy"
          title="Discourage forwarding/copying (best-effort)"
          checked={preventCopy}
          onChange={setPreventCopy}
        />
      </RibbonGroup>
      )}
```

Attach group — remove the Link button and add `iconOnly`:

```tsx
      <RibbonGroup>
        <RibbonButton
          icon={<AttachmentIcon size={17} />}
          iconOnly={iconOnly}
          onClick={() => window.dispatchEvent(new Event('composer:attach-requested'))}
        >
          Attach
        </RibbonButton>
      </RibbonGroup>
```

More overflow group — append before `</RibbonShell>`:

```tsx
      {compact && (
        <RibbonGroup>
          <DialogTrigger isOpen={overflowOpen} onOpenChange={setOverflowOpen}>
            <RibbonButton icon={<MoreIcon size={17} />} iconOnly title="More actions">
              More
            </RibbonButton>
            <Popover className="min-w-[180px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg">
              <Menu aria-label="More actions" className="outline-none">
                {importanceOptions.map((option) => (
                  <MenuItem
                    key={option.value}
                    id={option.value}
                    onAction={() => setImportance(option.value)}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
                  >
                    <span className="text-[var(--muted-text)]">{option.icon}</span>
                    <span className="flex-1 whitespace-nowrap">{option.label}</span>
                    {importance === option.value && (
                      <CheckIcon size={14} className="text-[var(--primary)]" />
                    )}
                  </MenuItem>
                ))}
                <Separator className="my-1 border-t border-[var(--border-subtle)]" />
                <MenuItem
                  id="read-receipt"
                  onAction={() => setRequestReadReceipt(!requestReadReceipt)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
                >
                  <MailOpenIcon size={14} className="text-[var(--muted-text)]" />
                  <span className="flex-1 whitespace-nowrap">Read Receipt</span>
                  {requestReadReceipt && <CheckIcon size={14} className="text-[var(--primary)]" />}
                </MenuItem>
                <MenuItem
                  id="delivery-receipt"
                  onAction={() => setRequestDeliveryReceipt(!requestDeliveryReceipt)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
                >
                  <MailIcon size={14} className="text-[var(--muted-text)]" />
                  <span className="flex-1 whitespace-nowrap">Delivery Receipt</span>
                  {requestDeliveryReceipt && (
                    <CheckIcon size={14} className="text-[var(--primary)]" />
                  )}
                </MenuItem>
                <Separator className="my-1 border-t border-[var(--border-subtle)]" />
                <MenuItem
                  id="encrypt"
                  isDisabled={requiresCrypto}
                  onAction={() => setIsEncrypted(!isEncrypted)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)] data-[disabled]:opacity-50"
                >
                  <LockIcon size={14} className="text-[var(--muted-text)]" />
                  <span className="flex-1 whitespace-nowrap">Encrypt</span>
                  {isEncrypted && <CheckIcon size={14} className="text-[var(--primary)]" />}
                </MenuItem>
                <MenuItem
                  id="sign"
                  isDisabled={requiresCrypto}
                  onAction={() => setIsSigned(!isSigned)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)] data-[disabled]:opacity-50"
                >
                  <ShieldCheckIcon size={14} className="text-[var(--muted-text)]" />
                  <span className="flex-1 whitespace-nowrap">Sign</span>
                  {isSigned && <CheckIcon size={14} className="text-[var(--primary)]" />}
                </MenuItem>
                <MenuItem
                  id="prevent-copy"
                  onAction={() => setPreventCopy(!preventCopy)}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)] data-[focus-visible]:bg-[var(--primary-subtle)]"
                >
                  <CopySlashIcon size={14} className="text-[var(--muted-text)]" />
                  <span className="flex-1 whitespace-nowrap">Prevent Copy</span>
                  {preventCopy && <CheckIcon size={14} className="text-[var(--primary)]" />}
                </MenuItem>
              </Menu>
            </Popover>
          </DialogTrigger>
        </RibbonGroup>
      )}
```

(If `WarningIcon`, `BellIcon`, or `MoreIcon` is not exported from `src/components/icons.tsx`, add it following the file's existing `makeIcon(...)` Hugeicons pattern — check ReadRibbon's `MoreIcon` import for the exact name.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kylins.client.frontend && npx vitest run tests/components/layout/ribbon/ && npx tsc --noEmit`
Expected: PASS — the 4 new ComposeRibbon tests plus the existing ReadRibbon/RibbonPrimitives suites (the RibbonShell no-wrap change must not break them).

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/components/layout/ribbon/ComposeRibbon.tsx kylins.client.frontend/src/components/layout/ribbon/RibbonShell.tsx kylins.client.frontend/tests/components/layout/ribbon/ComposeRibbon.test.tsx
git commit -m "feat(frontend): compose ribbon icons, no-wrap scaling, drop Link"
```

---

### Task 7: EditorToolbar — inset card, single row, scaling overflow + full suite

**Files:**
- Modify: `kylins.client.frontend/src/components/composer/EditorToolbar.tsx`
- Test: `kylins.client.frontend/tests/components/composer/EditorToolbar.test.tsx` (new)

**Interfaces:**
- Consumes: `useElementWidth`; `MoreIcon`; existing `ToolbarButton`/`ToolbarDivider`/`ColorButton`/`FontFamilySelect` locals.
- Produces: no API change — `EditorToolbar({ editor, onRequestLink, onToggleAiAssist, aiAssistOpen })` unchanged.

- [ ] **Step 1: Write the failing tests**

Create `kylins.client.frontend/tests/components/composer/EditorToolbar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Editor } from '@tiptap/react';

let toolbarWidth = 1200;
vi.mock('../../../src/hooks/useElementWidth', () => ({
  useElementWidth: () => ({ ref: { current: null }, width: toolbarWidth }),
}));

import { EditorToolbar } from '../../../src/components/composer/EditorToolbar';

function fakeEditor() {
  const calls: string[] = [];
  const chainable = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === 'run') return () => undefined;
        return () => {
          calls.push(prop);
          return chainable;
        };
      },
    },
  );
  return {
    calls,
    editor: {
      can: () => ({ undo: () => true, redo: () => true }),
      isActive: () => false,
      chain: () => chainable,
    } as unknown as Editor,
  };
}

beforeEach(() => {
  toolbarWidth = 1200;
});

describe('EditorToolbar', () => {
  it('renders as an inset single-row card (side margins, no full-bleed, no wrap)', () => {
    const { container } = render(
      <EditorToolbar editor={fakeEditor().editor} onRequestLink={() => {}} />,
    );
    const bar = container.firstElementChild!;
    expect(bar.className).toContain('mx-1');
    expect(bar.className).toContain('rounded-xl');
    expect(bar.className).toContain('flex-nowrap');
    expect(bar.className).not.toContain('flex-wrap');
  });

  it('keeps core actions and collapses extras into a More menu below 640px', () => {
    toolbarWidth = 500;
    render(<EditorToolbar editor={fakeEditor().editor} onRequestLink={() => {}} />);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Heading 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bullet list' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Insert image' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    expect(screen.getByRole('menuitem', { name: 'Heading 1' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Bullet list' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Insert link' })).toBeInTheDocument();
  });

  it('hides the font/highlight cluster below 900px (into the More menu)', () => {
    toolbarWidth = 800;
    render(<EditorToolbar editor={fakeEditor().editor} onRequestLink={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Highlight' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more/i })).toBeInTheDocument();
  });

  it('overflow menu items run editor commands', () => {
    toolbarWidth = 500;
    const { calls, editor } = fakeEditor();
    render(<EditorToolbar editor={editor} onRequestLink={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bullet list' }));
    expect(calls).toContain('toggleBulletList');
  });
});
```

(If `ColorButton`/`FontFamilySelect` require richer editor internals, note they are hidden in the narrow tests and rendered at width 1200 in the first test — the Proxy editor satisfies both; adjust the fake only if a runtime error proves otherwise.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kylins.client.frontend && npx vitest run tests/components/composer/EditorToolbar.test.tsx`
Expected: FAIL — bar is full-bleed `flex-wrap`, no More menu, nothing collapses.

- [ ] **Step 3: Implement**

In `kylins.client.frontend/src/components/composer/EditorToolbar.tsx`:

**3a.** Imports — add:

```tsx
import { useRef, useState } from 'react';
import { DialogTrigger, Menu, MenuItem } from 'react-aria-components';
import { MoreIcon } from '../icons';
import { useElementWidth } from '@/hooks/useElementWidth';
```

(`useRef` is already imported — merge instead of duplicating. `Popover` is already imported from react-aria-components; reuse it.)

**3b.** Inside `EditorToolbar`, before `if (!editor) return null;`... note: hooks may not run conditionally — the component currently returns null early. Restructure so hooks run first:

```tsx
export function EditorToolbar({
  editor,
  onRequestLink,
  onToggleAiAssist,
  aiAssistOpen,
}: EditorToolbarProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const { ref: barRef, width: barWidth } = useElementWidth<HTMLDivElement>();
  const narrow = barWidth > 0 && barWidth < 900;
  const compact = barWidth > 0 && barWidth < 640;

  if (!editor) return null;
  // ...rest unchanged
```

**3c.** Outer bar — replace:

```tsx
    <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--border)] bg-[var(--surface)] px-2 py-1">
```

with:

```tsx
    <div
      ref={barRef}
      className="mx-1 mt-1 flex flex-nowrap items-center gap-0.5 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] px-2 py-1 shadow-[var(--ribbon-elevation)] md:mx-2"
    >
```

**3d.** Group collapsing — wrap the conditional clusters:

- Wrap the H1/H2/H3 buttons AND the second cluster (Highlight, ColorButton, FontFamilySelect) so that:
  - the three heading buttons render only when `!compact`
  - Highlight renders only when `!narrow`
  - `<ColorButton editor={editor} />` and `<FontFamilySelect editor={editor} />` render only when `!narrow`
- Wrap the lists cluster (BulletList, OrderedList, Quote, CodeBlock) and the link/image cluster so they render only when `!compact`. (The hidden file `<input ref={imageInputRef} ...>` must ALWAYS render — keep it outside the conditional.)
- The ToolbarDividers adjacent to a fully hidden cluster should move inside that cluster's conditional (no orphaned dividers).

**3e.** More menu — render when anything is collapsed (`narrow || compact`), immediately before `<div className="flex-1" />`:

```tsx
      {(narrow || compact) && (
        <DialogTrigger isOpen={overflowOpen} onOpenChange={setOverflowOpen}>
          <Button
            aria-label="More formatting"
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--muted-text)] transition-colors hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <MoreIcon size={16} />
          </Button>
          <Popover className="min-w-[180px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg">
            <Menu aria-label="More formatting" className="outline-none">
              {compact && (
                <>
                  <MenuItem
                    id="h1"
                    onAction={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                  >
                    Heading 1
                  </MenuItem>
                  <MenuItem
                    id="h2"
                    onAction={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                  >
                    Heading 2
                  </MenuItem>
                  <MenuItem
                    id="h3"
                    onAction={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                  >
                    Heading 3
                  </MenuItem>
                </>
              )}
              {narrow && (
                <MenuItem
                  id="highlight"
                  onAction={() => editor.chain().focus().toggleHighlight().run()}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                >
                  Highlight
                </MenuItem>
              )}
              {compact && (
                <>
                  <MenuItem
                    id="bullet-list"
                    onAction={() => editor.chain().focus().toggleBulletList().run()}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                  >
                    Bullet list
                  </MenuItem>
                  <MenuItem
                    id="ordered-list"
                    onAction={() => editor.chain().focus().toggleOrderedList().run()}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                  >
                    Numbered list
                  </MenuItem>
                  <MenuItem
                    id="quote"
                    onAction={() => editor.chain().focus().toggleBlockquote().run()}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                  >
                    Quote
                  </MenuItem>
                  <MenuItem
                    id="code-block"
                    onAction={() => editor.chain().focus().toggleCodeBlock().run()}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                  >
                    Code block
                  </MenuItem>
                  <MenuItem
                    id="link"
                    onAction={() => {
                      if (editor.isActive('link')) {
                        editor.chain().focus().unsetLink().run();
                      } else {
                        onRequestLink();
                      }
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                  >
                    Insert link
                  </MenuItem>
                  <MenuItem
                    id="image"
                    onAction={() => imageInputRef.current?.click()}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                  >
                    Insert image
                  </MenuItem>
                </>
              )}
            </Menu>
          </Popover>
        </DialogTrigger>
      )}
```

(Color and font-family have no menu items — they are select/swatches that don't fit a plain menu row; they reappear above 900px. Highlight is a plain toggle, so it gets one.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kylins.client.frontend && npx vitest run tests/components/composer/ && npx tsc --noEmit`
Expected: PASS — 4 new EditorToolbar tests plus all existing composer suites.

- [ ] **Step 5: Run the full frontend suite**

Run: `cd kylins.client.frontend && npx vitest run`
Expected: PASS except the 3 known pre-existing `tests/services/theme/contrast.test.ts` failures — no other regressions (Composer, ribbon, MessageList, TitleBar suites all green).

- [ ] **Step 6: Commit**

```bash
git add kylins.client.frontend/src/components/composer/EditorToolbar.tsx kylins.client.frontend/tests/components/composer/EditorToolbar.test.tsx
git commit -m "feat(frontend): inset single-row editor toolbar with overflow scaling"
```

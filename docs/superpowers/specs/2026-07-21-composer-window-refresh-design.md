# Design: New Message (composer pop-out) window refresh

Date: 2026-07-21
Status: Approved (design)

## Goal

Bring the standalone New Message (composer pop-out) window up to the main
window's visual standard: glass titlebar with a live subject title, an
Outlook-style Send actions row, a close-confirmation dialog, a chrome status
bar, a non-wrapping ribbon with the main window's scaling rules, an inset
single-row editor commands bar, and consistent ribbon icons.

## Scope

**In scope:** the pop-out composer window only (`Composer` with
`windowed = true`, opened via `openComposerWindow` / pop-out).

**Shared components, both surfaces affected:** `ComposeRibbon` and
`EditorToolbar` are rendered by the inline composer too, so the no-wrap /
scaling / inset / icon changes also appear in the inline composer. The inline
composer's own header and footer are unchanged.

**Out of scope:** the compose MenuBar variant (stays unrendered), any menu
bar in the composer window, changes to send/draft logic beyond what the
close-confirmation needs.

## Requirements (agreed with user)

1. Titlebar uses the main window's chrome style; **the window title is the
   subject** — both in the titlebar and in the OS window title (taskbar /
   alt-tab), updated live; falls back to the mode label ("New Message",
   "Reply", "Reply All", "Forward") when the subject is empty.
2. Send actions move **above the recipients, left-aligned** (Outlook-style):
   Send (primary), Discard, Schedule. The old footer's buttons disappear.
3. Closing the window with unsaved content prompts: **Save Draft** /
   **Don't Save** / **Cancel**. An untouched empty compose closes without
   prompting.
4. New status bar in the main window's style: from-account, draft
   saving/saved indicator, send-progress spinner (left); word/character
   count, `SignatureSelector`, `TemplatePicker` (right). The old footer is
   removed.
5. Ribbon and editor commands bar **never wrap**; scaling follows the main
   window's `ReadRibbon` rules (`useElementWidth`: icon-only < 900px,
   "More" overflow menu < 640px).
6. Editor commands bar is **inset with gaps on both sides** (ribbon-style
   card margins), not full-bleed.
7. Every ribbon item has an icon; all ribbon item icons are one size;
   "Link" is removed from the ribbon.

## Architecture

New focused components under
`kylins.client.frontend/src/components/composer/window/` (Composer.tsx is
already ~1200 lines; new UI lives in small units wired in by `Composer`
when `windowed`):

- `ComposerTitleBar.tsx`
- `ComposerActionsRow.tsx`
- `ComposerStatusBar.tsx`
- `CloseConfirmDialog.tsx`

Modified existing files:

- `components/composer/Composer.tsx` — wire the four components in windowed
  mode; remove the old footer; add close interception and live window title.
- `components/layout/ribbon/ComposeRibbon.tsx` — scaling rules, icons,
  remove Link.
- `components/layout/ribbon/RibbonShell.tsx` — single-row shell (shared
  with the main window; see below).
- `components/composer/EditorToolbar.tsx` — inset card + single row +
  scaling/overflow.

### Titlebar — `ComposerTitleBar.tsx`

Mirrors `components/layout/TitleBar.tsx` chrome:

- Container: `h-[var(--header-h)]`, `glass bg-gradient-to-b
  from-[var(--chrome-glass-start)] to-[var(--chrome-glass-end)]`,
  `shadow-[var(--glass-shadow),var(--chrome-highlight)]`, drag region
  (`WebkitAppRegion: 'drag'`), iris hairline
  (`<span className="pointer-events-none absolute inset-x-0 bottom-0 h-px
  iris-line opacity-70" />`).
- Left/center: drag regions with double-click → `toggleMaximize` (same
  pattern as the main TitleBar, including its jsdom-safe try/catch).
- Title text: `subject.trim() || modeLabel`, truncated.
- Right: existing `WindowControls` (from `ui/WindowTitleBar.tsx`) in a
  `no-drag` wrapper, pinned right.

Live OS title: a `useEffect` in `Composer` (windowed only) calls
`getCurrentWindow().setTitle(subject.trim() || modeLabel)` on subject
change, guarded by try/catch for non-Tauri contexts.

### Actions row — `ComposerActionsRow.tsx`

A left-aligned row rendered between the titlebar and the address block
(`px-3 py-1.5`, `border-b border-[var(--border-subtle)]`):

- **Send** — the existing primary-button styling and disabled logic
  (`to.length === 0 || sendProgressActive`), calls the same
  `handleSendAndCloseWindow` the footer used.
- **Discard** — the existing secondary styling, calls `handleDiscard`.
- **Schedule** — secondary button with `ClockIcon`, dispatches
  `composer:schedule-requested` (the existing listener opens
  `ScheduleSendDialog`).

Props: callbacks + disabled state passed from `Composer` (no store
subscriptions inside, so it stays trivially testable).

### Close confirmation — `CloseConfirmDialog.tsx` + interception

- In `Composer` (windowed only), register
  `getCurrentWindow().onCloseRequested` once: `event.preventDefault()`,
  then if the draft is "untouched-empty" close immediately, else open the
  dialog. The titlebar X and OS close both route through this.
- "Untouched-empty": no recipients, empty subject, and the editor body is
  empty (`editor?.getText().trim() === ''`).
- Dialog (small centered modal, same `bg-[var(--surface-floating)]` card
  style as other dialogs): message "Save this draft?" + buttons:
  - **Save Draft** → flush a draft save, then close the window.
  - **Don't Save** → existing `handleDiscard` (deletes draft, cleans
    staged attachments, closes).
  - **Cancel** → close the dialog only.
- Draft flush: `services/composer/draftAutoSave.ts` already contains
  `saveDraftNow()` (builds the `DraftInput` from composer state, skips
  empty drafts, sets `isSaving`/`lastSavedAt`). Export it (e.g. as
  `flushDraftSave`) and call it from **Save Draft**, then
  `stopAutoSave()` and close the window.

### Status bar — `ComposerStatusBar.tsx`

Mirrors `components/layout/StatusBar.tsx` chrome: `h-[var(--status-h)]`,
`bg-[var(--chrome)]`, `border-t border-[var(--border-subtle)]`, `text-xs
text-[var(--muted-text)]`, `px-3`.

- Left: from-account email (`fromEmail ?? activeAccount?.email`), draft
  indicator ("Saving…" pulsing / "Draft saved" — moved verbatim from the
  old footer), send-progress spinner + message (reads
  `useUIStore((s) => s.sendProgress)`, same as `SendProgressIndicator`).
- Right: word/character count ("{n} words · {m} characters"),
  `SignatureSelector`, `TemplatePicker` (relocated unchanged from the old
  footer).

Word/character count: `Composer` already syncs editor content in
`onUpdate`; it stores `bodyText` stats derived from
`editor.state.doc.textContent` (words = `text.split(/\s+/).filter(Boolean)
.length`, characters = `text.length`) into a small local state passed to
the status bar, so the status bar needs no TipTap dependency.

### Composer layout (windowed)

The windowed column becomes, top to bottom: `ComposerTitleBar` →
`ComposerActionsRow` → `CommandRibbon` (unchanged position) → address
block → subject row → `EditorToolbar` → editor → attachments →
`ComposerStatusBar`. The old header branch (`WindowTitleBar`) and the old
footer block are deleted; the `composer-panel` wrapper keeps its existing
full-window (`h-full w-full`, no border/shadow) windowed styling.

### Ribbon — `ComposeRibbon.tsx` + `RibbonShell.tsx`

No-wrap + main-window scaling:

- `RibbonShell`'s inner row: `flex-wrap` → `flex-nowrap` with
  `overflow-hidden` (shared with the main window's `ReadRibbon`, which
  already scales via overflow instead of wrapping — visual no-op there).
- `ComposeRibbon` adopts `ReadRibbon`'s pattern exactly:
  `useElementWidth` on the shell; `iconOnly = width < 900`
  (labels hidden, icons only); `compact = width < 640` (secondary groups
  — Importance, Tracking, Security toggles — collapse into a "More"
  overflow menu via the same `DialogTrigger` + `Popover` pattern;
  Delay Delivery and Attach stay visible).
- **Icons**: every ribbon item has one. New: `WarningIcon` on the
  Importance trigger, `BellIcon` on the Tracking trigger (both rendered
  via `RibbonButton`'s icon slot so caret + label layout is unchanged).
  All ribbon item icons are **17px**: the three `RibbonToggle` icons
  (Lock/ShieldCheck/CopySlash) go 14→17. Icons inside dropdown popover
  menus stay 14px (menu rows, not ribbon items).
- **Link removed**: the Attach/Link group keeps only Attach. Insert-link
  remains in the editor toolbar and on Ctrl+K.

### Editor commands bar — `EditorToolbar.tsx`

- **Inset card**: the outer full-bleed bar is replaced by a ribbon-style
  inset container: `mx-1 md:mx-2 mt-1 rounded-xl border
  border-[var(--border)] bg-[var(--card)] px-2 py-1
  shadow-[var(--ribbon-elevation)]` — same outer margins as `RibbonShell`
  so the two bars align, with visible gaps on both sides.
- **Single row + scaling**: `flex-nowrap overflow-hidden` with
  `useElementWidth`; buttons are already icon-only, so scaling hides
  groups by priority:
  - < 900px: font-family select and text color/highlight collapse.
  - < 640px: headings (H1–H3), lists, image and link buttons move into a
    "More" overflow menu (same `DialogTrigger` + `Popover` pattern).
  - Undo/redo, bold, italic, underline, strikethrough stay visible at all
    widths.

## Data flow

```
composerStore (subject, to, isSaving, lastSavedAt, sendProgress via uiStore)
  → Composer (windowed)
      → ComposerTitleBar (title = subject || modeLabel; OS setTitle effect)
      → ComposerActionsRow (Send/Discard/Schedule → existing handlers)
      → ComposerStatusBar (account, draft label, send progress, word stats)
onCloseRequested → untouched-empty ? close : CloseConfirmDialog
      → Save Draft (flush, close) | Don't Save (handleDiscard) | Cancel
useElementWidth → ComposeRibbon / EditorToolbar scaling (iconOnly, compact)
```

## Error handling

- All Tauri calls (`setTitle`, `onCloseRequested`, `toggleMaximize`,
  `WindowControls`) keep the existing try/catch guards so the component
  renders in jsdom and non-Tauri contexts.
- Save-Draft failure: push an error toast (existing `useToastStore`
  pattern) and keep the window open.
- Overflow menus render the same actions with the same disabled logic as
  the inline buttons — no behavior forks.

## Testing

Tests mirror `src/` under `kylins.client.frontend/tests/`, mocking Tauri
APIs (`@tauri-apps/api/core`, `@tauri-apps/api/window`) as existing window
tests do.

- `tests/components/composer/window/ComposerTitleBar.test.tsx`: renders
  subject as title; falls back to mode label when subject empty; calls
  `setTitle` with the subject on change.
- `tests/components/composer/window/CloseConfirmDialog.test.tsx`: three
  actions invoke save/discard/cancel callbacks.
- `tests/components/composer/window/ComposerStatusBar.test.tsx`: draft
  indicator states, send-progress visibility, word/character count render.
- `tests/components/composer/window/ComposerActionsRow.test.tsx`: Send
  disabled with no recipients; three buttons invoke their callbacks.
- Existing `Composer` tests: windowed render shows titlebar/actions
  row/status bar and NOT the old footer; empty compose close does not
  prompt (intercept handler closes directly).
- Existing ribbon/toolbar tests updated: ComposeRibbon renders no "Link"
  button; Importance and Tracking triggers expose icons; overflow "More"
  menu appears when the shell is narrow (mock `useElementWidth`).

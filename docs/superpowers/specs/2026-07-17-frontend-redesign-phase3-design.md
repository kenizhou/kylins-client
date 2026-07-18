# Frontend Redesign Phase 3 — Composer, Preferences & Polish Design

**Date:** 2026-07-17  
**Status:** Approved — ready for implementation plan  
**Scope:** `kylins.client.frontend` Composer simplification, Preferences cleanup, Appearance enhancements, CSS scrollbar replacement, and focused accessibility polish.  
**Base:** Builds on Phase 1 (theme/layout skeleton) and Phase 2 (message list, reading pane, ribbon).

---

## 1. Goal

Complete the remaining high-impact UI/UX polish identified in the [frontend redesign spec](./2026-07-17-frontend-redesign-design.md) without expanding into Phase 4 scope (tags, unified folders, AI features, plugin themes).

Phase 3 keeps changes localized to React components, CSS, and Zustand state. No backend RPC changes are required.

---

## 2. Non-Goals

- No new tag/categorization system.
- No unified folders across accounts.
- No new AI model integration.
- No external CDN dependencies; fonts remain offline/system fallbacks.
- No schema or migration changes.

---

## 3. Task Overview

| # | Task | Files | Outcome |
|---|---|---|---|
| 1 | Composer simplification | `Composer.tsx`, `composerActions.ts`, tests | Default view shows To/Subject/Body; Cc/Bcc/Reply-To collapsed; unified reply/forward entry; inline attachment chips. |
| 2 | Preferences cleanup | `PreferencesDialog.tsx`, related tabs, tests | Remove or re-label "coming soon" tabs; reorganize into 7 stable tabs. |
| 3 | Appearance enhancements | `AppearancePreferences.tsx`, `themeManager.ts`, `uiStore.ts`, `theme.css`, tests | Add serif-subjects toggle, font-size selector, high-contrast toggle; persist and apply. |
| 4 | CSS scrollbar replacement | `useAutoHideScrollbar.ts`, `globals.css`, tests | Replace JS scroll listener with CSS `scrollbar-color` / `scrollbar-gutter`. |
| 5 | Accessibility polish | `AppShell.tsx`, layout components, tests | Verify focus rings, aria-labels, reduced-motion support; add focused tests. |

---

## 4. Task 1 — Composer Simplification

### 4.1 Default View

On first open the composer shows only:

- **To** field (with contact autocomplete)
- **Subject** field
- **Body** editor (TipTap)
- **Send** button

### 4.2 Collapsed Headers

A "Cc" button next to the To field toggles visibility of:

- Cc
- Bcc
- Reply-To

State is held locally in `Composer.tsx` via `showCcBcc`. When any of the collapsed fields has a value, the section automatically expands.

### 4.3 Unified Reply/Forward Entry

All reply/forward paths (ReadRibbon, MessageHeader, context menu, viewer window, shortcuts) route through existing `composerActions.ts` helpers:

- `openReplyComposer`
- `openReplyAllComposer`
- `openForwardComposer`
- `openReplyComposerWithAttachments`
- `openReplyAllComposerWithAttachments`
- `openForwardComposerAsAttachment`

No behavior changes; only verify callers are consistent and add a test that all paths populate the same composer state.

### 4.4 Inline Attachment Chips

Attachments render as horizontal chips below the subject line when collapsed headers are hidden, and below the header block when expanded. Each chip shows filename and size with a remove button.

### 4.5 Tests

- `Composer.test.tsx`: default view hides Cc/Bcc; clicking "Cc" reveals them; entering a Cc value auto-expands.
- `composerActions.test.tsx`: reply/forward helpers set the same composer state regardless of caller.

---

## 5. Task 2 — Preferences Cleanup

### 5.1 Tab Reorganization

Reduce PreferencesDialog to these tabs in order:

1. **General** — language, default reply behavior, notifications
2. **Accounts** — existing account management
3. **Appearance** — theme, skin, density, font size, serif subjects, high contrast, reduced motion
4. **Mail** — reading pane position, conversation view, sync, signatures
5. **Calendar & Contacts** — existing calendar/contact settings
6. **Shortcuts** — keyboard shortcut editor
7. **About** — version, updates, attributions

### 5.2 Remove "Coming Soon"

Any tab or section currently labeled "coming soon" is either:

- Removed if it has no implemented content, OR
- Re-labeled as "Experimental" with a one-sentence description of current limitations.

### 5.3 Tests

- `PreferencesDialog.test.tsx`: only the 7 tabs above are rendered; no "coming soon" text appears.

---

## 6. Task 3 — Appearance Enhancements

### 6.1 New Settings

Add to `uiStore.ts` and persist via existing settings service:

| Setting | Type | Default | Applied via |
|---|---|---|---|
| `serifSubjects` | `boolean` | `false` | `.serif-subjects` class on document or relevant elements |
| `fontSize` | `'small' \| 'default' \| 'large'` | `'default'` | `data-font-size` attribute on document root |
| `contrast` | `'default' \| 'high'` | `'default'` | `data-contrast` attribute on document root |
| `reduceMotion` | `boolean` | `false` | `prefers-reduced-motion` media query OR `data-reduce-motion` |

### 6.2 Theme Manager Updates

`themeManager.ts` exposes:

- `setContrast(mode)` — already partially present; finalize and wire to UI store.
- `setFontSize(size)` — new; sets `data-font-size`.
- `setSerifSubjects(enabled)` — new; toggles class.
- `setReduceMotion(enabled)` — new; toggles `data-reduce-motion`.

### 6.3 CSS Updates

In `theme.css` / `globals.css`:

- `[data-font-size="small"]`: base `--text-base` 13px.
- `[data-font-size="default"]`: base 14px.
- `[data-font-size="large"]`: base 16px.
- `.serif-subjects .reading-pane-subject, .serif-subjects .message-list-subject`: use `Source Serif 4` stack.
- `[data-reduce-motion="true"]`: disable transitions on pane widths and theme color changes.

### 6.4 Tests

- `themeManager.test.ts`: contrast, font size, serif subjects, reduce motion all apply correct DOM attributes/classes.
- `AppearancePreferences.test.tsx`: toggles update UI state and call theme manager.

---

## 7. Task 4 — CSS Scrollbar Replacement

### 7.1 Current Behavior

`useAutoHideScrollbar` currently listens to scroll events and toggles classes to hide/show scrollbars. This adds JS overhead and can cause jank.

### 7.2 New Behavior

Use CSS-only approach:

```css
.scrollbar-stable {
  scrollbar-gutter: stable;
}

.scrollbar-thin {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

.scrollbar-thin:hover {
  scrollbar-color: var(--muted-foreground) transparent;
}
```

Update `useAutoHideScrollbar` to return a stable class string instead of managing scroll listeners. Keep the hook API so existing consumers don't need to change.

### 7.3 Tests

- `useAutoHideScrollbar.test.ts`: hook returns expected class names; no scroll listeners are attached.

---

## 8. Task 5 — Accessibility Polish

### 8.1 Focus Rings

Verify all interactive elements in touched components have visible focus rings using `--ring`:

- Composer fields and buttons
- Preferences tabs and controls
- Appearance toggle buttons

### 8.2 ARIA Labels

Ensure every icon-only button has an `aria-label`:

- Composer toolbar buttons
- Preferences close/reset buttons
- Appearance preview swatches

### 8.3 Reduced Motion

Respect `data-reduce-motion` and `prefers-reduced-motion` for:

- Pane resize transitions
- Theme color transitions
- Composer appear animation

### 8.4 Tests

- Add a focused a11y test for `PreferencesDialog` and `Composer` verifying labels and roles.

---

## 9. Acceptance Criteria

- `npx vitest run` passes with new tests.
- `npx tsc --noEmit` passes.
- `npm run lint` passes with no new errors (pre-existing warnings allowed).
- `npm run format:check` passes.
- Composer default view hides Cc/Bcc.
- Preferences shows exactly 7 tabs and no "coming soon" text.
- Appearance toggles apply DOM attributes and persist across reload (via settings service).
- Scrollbars no longer rely on JS scroll listeners.

---

## 10. Related Documents

- [Frontend Redesign Master Spec](./2026-07-17-frontend-redesign-design.md)
- [Phase 1 Implementation Plan](../plans/2026-07-17-frontend-redesign-phase1.md)
- [Phase 2 Implementation Plan](../plans/2026-07-17-frontend-redesign-phase2.md)

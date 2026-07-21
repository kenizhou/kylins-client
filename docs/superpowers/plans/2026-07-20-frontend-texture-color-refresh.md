# Frontend Texture & Color Harmony Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every page and component of Kylins Mail feel more textured, color-harmonious, and premium using a Fluent Acrylic visual language, while keeping the existing layout and functionality intact.

**Architecture:** Extend the existing CSS-variable theming in `theme.css`/`globals.css` with new surface/elevation/accent tokens and utility classes. Apply the tokens progressively to chrome bars, mail surfaces, and secondary pages. No backend changes.

**Tech Stack:** Tauri v2, React 19, TypeScript 5.9, Tailwind CSS v4, `react-aria-components`, Hugeicons, Vitest 4 + jsdom.

**Depends on:**
- Design spec: `docs/superpowers/specs/2026-07-20-frontend-texture-color-refresh-design.md`
- Existing redesign plans: `docs/superpowers/plans/2026-07-17-frontend-redesign-phase{1,2,3}.md`

## Global Constraints

- Run all frontend commands from `kylins.client.frontend/`.
- TypeScript `strict` + `noUnusedLocals` + `noUncheckedIndexedAccess` must pass: `npx tsc --noEmit`.
- Vitest must pass: `npx vitest run`.
- ESLint must pass: `npm run lint` (pre-existing warnings allowed).
- Prettier must pass: `npm run format:check`.
- No new `any` or `@ts-ignore`.
- Theme changes must work fully offline (no CDN fonts required).
- All interactive elements keep accessible labels and visible focus rings.
- High-contrast mode must disable translucency/blur and use solid surfaces + strong borders.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/styles/theme.css` | Source of truth for all color/elevation/radius/motion tokens. |
| `src/styles/globals.css` | Tailwind v4 `@theme inline` mapping + `@utility` surface/glass classes. |
| `src/styles/skins.css` | Per-skin accent overrides; must flow into new subtle/muted tokens. |
| `src/styles/themes.ts` | Skin registry; may need new skin variants for richer palettes. |
| `src/components/layout/TitleBar.tsx` | Top acrylic bar. |
| `src/components/layout/ToolWindowBar.tsx` | Left acrylic activity bar. |
| `src/components/layout/StatusBar.tsx` | Bottom acrylic status bar. |
| `src/components/layout/AppShell.tsx` | Root layout; may adjust background to let glass show depth. |
| `src/components/layout/FolderPane.tsx` | Folder pane surface + selected/hover states. |
| `src/components/layout/MessageList.tsx` | Message list rows + quick actions + state styling. |
| `src/components/layout/ReadingPane.tsx` | Reading pane card + header + body area. |
| `src/components/layout/CommandRibbon.tsx` / `ribbon/*` | Ribbon surface + button groups. |
| `src/components/calendar/*` | Calendar surfaces. |
| `src/components/contacts/*` | Contacts surfaces. |
| `src/components/tasks/*` | Tasks surfaces. |
| `src/components/composer/*` | Composer surfaces. |
| `src/components/preferences/*` | Preferences surfaces. |
| `src/components/ui/*.tsx` | Shared primitives (buttons, inputs, cards, dialogs, badges). |
| `tests/styles/themeTokens.test.ts` | Verifies required tokens exist and files stay aligned. |

---

# Task 1: Add Surface & Depth Tokens

**Goal:** Introduce Fluent Acrylic surface, elevation, accent-subtle, and motion tokens into the theme system.

**Files:**
- Modify: `src/styles/theme.css`

**Interfaces:**
- Consumes: existing `--background`, `--foreground`, `--card`, `--chrome`, `--primary`, `--border`, `--series-950`.
- Produces: `--surface-elevated`, `--surface-floating`, `--chrome-tint`, `--primary-subtle`, `--primary-muted`, `--primary-subtle-solid`, `--primary-muted-solid`, `--border-subtle`, `--shadow-sm`, `--shadow`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`, `--duration-instant`, `--duration-fast`, `--duration-normal`, `--duration-slow`, `--ease-out`, `--ease-spring`.

- [ ] **Step 1: Add new semantic tokens to `:root` in `theme.css`**

Add after the existing `--chrome` block (around line 117):

```css
  /* Surface depth tokens — Fluent Acrylic layered surfaces */
  --surface-elevated: color-mix(in srgb, var(--background) 96%, var(--foreground));
  --surface-floating: var(--card);
  --chrome-tint: color-mix(in srgb, var(--primary) 8%, var(--chrome));

  /* Accent subtlety tokens */
  --primary-subtle: color-mix(in srgb, var(--primary) 8%, transparent);
  --primary-muted: color-mix(in srgb, var(--primary) 15%, transparent);
  --primary-subtle-solid: color-mix(in srgb, var(--primary) 8%, var(--background));
  --primary-muted-solid: color-mix(in srgb, var(--primary) 15%, var(--background));

  /* Border tokens */
  --border-subtle: color-mix(in srgb, var(--border) 60%, transparent);

  /* Elevation shadows */
  --shadow-sm: 0 1px 2px 0 color-mix(in srgb, var(--series-950) 4%, transparent);
  --shadow: 0 1px 3px 0 color-mix(in srgb, var(--series-950) 6%, transparent),
    0 1px 2px -1px color-mix(in srgb, var(--series-950) 6%, transparent);
  --shadow-md: 0 4px 6px -1px color-mix(in srgb, var(--series-950) 8%, transparent),
    0 2px 4px -2px color-mix(in srgb, var(--series-950) 8%, transparent);
  --shadow-lg: 0 10px 15px -3px color-mix(in srgb, var(--series-950) 10%, transparent),
    0 4px 6px -4px color-mix(in srgb, var(--series-950) 10%, transparent);
  --shadow-xl: 0 20px 25px -5px color-mix(in srgb, var(--series-950) 12%, transparent),
    0 8px 10px -6px color-mix(in srgb, var(--series-950) 12%, transparent);

  /* Motion tokens */
  --duration-instant: 0ms;
  --duration-fast: 120ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
```

- [ ] **Step 2: Add dark-mode overrides in `.dark`**

Add the same set of tokens inside `.dark`, adjusted for dark surfaces:

```css
  --surface-elevated: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --surface-floating: var(--card);
  --chrome-tint: color-mix(in srgb, var(--primary) 10%, var(--chrome));
  --primary-subtle: color-mix(in srgb, var(--primary) 10%, transparent);
  --primary-muted: color-mix(in srgb, var(--primary) 18%, transparent);
  --primary-subtle-solid: color-mix(in srgb, var(--primary) 10%, var(--background));
  --primary-muted-solid: color-mix(in srgb, var(--primary) 18%, var(--background));
  --border-subtle: color-mix(in srgb, var(--border) 50%, transparent);
  /* shadows use black with slightly higher opacity in dark mode */
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.2);
  --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.25), 0 1px 2px -1px rgb(0 0 0 / 0.25);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.3), 0 2px 4px -2px rgb(0 0 0 / 0.3);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.35), 0 4px 6px -4px rgb(0 0 0 / 0.35);
  --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.4), 0 8px 10px -6px rgb(0 0 0 / 0.4);
```

- [ ] **Step 3: Add high-contrast overrides**

In both `[data-contrast='high']` and `[data-contrast='high'].dark`, add:

```css
  --surface-elevated: var(--surface);
  --surface-floating: var(--card);
  --chrome-tint: var(--chrome);
  --primary-subtle: var(--selected);
  --primary-muted: var(--selected);
  --primary-subtle-solid: var(--selected);
  --primary-muted-solid: var(--selected);
  --border-subtle: var(--border);
  --shadow-sm: none;
  --shadow: none;
  --shadow-md: none;
  --shadow-lg: none;
  --shadow-xl: none;
```

- [ ] **Step 4: Self-review**

Check that every new token has a dark-mode counterpart and a high-contrast fallback.

- [ ] **Step 5: Verification**

Run:

```bash
cd kylins.client.frontend
npx tsc --noEmit
npm run lint
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
git add src/styles/theme.css
git commit -m "feat(frontend): add Fluent Acrylic surface and depth tokens"
```

---

# Task 2: Expose Tokens in Tailwind v4

**Goal:** Map the new tokens into Tailwind v4 `@theme inline` and create reusable `@utility` classes.

**Files:**
- Modify: `src/styles/globals.css`

**Interfaces:**
- Consumes: all tokens produced by Task 1.
- Produces: Tailwind color classes (`surface-elevated`, `surface-floating`, `chrome-tint`, `primary-subtle`, `primary-muted`, `border-subtle`), shadow classes, radius classes, and transition utilities.

- [ ] **Step 1: Extend `@theme inline` in `globals.css`**

Add color/theme entries after the existing `--color-chrome-foreground` line:

```css
  --color-surface-elevated: var(--surface-elevated);
  --color-surface-floating: var(--surface-floating);
  --color-chrome-tint: var(--chrome-tint);
  --color-primary-subtle: var(--primary-subtle);
  --color-primary-muted: var(--primary-muted);
  --color-border-subtle: var(--border-subtle);

  --shadow-sm: var(--shadow-sm);
  --shadow: var(--shadow);
  --shadow-md: var(--shadow-md);
  --shadow-lg: var(--shadow-lg);
  --shadow-xl: var(--shadow-xl);

  --radius-xs: 2px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --radius-xl: 14px;
  --radius-2xl: 18px;

  --duration-instant: 0ms;
  --duration-fast: 120ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
```

- [ ] **Step 2: Add `@utility` surface classes in `globals.css`**

Add after the existing `@utility glass` block:

```css
@utility surface {
  background-color: var(--surface);
}

@utility surface-elevated {
  background-color: var(--surface-elevated);
}

@utility surface-floating {
  background-color: var(--surface-floating);
}

@utility chrome-tint {
  background-color: var(--chrome-tint);
}

@utility primary-subtle {
  background-color: var(--primary-subtle);
}

@utility primary-muted {
  background-color: var(--primary-muted);
}

@utility border-subtle {
  border-color: var(--border-subtle);
}

@utility shadow-elevation-sm {
  box-shadow: var(--shadow-sm);
}

@utility shadow-elevation {
  box-shadow: var(--shadow);
}

@utility shadow-elevation-md {
  box-shadow: var(--shadow-md);
}

@utility shadow-elevation-lg {
  box-shadow: var(--shadow-lg);
}

@utility shadow-elevation-xl {
  box-shadow: var(--shadow-xl);
}

@utility transition-fast {
  transition-duration: var(--duration-fast);
  transition-timing-function: var(--ease-out);
}

@utility transition-normal {
  transition-duration: var(--duration-normal);
  transition-timing-function: var(--ease-out);
}
```

- [ ] **Step 3: Verification**

Run:

```bash
cd kylins.client.frontend
npx tsc --noEmit
npm run lint
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
git add src/styles/globals.css
git commit -m "feat(frontend): expose acrylic tokens as Tailwind utilities"
```

---

# Task 3: Verify Tokens with Tests

**Goal:** Add test assertions for the new tokens so future regressions are caught.

**Files:**
- Modify: `tests/styles/themeTokens.test.ts`

**Interfaces:**
- Consumes: `src/styles/theme.css` (read from disk).
- Produces: passing test assertions.

- [ ] **Step 1: Update `tests/styles/themeTokens.test.ts`**

Add assertions for the new tokens:

```ts
  it('declares acrylic surface tokens', () => {
    const acrylicTokens = [
      '--surface-elevated',
      '--surface-floating',
      '--chrome-tint',
      '--primary-subtle',
      '--primary-muted',
      '--border-subtle',
    ];
    for (const token of acrylicTokens) {
      expect(themeCss).toContain(`${token}:`);
    }
  });

  it('declares elevation shadow tokens', () => {
    const shadowTokens = ['--shadow-sm', '--shadow', '--shadow-md', '--shadow-lg', '--shadow-xl'];
    for (const token of shadowTokens) {
      expect(themeCss).toContain(`${token}:`);
    }
  });

  it('declares motion tokens', () => {
    const motionTokens = [
      '--duration-instant',
      '--duration-fast',
      '--duration-normal',
      '--duration-slow',
      '--ease-out',
      '--ease-spring',
    ];
    for (const token of motionTokens) {
      expect(themeCss).toContain(`${token}:`);
    }
  });
```

- [ ] **Step 2: Run tests**

```bash
cd kylins.client.frontend
npx vitest run tests/styles/themeTokens.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
git add tests/styles/themeTokens.test.ts
git commit -m "test(frontend): assert new acrylic tokens exist"
```

---

# Task 4: Strengthen Glass Tokens

**Goal:** Make the chrome bar acrylic effect stronger and more visible.

**Files:**
- Modify: `src/styles/theme.css`

**Interfaces:**
- Consumes: existing `--chrome`, `--foreground`, `--series-950`.
- Produces: updated `--chrome-glass`, `--chrome-glass-start`, `--chrome-glass-end`, `--glass-border`, `--glass-shadow`.

- [ ] **Step 1: Update glass tokens in `theme.css`**

Replace the existing glass token block in `:root` with:

```css
  /* Glassmorphism chrome surfaces — stronger acrylic with top-light sheen */
  --chrome-glass: color-mix(in srgb, var(--chrome) 60%, transparent);
  --chrome-glass-start: color-mix(in srgb, #ffffff 12%, color-mix(in srgb, var(--chrome) 70%, transparent));
  --chrome-glass-end: color-mix(in srgb, var(--chrome) 50%, transparent);
  --glass-border: color-mix(in srgb, var(--foreground) 3%, transparent);
  --glass-shadow: 0 8px 32px -6px color-mix(in srgb, var(--series-950) 16%, transparent);
```

And in `.dark`:

```css
  --chrome-glass: color-mix(in srgb, var(--chrome) 55%, transparent);
  --chrome-glass-start: color-mix(in srgb, #ffffff 8%, color-mix(in srgb, var(--chrome) 65%, transparent));
  --chrome-glass-end: color-mix(in srgb, var(--chrome) 45%, transparent);
  --glass-border: color-mix(in srgb, var(--foreground) 4%, transparent);
  --glass-shadow: 0 8px 32px -6px color-mix(in srgb, #000000 35%, transparent);
```

- [ ] **Step 2: Verification**

Run:

```bash
cd kylins.client.frontend
npx tsc --noEmit
npm run lint
npx vitest run tests/styles/themeTokens.test.ts
```

- [ ] **Step 3: Commit**

```bash
cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
git add src/styles/theme.css
git commit -m "feat(frontend): strengthen chrome glass tokens"
```

---

# Task 5: Strengthen Glass Utility

**Goal:** Increase the blur and saturation of the `.glass` utility class.

**Files:**
- Modify: `src/styles/globals.css`

**Interfaces:**
- Consumes: `--chrome-glass`.
- Produces: updated `.glass` utility.

- [ ] **Step 1: Update `.glass` utility in `globals.css`**

```css
@utility glass {
  background-color: var(--chrome-glass);
  backdrop-filter: blur(20px) saturate(200%);
  -webkit-backdrop-filter: blur(20px) saturate(200%);
}
```

- [ ] **Step 2: Verification**

Run:

```bash
cd kylins.client.frontend
npx tsc --noEmit
npm run lint
```

- [ ] **Step 3: Commit**

```bash
cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
git add src/styles/globals.css
git commit -m "feat(frontend): increase glass blur and saturation"
```

---

# Task 6: Apply Acrylic to Chrome Bars

**Goal:** Update TitleBar, ToolWindowBar, and StatusBar to use the stronger acrylic styling without split borders.

**Files:**
- Modify: `src/components/layout/TitleBar.tsx`
- Modify: `src/components/layout/ToolWindowBar.tsx`
- Modify: `src/components/layout/StatusBar.tsx`

**Interfaces:**
- Consumes: `.glass` utility, `--chrome-glass-start`, `--chrome-glass-end`, `--glass-shadow`.
- Produces: updated chrome bar components.

- [ ] **Step 1: Update `TitleBar.tsx`**

Change root className to:

```tsx
className="relative h-[var(--header-h)] flex items-center pl-2 pr-[148px] glass bg-gradient-to-b from-[var(--chrome-glass-start)] to-[var(--chrome-glass-end)] shadow-[var(--glass-shadow)] select-none"
```

- [ ] **Step 2: Update `ToolWindowBar.tsx`**

Change root className to:

```tsx
className="flex w-[var(--tool-w)] shrink-0 flex-col items-center justify-between glass bg-gradient-to-r from-[var(--chrome-glass-start)] to-[var(--chrome-glass-end)] py-2"
```

- [ ] **Step 3: Update `StatusBar.tsx`**

Change footer className to:

```tsx
className="h-[var(--status-h)] flex items-center justify-between px-3 text-xs glass bg-gradient-to-t from-[var(--chrome-glass-start)] to-[var(--chrome-glass-end)] shadow-[var(--glass-shadow)] text-[var(--muted-text)] shrink-0"
```

- [ ] **Step 4: Verification**

Run:

```bash
cd kylins.client.frontend
npm run format
npx tsc --noEmit
npm run lint
npx vitest run tests/components/layout/TitleBar.test.tsx tests/components/layout/StatusBar.test.tsx tests/components/layout/ResizablePaneGroup.test.tsx tests/styles/themeTokens.test.ts
```

Expected: tests pass, no new lint/type errors.

- [ ] **Step 5: Commit**

```bash
cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
git add src/components/layout/TitleBar.tsx src/components/layout/ToolWindowBar.tsx src/components/layout/StatusBar.tsx
git commit -m "feat(frontend): apply stronger acrylic to chrome bars"
```

---

# Task 7: Adjust Root Background for Depth

**Goal:** Make the area behind the chrome bars subtly tinted so the acrylic translucency is visible.

**Files:**
- Modify: `src/components/layout/AppShell.tsx`

**Interfaces:**
- Consumes: `--chrome-tint`.
- Produces: updated root background.

- [ ] **Step 1: Update `AppShell.tsx` root background**

Change root className from `bg-[var(--chrome)]` to:

```tsx
className="relative flex flex-col h-screen w-screen overflow-hidden bg-[var(--chrome-tint)] text-[var(--foreground)]"
```

- [ ] **Step 2: Verification**

Run:

```bash
cd kylins.client.frontend
npm run format
npx tsc --noEmit
npm run lint
npx vitest run tests/components/layout/TitleBar.test.tsx tests/components/layout/StatusBar.test.tsx tests/components/layout/ResizablePaneGroup.test.tsx tests/styles/themeTokens.test.ts
```

- [ ] **Step 3: Commit and push Phase 2**

```bash
cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
git add src/components/layout/AppShell.tsx
git commit -m "feat(frontend): use chrome-tint as root background for acrylic depth"
git push origin feat/redesign-frontend-02
```

---

## Phase 3-5 Outline (Future Work)

### Phase 3: Mail Surfaces

Apply Fluent Acrylic surfaces to:
- `src/components/layout/FolderPane.tsx`
- `src/components/layout/MessageList.tsx`
- `src/components/layout/ReadingPane.tsx`
- `src/components/layout/CommandRibbon.tsx` and `ribbon/*`

### Phase 4: Secondary Pages

Apply Fluent Acrylic surfaces to calendar, contacts, tasks, composer, preferences, account-setup, and shared UI primitives. Detailed tasks follow.

### Phase 5: Motion Polish

Add consistent micro-interactions and reduced-motion support.

---

# Task 12: Apply Acrylic Surfaces to Calendar

**Goal:** Bring the calendar page into the Fluent Acrylic elevation system: level-1 surface for the page shell, level-2 floating surfaces for modals/menus, primary-subtle/muted for interactive states, and consistent borders/shadows across all views.

**Files:**
- Modify: `src/components/calendar/CalendarPage.tsx`
- Modify: `src/components/calendar/CalendarToolbar.tsx`
- Modify: `src/components/calendar/CalendarPane.tsx`
- Modify: `src/components/calendar/MonthView.tsx`
- Modify: `src/components/calendar/WeekView.tsx`
- Modify: `src/components/calendar/DayView.tsx`
- Modify: `src/components/calendar/AgendaView.tsx`
- Modify: `src/components/calendar/EventCreateModal.tsx`
- Modify: `src/components/calendar/EventCard.tsx`

**Interfaces:**
- Consumes: `--surface`, `--surface-elevated`, `--surface-floating`, `--border-subtle`, `--border`, `--primary-subtle`, `--primary-muted`, `--primary`, `--primary-fg`, `--muted-text`, `--text`, `--foreground`, `--background`, `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`, `--ring`.
- Produces: updated calendar surfaces.

- [ ] **Step 1: Page shell (`CalendarPage.tsx`)**

  Change the root card from `bg-[var(--card)]` / `border-[var(--border)]` to a level-1 surface:
  ```tsx
  className="flex flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-surface"
  ```
  Keep the error bar destructive styling. Change the empty-state icon circle from `bg-[var(--surface)]` to `bg-surface-elevated`.

- [ ] **Step 2: Toolbar (`CalendarToolbar.tsx`)**

  Update the toolbar root to use `border-b-[var(--border-subtle)]` and keep `bg-surface`.
  Replace all `hover:bg-hover` with `hover:bg-[var(--primary-subtle)]`.
  Replace `border-border` on button groups with `border-[var(--border-subtle)]`.
  Keep primary "New event" button unchanged.

- [ ] **Step 3: Calendar pane / color picker (`CalendarPane.tsx`)**

  Update internal surfaces: `bg-[var(--background)]` panels become `bg-surface-elevated`; `bg-[var(--secondary)]` becomes `bg-surface-elevated`.
  Replace `hover:bg-[var(--hover)]` with `hover:bg-[var(--primary-subtle)]` and `hover:text-[var(--primary)]`.
  Replace `border-[var(--border)]` with `border-[var(--border-subtle)]` for dividers; keep `border-2 border-[var(--foreground)]` for selected-color ring.
  The preset hex palette is intentional (calendar category colors); leave it.

- [ ] **Step 4: Month / Week / Day / Agenda views**

  - `MonthView.tsx`: weekday header `bg-[var(--surface)]` → keep, but use `border-b-[var(--border-subtle)]`. Grid borders `border-[var(--border)]` → `border-[var(--border-subtle)]`. In-month day `bg-[var(--background)] hover:bg-[var(--hover)]` → `bg-[var(--background)] hover:bg-[var(--primary-subtle)]`. Out-of-month day `bg-[var(--surface)]/60` → `bg-surface-elevated/60`. "+N more" button `hover:bg-[var(--hover)]` → `hover:bg-[var(--primary-subtle)]`.
  - `WeekView.tsx`: replace `bg-[var(--accent)]/30` with `bg-[var(--primary-subtle)]`. Replace `hover:bg-[var(--hover)]/50` with `hover:bg-[var(--primary-subtle)]/70`. Borders `border-[var(--border)]` → `border-[var(--border-subtle)]`.
  - `DayView.tsx` & `AgendaView.tsx`: replace `bg-[var(--highlight)]` with `bg-[var(--primary-subtle)]`; replace `bg-[var(--surface)]` empty icon with `bg-surface-elevated`. Replace `hover:bg-[var(--hover)]` with `hover:bg-[var(--primary-subtle)]`; replace `border-[var(--border)]` with `border-[var(--border-subtle)]`. Keep the `border-l-[3px] border-l-[var(--primary)]` accent.

- [ ] **Step 5: Event create modal (`EventCreateModal.tsx`)**

  Backdrop stays `bg-black/40`. Modal root `bg-background border-border` → `bg-surface-floating border-[var(--border-subtle)] shadow-xl`.
  Inputs: `bg-background border-border` → `bg-[var(--background)] border-[var(--border-subtle)]`; focus ring unchanged.
  Popover: `bg-surface border-border` → `bg-surface-floating border-[var(--border-subtle)]`.
  ListBoxItem: `hover:bg-hover data-[selected=true]:bg-selected data-[selected=true]:text-selected-text` → `hover:bg-[var(--primary-subtle)] data-[selected=true]:bg-[var(--primary-muted)] data-[selected=true]:text-[var(--foreground)]`.
  Switch knob `bg-white` → `bg-[var(--surface-floating)]` (still visible on both themes).
  Error bar: keep `bg-destructive/10 border-destructive/30`.

- [ ] **Step 6: Event card (`EventCard.tsx`)**

  Replace `bg-[var(--secondary)]` with `bg-surface-elevated`.
  Replace `hover:bg-[var(--hover)]` with `hover:bg-[var(--primary-subtle)]`.
  Keep the left accent border.

- [ ] **Step 7: Verification**

  Run:
  ```bash
  cd kylins.client.frontend
  npm run format
  npx tsc --noEmit
  npm run lint
  npx vitest run tests/components/calendar tests/styles/themeTokens.test.ts
  ```

- [ ] **Step 8: Commit**

  ```bash
  cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
  git add src/components/calendar
  git commit -m "feat(frontend): apply acrylic surfaces to calendar"
  ```

---

# Task 13: Apply Acrylic Surfaces to Contacts

**Goal:** Update contacts page surfaces, list row states, detail cards, and the source badge to use the Fluent Acrylic token system.

**Files:**
- Modify: `src/components/contacts/ContactsPage.tsx`
- Modify: `src/components/contacts/ContactAccountPane.tsx`
- Modify: `src/components/contacts/ContactList.tsx`
- Modify: `src/components/contacts/ContactDetail.tsx`
- Modify: `src/components/contacts/GroupDetail.tsx`
- Modify: `src/components/contacts/ContactGroupManager.tsx`
- Modify: `src/components/contacts/SourceBadge.tsx`

**Interfaces:**
- Consumes: `--surface`, `--surface-elevated`, `--surface-floating`, `--border-subtle`, `--border`, `--primary-subtle`, `--primary-muted`, `--primary`, `--selected-text`, `--muted-text`, `--foreground`, `--background`, `--hover`, `--ring`, `--secondary`.
- Produces: updated contacts surfaces.

- [ ] **Step 1: List rows (`ContactList.tsx`)**

  Search field wrapper: keep `border-b-[var(--border)]` or soften to `border-b-[var(--border-subtle)]`.
  Search input: `bg-[var(--background)] border-[var(--border)]` → `bg-surface-elevated border-[var(--border-subtle)]`.
  List items: active state `border-[var(--primary)] bg-[var(--selected)]` → `border-[var(--primary)] bg-[var(--primary-muted)]`; inactive state `border-[var(--border)] bg-[var(--background)] hover:bg-[var(--hover)]` → `border-[var(--border-subtle)] bg-surface-elevated hover:bg-[var(--primary-subtle)]`.
  Group icon circle: `bg-[var(--secondary)]` → `bg-surface-floating`.

- [ ] **Step 2: Account pane (`ContactAccountPane.tsx`)**

  Active item: `bg-[var(--selected)] text-[var(--selected-text)]` → `bg-[var(--primary-muted)] text-[var(--selected-text)]`.
  Hover: `hover:bg-[var(--hover)]` → `hover:bg-[var(--primary-subtle)]`.

- [ ] **Step 3: Detail card (`ContactDetail.tsx`)**

  Header and section areas stay on the inherited surface. Update action buttons:
  - Primary action (`Compose`, `Save`) keep `bg-[var(--primary)]`.
  - Secondary actions (`Copy email`, `Edit`, `Cancel`) `bg-[var(--background)] border-[var(--border)] hover:bg-[var(--hover)]` → `bg-surface-elevated border-[var(--border-subtle)] hover:bg-[var(--primary-subtle)]`.
  - Destructive `Delete` button: keep text destructive; hover `hover:bg-[var(--hover)]` → `hover:bg-[var(--primary-subtle)]`.
  Inputs in edit mode: `bg-[var(--background)] border-[var(--border)]` → `bg-surface-elevated border-[var(--border-subtle)]`.
  Group membership chips: active `border-[var(--primary)] bg-[var(--selected)] text-[var(--selected-text)]` → `border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--selected-text)]`; inactive `border-[var(--border)] bg-[var(--background)] hover:bg-[var(--hover)]` → `border-[var(--border-subtle)] bg-surface-elevated hover:bg-[var(--primary-subtle)]`.

- [ ] **Step 4: Group detail (`GroupDetail.tsx`)**

  Replace `bg-[var(--secondary)]` and `bg-[var(--background)]` surfaces with `bg-surface-elevated` where appropriate.
  Replace `hover:bg-[var(--hover)]` with `hover:bg-[var(--primary-subtle)]`.
  Replace `border-[var(--border)]` with `border-[var(--border-subtle)]`.

- [ ] **Step 5: Contact group manager (`ContactGroupManager.tsx`)**

  Replace `bg-[var(--background)]` panels with `bg-surface-elevated`.
  Replace `hover:opacity-80` / `hover:text-[var(--foreground)]` with explicit `hover:bg-[var(--primary-subtle)]` where it improves affordance.

- [ ] **Step 6: Source badge (`SourceBadge.tsx`)**

  Keep semantic intent but express it through theme-aware tokens instead of hard-coded Tailwind colors:
  ```ts
  const SOURCE_STYLES: Record<string, string> = {
    mail: 'bg-[var(--secondary)] text-[var(--secondary-foreground)]',
    local: 'bg-primary-subtle text-primary',
    carddav: 'bg-[var(--success)]/10 text-[var(--success)]',
    google_people: 'bg-[var(--info)]/10 text-[var(--info)]',
    eas_gal: 'bg-[var(--warning)]/10 text-[var(--warning)]',
  };
  ```
  If `--info` does not exist in `theme.css`, map `google_people` to `bg-primary-subtle text-primary` instead.

- [ ] **Step 7: Page shell / add-contact modal (`ContactsPage.tsx`)**

  The page has no root surface of its own (delegates to `ResizablePaneGroup` with `card: true`). Ensure the modal input uses `bg-surface-elevated border-[var(--border-subtle)]`.

- [ ] **Step 8: Verification**

  Run:
  ```bash
  cd kylins.client.frontend
  npm run format
  npx tsc --noEmit
  npm run lint
  npx vitest run tests/components/contacts tests/styles/themeTokens.test.ts
  ```

- [ ] **Step 9: Commit**

  ```bash
  cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
  git add src/components/contacts
  git commit -m "feat(frontend): apply acrylic surfaces to contacts"
  ```

---

# Task 14: Apply Acrylic Surfaces to Tasks

**Goal:** Update tasks page shell, toolbar, list rows, detail form, and create dialog to use the Fluent Acrylic elevation and accent tokens.

**Files:**
- Modify: `src/components/tasks/TasksPage.tsx`
- Modify: `src/components/tasks/TaskToolbar.tsx`
- Modify: `src/components/tasks/TaskList.tsx`
- Modify: `src/components/tasks/TaskItem.tsx`
- Modify: `src/components/tasks/TaskDetail.tsx`
- Modify: `src/components/tasks/TaskCreateDialog.tsx`
- Modify: `src/components/tasks/TaskThreadSidebar.tsx`

**Interfaces:**
- Consumes: `--surface`, `--surface-elevated`, `--surface-floating`, `--border-subtle`, `--border`, `--primary-subtle`, `--primary-muted`, `--primary`, `--primary-fg`, `--muted-text`, `--text`, `--foreground`, `--background`, `--card`, `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`, `--ring`, `--error`.
- Produces: updated tasks surfaces.

- [ ] **Step 1: Page shell (`TasksPage.tsx`)**

  Root `bg-card border-border` → `bg-surface border-[var(--border-subtle)]`. Keep rounded corners.
  Empty/error states inherit the new surface.

- [ ] **Step 2: Toolbar (`TaskToolbar.tsx`)**

  Toolbar root `bg-card border-b-border` → `bg-surface border-b-[var(--border-subtle)]`.
  Tab well `bg-[var(--surface)]` → keep as `bg-surface-elevated`.
  Active tab `data-[selected]:bg-card data-[selected]:text-foreground data-[selected]:shadow-sm` → `data-[selected]:bg-surface-floating data-[selected]:text-foreground data-[selected]:shadow-sm`.
  Inactive tab `hover:text-foreground` → add `hover:bg-[var(--primary-subtle)]`.
  Sort trigger/popover: `bg-background border-border` → `bg-surface-elevated border-[var(--border-subtle)]`.
  Popover items: `hover:bg-hover data-[selected=true]:bg-selected` → `hover:bg-[var(--primary-subtle)] data-[selected=true]:bg-[var(--primary-muted)]`.

- [ ] **Step 3: Task list item (`TaskItem.tsx`)**

  Selected row `border-primary bg-selected` → `border-primary bg-[var(--primary-muted)]`.
  Unselected row `border-border bg-card hover:border-primary/50` → `border-[var(--border-subtle)] bg-surface-elevated hover:border-[var(--primary)]/50 hover:bg-[var(--primary-subtle)]`.
  Checkbox `bg-background border-border` → `bg-[var(--background)] border-[var(--border-subtle)]`.
  Tags `bg-[var(--surface)]` → `bg-surface-floating`.
  Delete button hover: keep icon color change; ensure it remains visible on hover.

- [ ] **Step 4: Task detail (`TaskDetail.tsx`)**

  Wrap the detail content in a subtle card feel if it is not already: keep outer `flex h-full flex-col overflow-y-auto p-4` but add `bg-surface-elevated` to the root if the parent does not provide it.
  Inputs/selects: `bg-background border-border` → `bg-surface-floating border-[var(--border-subtle)]`.
  Calendar popover: `bg-background border-border` → `bg-surface-floating border-[var(--border-subtle)]`.
  Calendar cells: `hover:bg-hover data-[selected=true]:bg-primary` → `hover:bg-[var(--primary-subtle)] data-[selected=true]:bg-primary`.
  Delete button `hover:bg-[var(--error)]/10` → keep.
  Completion checkbox panel: `bg-background border-border` → `bg-surface-floating border-[var(--border-subtle)]`.

- [ ] **Step 5: Create dialog (`TaskCreateDialog.tsx`)**

  Modal root `bg-background border-border shadow-xl` → `bg-surface-floating border-[var(--border-subtle)] shadow-xl`.
  Inputs/selects/calendar popover: same treatment as TaskDetail.
  ListBox items: `hover:bg-hover data-[selected=true]:bg-selected` → `hover:bg-[var(--primary-subtle)] data-[selected=true]:bg-[var(--primary-muted)]`.

- [ ] **Step 6: Thread sidebar (`TaskThreadSidebar.tsx`)**

  Root `bg-card border-t-[border] border-border` → `bg-surface-elevated border-t-[var(--border-subtle)] border-[var(--border-subtle)]`.
  Replace `hover:opacity-90` with `hover:bg-[var(--primary-subtle)]` where actionable.

- [ ] **Step 7: Verification**

  Run:
  ```bash
  cd kylins.client.frontend
  npm run format
  npx tsc --noEmit
  npm run lint
  npx vitest run tests/components/tasks tests/styles/themeTokens.test.ts
  ```

- [ ] **Step 8: Commit**

  ```bash
  cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
  git add src/components/tasks
  git commit -m "feat(frontend): apply acrylic surfaces to tasks"
  ```

---

# Task 15: Apply Acrylic Surfaces to Composer

**Goal:** Promote the composer from flat panels to layered acrylic surfaces: chrome header, floating popovers/dialogs, elevated attachment chips, and a refined editor toolbar.

**Files:**
- Modify: `src/components/composer/Composer.tsx`
- Modify: `src/components/composer/EditorToolbar.tsx`
- Modify: `src/components/composer/ScheduleSendDialog.tsx`
- Modify: `src/components/composer/AttachmentPicker.tsx`
- Modify: `src/components/composer/UndoSendToast.tsx`
- Modify: `src/components/composer/SignatureSelector.tsx`
- Modify: `src/components/composer/TemplatePicker.tsx`
- Modify: `src/components/composer/FromSelector.tsx`

**Interfaces:**
- Consumes: `--surface`, `--surface-elevated`, `--surface-floating`, `--chrome-tint`, `--border-subtle`, `--border`, `--primary-subtle`, `--primary-muted`, `--primary`, `--primary-fg`, `--accent`, `--accent-foreground`, `--muted-text`, `--text`, `--foreground`, `--background`, `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`, `--shadow-2xl`, `--ring`.
- Produces: updated composer surfaces.

- [ ] **Step 1: Composer shell (`Composer.tsx`)**

  Inline composer panel `bg-[var(--background)]` → `bg-surface-floating` (level-3 floating, since it is a modal-like overlay). Border `border-[var(--border)]` → `border-[var(--border-subtle)]`. Keep `shadow-2xl`.
  Header bar `bg-[var(--surface)] border-b-[var(--border)]` → `bg-[var(--chrome-tint)] border-b-[var(--border-subtle)]`.
  Address fields / subject area: keep subtle `border-b-[var(--border-subtle)]`.
  Drop overlay `bg-[var(--accent)]/90` → keep; drop icon circle `bg-[var(--primary)]` → keep.
  Footer bar `bg-[var(--surface)]` → `bg-[var(--chrome-tint)]`.

- [ ] **Step 2: Editor toolbar (`EditorToolbar.tsx`)**

  Root `bg-[var(--surface)] border-b-[var(--border)]` → `bg-[var(--chrome-tint)] border-b-[var(--border-subtle)]`.
  ToolbarButton: `hover:bg-[var(--hover)] data-[selected]:bg-[var(--selected)]` → `hover:bg-[var(--primary-subtle)] data-[selected]:bg-[var(--primary-muted)] data-[selected]:text-[var(--foreground)]`.
  Font select popover: `bg-[var(--background)] border-[var(--border)]` → `bg-surface-floating border-[var(--border-subtle)]`; items `hover:bg-[var(--hover)] data-[selected]:bg-[var(--selected)]` → `hover:bg-[var(--primary-subtle)] data-[selected]:bg-[var(--primary-muted)]`.
  ColorButton active state: `bg-[var(--selected)]` → `bg-[var(--primary-muted)]`.
  AI Assist toggle: `data-[selected]:bg-[var(--accent)] data-[selected]:text-[var(--accent-foreground)]` → keep accent for AI; hover `hover:bg-[var(--hover)]` → `hover:bg-[var(--primary-subtle)]`.
  Toolbar divider `bg-[var(--border)]` → `bg-[var(--border-subtle)]`.

- [ ] **Step 3: Schedule-send dialog (`ScheduleSendDialog.tsx`)**

  Backdrop `bg-black/30` → keep. Modal root `bg-background border-border shadow-xl` → `bg-surface-floating border-[var(--border-subtle)] shadow-xl`.
  Preset buttons `hover:bg-hover` → `hover:bg-[var(--primary-subtle)]`.
  Datetime input `bg-background border-border` → `bg-surface-elevated border-[var(--border-subtle)]`.

- [ ] **Step 4: Pickers and selectors**

  - `AttachmentPicker.tsx`: `bg-highlight text-highlight-text` → if these tokens exist keep them; otherwise use `bg-surface-elevated text-foreground`.
  - `UndoSendToast.tsx`: replace `bg-white/20` with `bg-[var(--surface-floating)]/20`. Keep `bg-[var(--foreground)]` and `bg-[var(--primary)]` intent.
  - `SignatureSelector.tsx`, `TemplatePicker.tsx`, `FromSelector.tsx`: popover `bg-popover` / `bg-background border-border` → `bg-surface-floating border-[var(--border-subtle)]`. Items `hover:bg-hover selected:bg-selected` → `hover:bg-[var(--primary-subtle)] selected:bg-[var(--primary-muted)] selected:text-[var(--foreground)]`.

- [ ] **Step 5: Verification**

  Run:
  ```bash
  cd kylins.client.frontend
  npm run format
  npx tsc --noEmit
  npm run lint
  npx vitest run tests/components/composer tests/styles/themeTokens.test.ts
  ```

- [ ] **Step 6: Commit**

  ```bash
  cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
  git add src/components/composer
  git commit -m "feat(frontend): apply acrylic surfaces to composer"
  ```

---

# Task 16: Apply Acrylic Surfaces to Preferences

**Goal:** Refresh the preferences dialog and every section card/editor to use layered surfaces, subtle borders, and unified hover/selected states.

**Files:**
- Modify: `src/components/preferences/PreferencesDialog.tsx`
- Modify: `src/components/preferences/PreferencesSectionCard.tsx`
- Modify: `src/components/preferences/PreferenceRows.tsx`
- Modify: `src/components/preferences/PreferencesTabLayout.tsx` (if it has surface classes)
- Modify: `src/components/preferences/AppearancePreferences.tsx`
- Modify: `src/components/preferences/AccountsPreferences.tsx`
- Modify: `src/components/preferences/AccountDetailsEditor.tsx`
- Modify: `src/components/preferences/KeyManagerSection.tsx`
- Modify: `src/components/preferences/TrustedCasSection.tsx`
- Modify: `src/components/preferences/ContactsPreferences.tsx`
- Modify: `src/components/preferences/ShortcutsPreferences.tsx`
- Modify: `src/components/preferences/SignatureEditor.tsx`
- Modify: `src/components/preferences/AliasManager.tsx`
- Modify: `src/components/preferences/ProviderBadge.tsx`

**Interfaces:**
- Consumes: `--surface`, `--surface-elevated`, `--surface-floating`, `--chrome`, `--chrome-tint`, `--border-subtle`, `--border`, `--primary-subtle`, `--primary-muted`, `--primary`, `--selected-text`, `--muted-text`, `--text`, `--foreground`, `--background`, `--shadow-sm`, `--shadow-lg`, `--ring`, `--destructive`.
- Produces: updated preferences surfaces.

- [ ] **Step 1: Dialog shell (`PreferencesDialog.tsx`)**

  Keep `Modal` usage. The `contentClassName` currently uses `bg-[color-mix(in_oklab,var(--surface),black_2%)]`; change to `bg-surface-elevated`.
  Tab list `bg-chrome border-r-[border]` → `bg-[var(--chrome-tint)] border-r-[var(--border-subtle)]`.
  Tab items: selected `bg-selected text-primary` → `bg-[var(--primary-muted)] text-[var(--foreground)]`; hover `hover:bg-hover` → `hover:bg-[var(--primary-subtle)]`.

- [ ] **Step 2: Section card (`PreferencesSectionCard.tsx`)**

  Root `bg-[var(--surface)] border-[var(--border)] shadow-sm` → `bg-surface-elevated border-[var(--border-subtle)] shadow-sm`.
  Icon circle `bg-[var(--highlight)]` → keep if token exists; otherwise `bg-[var(--primary-subtle)]`.

- [ ] **Step 3: Preference rows (`PreferenceRows.tsx`)**

  Row switch background `bg-background` → `bg-surface-elevated`; active `bg-primary` keep.
  Popover `bg-background shadow-lg` → `bg-surface-floating border-[var(--border-subtle)] shadow-lg`.
  Items `hover:bg-hover selected:bg-selected` → `hover:bg-[var(--primary-subtle)] selected:bg-[var(--primary-muted)] selected:text-[var(--foreground)]`.
  Replace the custom `hover:bg-[color-mix(in_oklab,var(--surface),black_4%)]` with `hover:bg-[var(--primary-subtle)]`.

- [ ] **Step 4: Appearance preferences (`AppearancePreferences.tsx`)**

  Theme swatch hover `hover:bg-[var(--hover)]` → `hover:bg-[var(--primary-subtle)]`.
  Selected swatch ring `ring-2 ring-white/20` → `ring-2 ring-[var(--surface-floating)]/30` (or remove if it conflicts with dark mode).
  Preview panels: replace `bg-[var(--background)]` / `bg-[var(--hover)]` / `bg-[var(--highlight)]` with appropriate surface tokens.

- [ ] **Step 5: Accounts + editors**

  - `AccountsPreferences.tsx`: account row selected `selected:border-[var(--primary)] selected:bg-[var(--selected)] selected:text-[var(--primary)]` → `selected:border-[var(--primary)] selected:bg-[var(--primary-muted)] selected:text-[var(--foreground)]`. Hover `hover:bg-[var(--hover)]` → `hover:bg-[var(--primary-subtle)]`. Panels `bg-[var(--background)]` → `bg-surface-elevated`; `bg-[var(--surface)]` → keep or elevate as needed.
  - `AccountDetailsEditor.tsx`: inputs/panels `bg-[var(--background)]` → `bg-surface-elevated`; `hover:bg-[var(--hover)]` / `hover:bg-[color-mix(...)]` → `hover:bg-[var(--primary-subtle)]`. Destructive mixed backgrounds keep intent.
  - `KeyManagerSection.tsx`, `TrustedCasSection.tsx`, `AliasManager.tsx`: same pattern — panels to `bg-surface-elevated`, hover to `primary-subtle`, destructive text/backgrounds keep semantic intent.

- [ ] **Step 6: Other section components**

  - `ContactsPreferences.tsx`, `ShortcutsPreferences.tsx`, `SignatureEditor.tsx`: update any remaining `bg-[var(--background)]` inputs/panels to `bg-surface-elevated`; `bg-[var(--hover)]` hovers to `primary-subtle`; selected rows to `primary-muted`.

- [ ] **Step 7: Provider badge (`ProviderBadge.tsx`)**

  Replace `text-white` with `text-[var(--primary-fg)]` when the badge background is a brand color. If the inline `backgroundColor` is the provider brand, ensure foreground remains readable; for dark brand colors `text-white` is acceptable, but prefer `text-[var(--primary-fg)]` if the brand color is mapped to `--primary`.

- [ ] **Step 8: Verification**

  Run:
  ```bash
  cd kylins.client.frontend
  npm run format
  npx tsc --noEmit
  npm run lint
  npx vitest run tests/components/preferences tests/styles/themeTokens.test.ts
  ```

- [ ] **Step 9: Commit**

  ```bash
  cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
  git add src/components/preferences
  git commit -m "feat(frontend): apply acrylic surfaces to preferences"
  ```

---

# Task 17: Apply Acrylic Surfaces to Account Setup

**Goal:** Make the account setup flow feel premium and cohesive with the rest of the app: a tinted chrome title bar, layered cards, translucent provider tiles, and subtle hover/selected states.

**Files:**
- Modify: `src/components/account-setup/setup-ui.tsx`
- Modify: `src/components/account-setup/WelcomeScreen.tsx`
- Modify: `src/components/account-setup/VerifyStep.tsx`
- Modify: `src/components/account-setup/OAuthPendingScreen.tsx`
- Modify: `src/components/account-setup/ImapManualForm.tsx`
- Modify: `src/components/account-setup/CredentialsGate.tsx`

**Interfaces:**
- Consumes: `--background`, `--surface`, `--surface-elevated`, `--surface-floating`, `--chrome`, `--chrome-tint`, `--border-subtle`, `--border`, `--border-border`, `--primary-subtle`, `--primary-muted`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted-text`, `--text`, `--foreground`, `--hover`, `--destructive`, `--destructive-foreground`, `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`, `--shadow-2xl`, `--ring`.
- Produces: updated account setup surfaces.

- [ ] **Step 1: Setup shell (`setup-ui.tsx`)**

  `SetupTitleBar`: `bg-surface border-b border-border` → `glass bg-gradient-to-b from-[var(--chrome-glass-start)] to-[var(--chrome-glass-end)] border-b-[var(--border-subtle)]` (no split line).
  `SetupShell` root: `bg-background` → `bg-[var(--chrome-tint)]` so the card sits on a tinted ground.
  `SetupCard`: `bg-card/95 border-border/60 shadow-2xl shadow-black/[0.06] backdrop-blur-sm` → `bg-surface-floating border-[var(--border-subtle)] shadow-2xl`.
  `SetupButton` secondary: `bg-secondary border-border/80 hover:bg-hover` → `bg-surface-elevated border-[var(--border-subtle)] hover:bg-[var(--primary-subtle)]`.
  `SetupButton` ghost: keep `hover:bg-hover` or use `hover:bg-[var(--primary-subtle)]`.
  `SetupInput`: `bg-background border-border/80` → `bg-surface-elevated border-[var(--border-subtle)]`; focus ring unchanged.
  `SetupSelect` popover: `bg-background border-border/60 shadow-xl shadow-black/[0.08]` → `bg-surface-floating border-[var(--border-subtle)] shadow-xl`.
  `SetupSelect` items: `hover:bg-hover selected:bg-selected` → `hover:bg-[var(--primary-subtle)] selected:bg-[var(--primary-muted)] selected:text-[var(--foreground)]`.
  `SetupBackButton`: `bg-secondary border-border/60 hover:bg-hover` → `bg-surface-elevated border-[var(--border-subtle)] hover:bg-[var(--primary-subtle)]`.
  `ProviderTile`: `bg-surface border-border` → `bg-surface-elevated border-[var(--border-subtle)]`; hover `hover:-translate-y-0.5 hover:border-primary hover:shadow-md` → add `hover:bg-[var(--primary-subtle)]` and keep lift/shadow.
  Provider glyph badge `text-white` → `text-[var(--primary-fg)]`.

- [ ] **Step 2: Step screens**

  - `WelcomeScreen.tsx`: `bg-accent` success circle → `bg-[var(--success)]` if token exists, otherwise keep `bg-accent`.
  - `VerifyStep.tsx`: `bg-error-bg` → keep if token exists; otherwise use `bg-[var(--destructive)]/10`.
  - `OAuthPendingScreen.tsx`: root `bg-background border-border` → `bg-surface-elevated border-[var(--border-subtle)]`.
  - `ImapManualForm.tsx`: secondary panels `bg-secondary/60` → `bg-surface-elevated`; inputs `bg-background border-border/60` → `bg-surface-elevated border-[var(--border-subtle)]`; success/error borders keep semantic tokens.
  - `CredentialsGate.tsx`: `bg-secondary/70` panels → `bg-surface-elevated`; inputs same as above.

- [ ] **Step 3: Verification**

  Run:
  ```bash
  cd kylins.client.frontend
  npm run format
  npx tsc --noEmit
  npm run lint
  npx vitest run tests/components/account-setup tests/styles/themeTokens.test.ts
  ```

- [ ] **Step 4: Commit**

  ```bash
  cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
  git add src/components/account-setup
  git commit -m "feat(frontend): apply acrylic surfaces to account setup"
  ```

---

# Task 18: Apply Acrylic Surfaces to Shared UI Primitives

**Goal:** Update the shared UI primitives so every dropdown, menu, modal, toast, and button across the app participates in the Fluent Acrylic visual system.

**Files:**
- Modify: `src/components/ui/Modal.tsx`
- Modify: `src/components/ui/Toaster.tsx`
- Modify: `src/components/ui/IconButton.tsx`
- Modify: `src/components/ui/SegmentedControl.tsx`
- Modify: `src/components/ui/MenuBar.tsx`
- Modify: `src/components/ui/ContextMenu.tsx`
- Modify: `src/components/ui/InputDialog.tsx`
- Modify: `src/components/ui/WindowTitleBar.tsx`
- Modify: `src/components/ui/WindowErrorBoundary.tsx`

**Interfaces:**
- Consumes: `--surface`, `--surface-elevated`, `--surface-floating`, `--chrome`, `--chrome-tint`, `--border-subtle`, `--border`, `--primary-subtle`, `--primary-muted`, `--primary`, `--primary-fg`, `--muted-text`, `--text`, `--foreground`, `--background`, `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`, `--shadow-2xl`, `--ring`, `--destructive`, `--destructive-foreground`, `--green`, `--red-600`.
- Produces: updated shared primitives.

- [ ] **Step 1: Modal (`Modal.tsx`)**

  Modal root `bg-surface border-border shadow-2xl` → `bg-surface-floating border-[var(--border-subtle)] shadow-2xl`.
  Header `border-b border-border` → `border-b-[var(--border-subtle)]`.
  Footer `bg-[color-mix(in_oklab,var(--surface),black_4%)] border-t border-border` → `bg-surface-elevated border-t-[var(--border-subtle)]`.
  Close button `hover:bg-hover` → `hover:bg-[var(--primary-subtle)]`.

- [ ] **Step 2: Toaster (`Toaster.tsx`)**

  Replace hard-coded `text-white` with `text-[var(--primary-fg)]`.
  Success toast `bg-[var(--green)]` → if a `--success` token exists use `bg-[var(--success)]`; otherwise keep `--green`.
  Error toast `bg-[var(--destructive)] text-[var(--primary-fg)]`.
  Default toast `bg-[var(--foreground)] text-[var(--background)]` → keep.

- [ ] **Step 3: IconButton (`IconButton.tsx`)**

  Already uses `hover:bg-[var(--primary-subtle)]` and `bg-selected`. Verify it stays consistent; no change required unless the inactive state needs refinement.

- [ ] **Step 4: SegmentedControl (`SegmentedControl.tsx`)**

  Container `bg-background border-border` → `bg-surface-elevated border-[var(--border-subtle)]`.
  Inactive item `hover:bg-hover` → `hover:bg-[var(--primary-subtle)]`.
  Selected item `selected:bg-primary selected:text-primary-fg` → keep.

- [ ] **Step 5: MenuBar (`MenuBar.tsx`)**

  Category button active `bg-selected text-primary` → `bg-[var(--primary-muted)] text-[var(--foreground)]`.
  Hover `hover:bg-hover` → `hover:bg-[var(--primary-subtle)]`.
  Dropdown wrapper `bg-surface border-border shadow-lg` → `bg-surface-floating border-[var(--border-subtle)] shadow-lg`.
  MenuItem `hover:bg-hover [&[data-hovered]]:bg-hover [&[data-focused]]:bg-hover` → `hover:bg-[var(--primary-subtle)] [&[data-hovered]]:bg-[var(--primary-subtle)] [&[data-focused]]:bg-[var(--primary-subtle)]`.
  Danger item `text-red-600` → `text-[var(--destructive)]`; on hover/focus add `bg-[var(--destructive)]/10`.

- [ ] **Step 6: ContextMenu (`ContextMenu.tsx`)**

  Root `bg-surface border-border shadow-lg` → `bg-surface-floating border-[var(--border-subtle)] shadow-lg`.
  Danger item `text-red-600` → `text-[var(--destructive)]`; hover background `bg-hover` → `bg-[var(--destructive)]/10`.
  Non-danger hover `bg-hover` → `bg-[var(--primary-subtle)]`.

- [ ] **Step 7: InputDialog (`InputDialog.tsx`)**

  Backdrop `bg-black/30` keep. Modal root `bg-background border-border shadow-xl` → `bg-surface-floating border-[var(--border-subtle)] shadow-xl`.
  Input `bg-background border-border` → `bg-surface-elevated border-[var(--border-subtle)]`.
  Buttons: cancel `hover:bg-hover` → `hover:bg-[var(--primary-subtle)]`.

- [ ] **Step 8: WindowTitleBar (`WindowTitleBar.tsx`)**

  Root `bg-[var(--surface)] border-b-[var(--border)]` → `glass bg-gradient-to-b from-[var(--chrome-glass-start)] to-[var(--chrome-glass-end)] border-b-[var(--border-subtle)]`.
  Button hovers `hover:bg-[var(--hover)]` → `hover:bg-[var(--primary-subtle)]`; close hover `hover:bg-[var(--destructive)] hover:text-[var(--primary-fg)]` → keep.

- [ ] **Step 9: WindowErrorBoundary (`WindowErrorBoundary.tsx`)**

  Replace `bg-[var(--surface)]`, `bg-[var(--background)]`, `bg-[var(--hover)]` with appropriate surface/primary-subtle tokens. Replace `border-[var(--border)]` with `border-[var(--border-subtle)]`.

- [ ] **Step 10: Verification**

  Run:
  ```bash
  cd kylins.client.frontend
  npm run format
  npx tsc --noEmit
  npm run lint
  npx vitest run tests/components/ui tests/styles/themeTokens.test.ts
  ```

- [ ] **Step 11: Commit**

  ```bash
  cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
  git add src/components/ui
  git commit -m "feat(frontend): apply acrylic surfaces to shared ui primitives"
  ```

---

# Task 8: Apply Acrylic Surfaces to FolderPane

**Goal:** Bring the folder pane into the Fluent Acrylic elevation system, unifying selected/hover states with primary-subtle/muted tokens and removing hard visual splits.

**Files:**
- Modify: `src/components/layout/FolderPane.tsx`

**Interfaces:**
- Consumes: `--surface`, `--border-subtle`, `--primary-subtle`, `--primary-muted`, `--selected-text`, `--muted-text`, `--surface-elevated`, `--duration-fast`.
- Produces: updated FolderPane surfaces.

- [ ] **Step 1: Pane root surface**

  Change the root `className` from `flex h-full flex-col rounded-xl bg-surface` to use a level-1 surface treatment:

  ```tsx
  className="flex h-full flex-col rounded-xl bg-surface border border-[var(--border-subtle)]"
  ```

- [ ] **Step 2: Unify row selected/hover states**

  In `FolderRow`, replace the active/hover background classes:
  - active: `bg-[var(--primary-muted)] text-[var(--selected-text)]`
  - hover: `hover:bg-[var(--primary-subtle)]`

  Keep the existing `group` and left accent pill (`absolute ... w-[2px] bg-primary`).

  In `AccountFolderTree` `TreeItem` className callback, replace `bg-selected` / `bg-hover` with the same `primary-muted` / `primary-subtle` tokens.

- [ ] **Step 3: Favorites/account separator**

  Change the separator `<div className="mx-3 h-px bg-border" />` to `bg-[var(--border-subtle)]`.

- [ ] **Step 4: Group header readability**

  Ensure the `FolderGroup` header uses `text-[var(--muted-text)]` instead of `text-foreground`.

- [ ] **Step 5: Unread badge**

  For non-selected rows, change the badge container from `border border-border bg-surface` to `border border-[var(--border-subtle)] bg-[var(--surface-elevated)]`.

- [ ] **Step 6: Transitions**

  Add `transition-colors duration-fast` to `FolderRow` and `TreeItem` row elements so hover/selection changes are smooth.

- [ ] **Step 7: Verification**

  Run:

  ```bash
  cd kylins.client.frontend
  npm run format
  npx tsc --noEmit
  npm run lint
  npx vitest run tests/components/layout/FolderPane.test.tsx tests/styles/themeTokens.test.ts
  ```

- [ ] **Step 8: Commit**

  ```bash
  cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
  git add src/components/layout/FolderPane.tsx
  git commit -m "feat(frontend): apply acrylic surfaces to FolderPane"
  ```

---

# Task 9: Apply Acrylic Surfaces to MessageList

**Goal:** Update the message list container, day headers, tab bar, and rows to use the new surface/accent tokens, and make selected vs hover states visually distinct.

**Files:**
- Modify: `src/components/layout/MessageList.tsx`

**Interfaces:**
- Consumes: `--surface`, `--surface-elevated`, `--surface-floating`, `--border-subtle`, `--primary-subtle`, `--primary-muted`, `--muted-text`, `--text`, `--foreground`.
- Produces: updated MessageList surfaces.

- [ ] **Step 1: List container**

  Change root `className="message-list flex flex-col h-full bg-[var(--card)]"` to `bg-surface` and add a subtle border:

  ```tsx
  className="message-list flex flex-col h-full bg-surface border-r border-[var(--border-subtle)]"
  ```

- [ ] **Step 2: Inbox tabs**

  For the active tab, replace `bg-[var(--selected)]` with `bg-[var(--primary-muted)] text-[var(--foreground)]`.
  For inactive tabs, replace `hover:bg-[var(--hover)]` with `hover:bg-[var(--primary-subtle)]`.
  Keep focus rings.

- [ ] **Step 3: Day group headers**

  Change the header border from `border-b border-[var(--border)]` to `border-b border-[var(--border-subtle)]`.

- [ ] **Step 4: MessageRow states**

  Replace the row background logic:
  - selected: `bg-[var(--primary-muted)]`
  - hover: `hover:bg-[var(--primary-subtle)]`

  Ensure the `prominent` tint row still applies its own background when not selected.

- [ ] **Step 5: Quick actions floating bar**

  In `MessageRowQuickActions`, replace the container background:
  - selected: `bg-[var(--surface-floating)]`
  - default/hover: `bg-[var(--surface-elevated)]`

  Use `border-[var(--border-subtle)]` for the bar border and `hover:bg-[var(--primary-subtle)]` for the inner icon buttons.

- [ ] **Step 6: Loading/empty states**

  Keep icons and text using `text-[var(--muted-text)]`; ensure empty-state panels inherit `bg-surface`.

- [ ] **Step 7: Verification**

  Run:

  ```bash
  cd kylins.client.frontend
  npm run format
  npx tsc --noEmit
  npm run lint
  npx vitest run tests/components/layout/MessageList.test.tsx tests/styles/themeTokens.test.ts
  ```

- [ ] **Step 8: Commit**

  ```bash
  cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
  git add src/components/layout/MessageList.tsx
  git commit -m "feat(frontend): apply acrylic surfaces to MessageList"
  ```

---

# Task 10: Apply Acrylic Surfaces to ReadingPane

**Goal:** Promote the reading pane from a flat card to a level-2 card surface and update the message header to match the new token system.

**Files:**
- Modify: `src/components/layout/ReadingPane.tsx`
- Modify: `src/features/viewer/MessageHeader.tsx`

**Interfaces:**
- Consumes: `--surface-elevated`, `--surface-floating`, `--surface`, `--border`, `--border-subtle`, `--primary-subtle`, `--primary-muted`, `--muted-text`, `--text`, `--shadow-sm`.
- Produces: updated ReadingPane and MessageHeader surfaces.

- [ ] **Step 1: ReadingPane root card surface**

  Change both the message view root and the empty-state root from `bg-[var(--card)]` to a level-2 card treatment.

  Message view:
  ```tsx
  className="reading-pane relative flex h-full min-w-0 flex-col bg-surface-elevated border-l border-[var(--border-subtle)] shadow-sm"
  ```

  Empty state:
  ```tsx
  className="flex h-full flex-col items-center justify-center bg-surface-elevated min-w-0 text-[var(--muted-text)]"
  ```

- [ ] **Step 2: Empty-state icon circle**

  Change the empty-state icon circle from `bg-[var(--surface)]` to `bg-[var(--surface-floating)]`.

- [ ] **Step 3: MessageHeader chrome**

  In `MessageHeader.tsx`, change the header root from `border-b border-[var(--border)]` to `border-b border-[var(--border-subtle)] bg-[var(--surface-elevated)]`.

  Update the action icon buttons and the "More actions" button to use `hover:bg-[var(--primary-subtle)]` instead of `hover:bg-[var(--hover)]`.

  Update the "Add to contacts" chip from `bg-[var(--secondary)]` to `bg-[var(--primary-subtle)] text-[var(--foreground)]`.

  Update the popover in MessageHeader from `bg-[var(--background)]` to `bg-[var(--surface-floating)]` and `border-[var(--border)]` to `border-[var(--border-subtle)]`.

- [ ] **Step 4: Decrypt failure panel**

  Keep the panel centered; change the icon circle from `bg-[var(--surface)]` to `bg-[var(--surface-floating)]`.

- [ ] **Step 5: Verification**

  Run:

  ```bash
  cd kylins.client.frontend
  npm run format
  npx tsc --noEmit
  npm run lint
  npx vitest run tests/components/layout/ReadingPane.test.tsx tests/styles/themeTokens.test.ts
  ```

- [ ] **Step 6: Commit**

  ```bash
  cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
  git add src/components/layout/ReadingPane.tsx src/features/viewer/MessageHeader.tsx
  git commit -m "feat(frontend): apply acrylic surfaces to ReadingPane"
  ```

---

# Task 11: Apply Acrylic Surfaces to CommandRibbon

**Goal:** Update the ribbon shell, group separators, button primitives, and dropdown surfaces to use the Fluent Acrylic chrome/token system.

**Files:**
- Modify: `src/components/layout/ribbon/RibbonShell.tsx`
- Modify: `src/components/layout/ribbon/RibbonPrimitives.tsx`
- Modify: `src/components/layout/ribbon/ReadRibbon.tsx`
- Modify: `src/components/layout/ribbon/ComposeRibbon.tsx`

**Interfaces:**
- Consumes: `--chrome-tint`, `--border-subtle`, `--primary-subtle`, `--primary-muted`, `--surface-floating`, `--text`, `--foreground`.
- Produces: updated ribbon surfaces.

- [ ] **Step 1: RibbonShell chrome surface**

  Change the shell className from `... bg-[var(--card)] border border-[var(--border)] ...` to:

  ```tsx
  className="mx-1 mt-1 flex min-h-[var(--ribbon-h)] min-w-0 flex-col items-stretch justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--chrome-tint)] px-2 py-1 shadow-sm md:mx-2 md:mt-2 md:px-3 md:py-1.5"
  ```

- [ ] **Step 2: RibbonGroup separator**

  Change the group border from `border-r border-border` to `border-r-[var(--border-subtle)]`.

- [ ] **Step 3: RibbonButton hover/active**

  In `RibbonButton`, replace the non-primary hover background:

  - default: `text-[var(--text)] hover:bg-[var(--primary-subtle)] active:bg-[var(--primary-muted)]`

  Keep the primary variant unchanged.

- [ ] **Step 4: RibbonToggle hover**

  In `RibbonToggle`, replace `hover:bg-hover` with `hover:bg-[var(--primary-subtle)]` (and keep the selected checkmark background using primary).

- [ ] **Step 5: Dropdown/popover surfaces**

  In `ReadRibbon.tsx` and `ComposeRibbon.tsx`, replace all popover className backgrounds `bg-[var(--background)]` with `bg-[var(--surface-floating)]` and borders `border-[var(--border)]` with `border-[var(--border-subtle)]`.

  In `ReadRibbon.tsx`, also update the split-button caret area hover from `hover:bg-[var(--hover)]` to `hover:bg-[var(--primary-subtle)]`.

- [ ] **Step 6: Verification**

  Run:

  ```bash
  cd kylins.client.frontend
  npm run format
  npx tsc --noEmit
  npm run lint
  npx vitest run tests/components/layout/ReadingPane.test.tsx tests/styles/themeTokens.test.ts
  ```

  (No dedicated CommandRibbon test exists; ReadingPane exercises ReadRibbon via MessageHeader actions.)

- [ ] **Step 7: Commit**

  ```bash
  cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
  git add src/components/layout/ribbon/RibbonShell.tsx src/components/layout/ribbon/RibbonPrimitives.tsx src/components/layout/ribbon/ReadRibbon.tsx src/components/layout/ribbon/ComposeRibbon.tsx
  git commit -m "feat(frontend): apply acrylic surfaces to CommandRibbon"
  ```

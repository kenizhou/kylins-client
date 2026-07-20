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

## Phase 1: Token & Utility Foundation

**Goal:** Introduce the new Fluent Acrylic token system and utility classes so later phases have a consistent language.

**Files:**
- Modify: `src/styles/theme.css`
- Modify: `src/styles/globals.css`
- Modify: `src/styles/skins.css`
- Modify: `tests/styles/themeTokens.test.ts`

### Task 1.1: Add surface & depth tokens

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

### Task 1.2: Expose tokens in Tailwind v4

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

### Task 1.3: Verify tokens with tests

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

### Task 1.4: Commit

```bash
cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
git add -A
git commit -m "feat(frontend): add Fluent Acrylic token system" -m "- Add surface-elevated, surface-floating, chrome-tint, primary-subtle/muted" -m "- Add elevation shadow tokens and motion tokens" -m "- Expose tokens via Tailwind v4 @theme inline and @utility classes" -m "- Add token assertions to themeTokens.test.ts"
git push origin feat/redesign-frontend-02
```

---

## Phase 2: Chrome Bars Acrylic Polish

**Goal:** Make the titlebar, leftbar, and statusbar clearly acrylic with no split lines, stronger blur, and a subtle light sheen.

**Files:**
- Modify: `src/styles/theme.css` (glass tokens)
- Modify: `src/styles/globals.css` (glass utility)
- Modify: `src/components/layout/TitleBar.tsx`
- Modify: `src/components/layout/ToolWindowBar.tsx`
- Modify: `src/components/layout/StatusBar.tsx`
- Modify: `src/components/layout/AppShell.tsx`

### Task 2.1: Strengthen glass tokens

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

### Task 2.2: Strengthen glass utility

- [ ] **Step 1: Update `.glass` utility in `globals.css`**

```css
@utility glass {
  background-color: var(--chrome-glass);
  backdrop-filter: blur(20px) saturate(200%);
  -webkit-backdrop-filter: blur(20px) saturate(200%);
}
```

### Task 2.3: Apply to chrome bars

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

### Task 2.4: Adjust root background for depth

- [ ] **Step 1: Update `AppShell.tsx` root background**

Change root className from `bg-[var(--chrome)]` to a slightly deeper tone so glass can read as translucent:

```tsx
className="relative flex flex-col h-screen w-screen overflow-hidden bg-[var(--chrome-tint)] text-[var(--foreground)]"
```

This makes the area behind the chrome bars subtly different from the chrome itself, letting the acrylic effect be visible.

### Task 2.5: Verify

- [ ] **Step 1: Run checks**

```bash
cd kylins.client.frontend
npm run format
npx tsc --noEmit
npm run lint
npx vitest run tests/components/layout/TitleBar.test.tsx tests/components/layout/StatusBar.test.tsx tests/components/layout/ResizablePaneGroup.test.tsx tests/styles/themeTokens.test.ts
```

### Task 2.6: Commit

```bash
cd D:/Projects/mailclient/kylins/.worktrees/feat/redesign-frontend-02
git add -A
git commit -m "feat(frontend): strengthen chrome bar acrylic" -m "- Increase glass blur to 20px and saturation to 200%" -m "- Add stronger white sheen and deeper shadows" -m "- Remove chrome bar borders to eliminate split lines" -m "- Use chrome-tint as root background for visible depth"
git push origin feat/redesign-frontend-02
```

---

## Phase 3: Mail Surfaces (High-Level Outline)

**Goal:** Apply Fluent Acrylic surfaces to folder pane, message list, reading pane, and ribbon.

**Files:**
- `src/components/layout/FolderPane.tsx`
- `src/components/layout/MessageList.tsx`
- `src/components/layout/ReadingPane.tsx`
- `src/components/layout/CommandRibbon.tsx`
- `src/components/layout/ribbon/ReadRibbon.tsx`
- `src/components/layout/ribbon/ComposeRibbon.tsx`
- `src/components/layout/ribbon/RibbonPrimitives.tsx`
- `src/components/layout/ribbon/RibbonShell.tsx`
- `src/features/view/components/ReadingPaneLayout.tsx`

### Task 3.1: FolderPane

- Convert container to `surface` background with `border-r border-subtle`.
- Use `primary-muted` for selected row, `primary-subtle` for hover.
- Add accent left pill to selected row.
- Increase row padding slightly (`px-3 py-2`).

### Task 3.2: MessageList

- Container: `surface` background.
- Header: `surface-elevated` with subtle bottom border.
- Rows: `primary-subtle` hover, `primary-muted` selected.
- Unread: bold text + accent thread ribbon.
- Hover quick actions: floating buttons with `surface-floating` + `shadow-elevation`.

### Task 3.3: ReadingPane

- Wrapper card: `card` + `shadow-elevation-md` + `rounded-lg`.
- Header: `surface-elevated` + bottom border.
- Action buttons: hover `primary-subtle` + slight scale.
- Attachment chips: `surface-floating`.

### Task 3.4: CommandRibbon

- Shell: `chrome-tint` background.
- Active tab: accent underline indicator.
- Groups: `border-r border-subtle` separators.
- Buttons: hover `primary-subtle`, icon+label layout.

---

## Phase 4: Secondary Pages (High-Level Outline)

**Goal:** Unify calendar, contacts, tasks, composer, preferences, dialogs, and empty states with the new token system.

**Files:**
- `src/components/calendar/*.tsx`
- `src/components/contacts/*.tsx`
- `src/components/tasks/*.tsx`
- `src/components/composer/*.tsx`
- `src/components/preferences/*.tsx`
- `src/components/ui/*.tsx`

### Task 4.1: Calendar

- Toolbar: `chrome-tint`.
- Month grid: `surface` cells, `border-subtle` grid lines.
- Today: accent circle.
- Event chips: skin-aware subtle backgrounds.

### Task 4.2: Contacts

- List: `surface` background, row hover `primary-subtle`.
- Detail card: `card` + `shadow-elevation-md`.
- Avatar initials: accent background.

### Task 4.3: Tasks

- Toolbar: `chrome-tint`.
- List: `surface`, priority dots use accent/amber/red.
- Detail: `card`.

### Task 4.4: Composer

- Header: `surface-elevated`.
- Toolbar: `chrome-tint`.
- Inputs: `surface-floating` focus background.
- Attachment chips: `surface-floating` + `shadow-elevation-sm`.

### Task 4.5: Preferences & Dialogs

- Preferences sections: `card` + `shadow-elevation-sm`.
- Modal: `surface-floating` + `shadow-elevation-xl` + `rounded-xl`.
- Empty states: subtle icon + text, no large gray blocks.

---

## Phase 5: Motion Polish (High-Level Outline)

**Goal:** Add consistent, subtle micro-interactions.

**Files:**
- `src/styles/globals.css`
- Interactive components across the app.

### Task 5.1: Add motion utilities

- Add `@utility hover-lift`, `@utility hover-scale`, `@utility press-scale` in `globals.css`.

### Task 5.2: Apply micro-interactions

- Buttons: `hover:scale-[1.02]` + background transition.
- Cards: `hover:-translate-y-px` + shadow deepen.
- List rows: `transition-fast` background.
- Popovers/menus: 120ms scale + fade.
- Toasts: 200ms slide-up.

### Task 5.3: Respect reduced motion

- Ensure `[data-reduce-motion='true']` and `prefers-reduced-motion` zero out transforms.

---

## Verification (Run After Each Phase)

```bash
cd kylins.client.frontend
npm run format
npx tsc --noEmit
npm run lint
npx vitest run
```

All must pass before committing.

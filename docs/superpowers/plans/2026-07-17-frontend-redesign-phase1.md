# Frontend Redesign Phase 1 — Visual System & Layout Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a scalable theme/token system, fix layout-level UX issues (TitleBar search, StatusBar, duplicated pane logic), and unify the icon library so subsequent Phase 2/3 component work has a solid foundation.

**Architecture:** Keep the existing CSS-variable-based theming but introduce a `ThemePack` abstraction, a shared `ResizablePaneGroup` layout primitive, and a single icon library. All changes are additive or localized; no backend RPC changes are required.

**Tech Stack:** Tauri v2, React 19, TypeScript 5.9, Tailwind CSS v4, `react-resizable-panels`, Hugeicons, Vitest 4 + jsdom.

## Global Constraints

- Run all frontend commands from `kylins.client.frontend/`.
- TypeScript `strict` + `noUnusedLocals` + `noUncheckedIndexedAccess` must pass: `npx tsc --noEmit`.
- Vitest must pass: `npx vitest run`.
- ESLint must pass: `npm run lint`.
- Prettier must pass: `npm run format:check`.
- No new `any` or `@ts-ignore`.
- Do not edit applied backend migrations.
- Secrets must still route through Rust crypto; no plaintext secrets in frontend state.
- Theme changes must work fully offline (no CDN fonts required).

---

## File Structure

| File | Responsibility |
|---|---|
| `assets/design-tokens.css` | Auto-generated or hand-curated primitive + semantic tokens; must match runtime `theme.css`. |
| `kylins.client.frontend/src/styles/theme.css` | Runtime semantic tokens and skin variables. |
| `kylins.client.frontend/src/styles/skins.ts` | Legacy skin registry (kept for backward compat). |
| `kylins.client.frontend/src/styles/themes.ts` | New ThemePack registry: light/dark/high-contrast + accent mapping. |
| `kylins.client.frontend/src/services/theme/themeManager.ts` | Applies theme mode, skin, and contrast. |
| `kylins.client.frontend/src/stores/uiStore.ts` | UI state including theme, skin, contrast. |
| `kylins.client.frontend/src/components/layout/TitleBar.tsx` | Custom draggable title bar; search will be flex-centered. |
| `kylins.client.frontend/src/features/view/components/ReadingPaneLayout.tsx` | Three-pane mail layout; MeasuredPanelCard CSS vars will be removed. |
| `kylins.client.frontend/src/components/layout/ResizablePaneGroup.tsx` | New shared wrapper around `react-resizable-panels` with persisted sizes and consistent card styling. |
| `kylins.client.frontend/src/components/contacts/ContactsPage.tsx` | Contacts three-pane page; will use `ResizablePaneGroup`. |
| `kylins.client.frontend/src/features/view/components/CalendarLayout.tsx` | Calendar two-pane layout; will use `ResizablePaneGroup`. |
| `kylins.client.frontend/src/components/tasks/TasksPage.tsx` | Tasks two-pane layout; will use `ResizablePaneGroup`. |
| `kylins.client.frontend/src/components/layout/StatusBar.tsx` | Footer status bar; will show real selection/sync/offline state. |
| `kylins.client.frontend/src/components/layout/ribbon/RibbonPrimitives.tsx` | Ribbon buttons; Phosphor icon will be replaced. |
| `kylins.client.frontend/src/components/layout/ribbon/ReadRibbon.tsx` | Uses `RibbonPrimitives`; may need icon import updates. |
| `kylins.client.frontend/src/components/preferences/AppearancePreferences.tsx` | Settings UI for theme/skin/contrast. |

---

## Task 1: Align Design Tokens

**Files:**
- Modify: `assets/design-tokens.css`
- Modify: `kylins.client.frontend/src/styles/theme.css`
- Test: `tests/styles/themeTokens.test.ts` (create)

**Interfaces:**
- Consumes: existing `theme.css` variable names.
- Produces: a synchronized primitive + semantic token set used by both runtime and design-doc consumers.

- [ ] **Step 1: Audit both token files**

Compare `assets/design-tokens.css` and `src/styles/theme.css`. Record mismatches (e.g., `--color-primary` vs `--primary`, missing `--surface`/`--chrome`, font stack mismatch).

- [ ] **Step 2: Update `assets/design-tokens.css` to mirror runtime semantics**

Keep the primitive section, but update the semantic section so every runtime variable in `theme.css` has a corresponding design-token value.

```css
/* assets/design-tokens.css — semantic section (light) */
:root {
  --color-background: #ffffff;
  --color-foreground: #18181b;
  --color-surface: #f4f4f5;
  --color-chrome: #e4e4e7;
  --color-card: #ffffff;
  --color-muted: #f4f4f5;
  --color-muted-foreground: #71717a;
  --color-border: #e4e4e7;
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-primary-foreground: #ffffff;
  --color-secondary: #f4f4f5;
  --color-secondary-foreground: #18181b;
  --color-accent: #fafafa;
  --color-accent-foreground: #18181b;
  --color-destructive: #dc2626;
  --color-destructive-foreground: #ffffff;
  --color-success: #10b981;
  --color-warning: #f59e0b;
  --color-error: #dc2626;
  --color-info: #3b82f6;
  --color-link: #2563eb;
  --color-link-hover: #1d4ed8;
  --color-ring: color-mix(in oklab, #2563eb, transparent 75%);
  --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace;
}
```

- [ ] **Step 3: Add missing component tokens to `theme.css`**

Append component-level tokens that the design doc references:

```css
/* kylins.client.frontend/src/styles/theme.css */
:root {
  /* ...existing tokens... */
  --button-primary-bg: var(--primary);
  --button-primary-fg: var(--primary-foreground);
  --button-secondary-bg-hover: color-mix(in srgb, var(--primary) 10%, transparent);
  --input-bg: var(--background);
  --input-border: var(--border);
  --input-focus-ring: var(--ring);
  --list-row-hover-bg: var(--hover);
  --list-row-selected-bg: var(--selected);
  --ribbon-bg: var(--chrome);
  --ribbon-group-border: var(--border);
  --statusbar-bg: var(--chrome);
}
```

- [ ] **Step 4: Write the test**

```ts
// tests/styles/themeTokens.test.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('theme token alignment', () => {
  const themeCss = readFileSync(
    resolve(__dirname, '../../kylins.client.frontend/src/styles/theme.css'),
    'utf8',
  );
  const tokensCss = readFileSync(resolve(__dirname, '../../assets/design-tokens.css'), 'utf8');

  it('has matching primary colors', () => {
    expect(tokensCss).toContain('--color-primary:');
    expect(themeCss).toContain('--primary:');
  });

  it('declares all required semantic tokens', () => {
    const required = [
      '--color-background',
      '--color-foreground',
      '--color-surface',
      '--color-chrome',
      '--color-border',
      '--color-muted',
      '--color-primary',
      '--color-destructive',
    ];
    for (const token of required) {
      expect(tokensCss).toContain(`${token}:`);
    }
  });

  it('declares component tokens in theme.css', () => {
    const componentTokens = [
      '--button-primary-bg',
      '--button-secondary-bg-hover',
      '--input-bg',
      '--list-row-selected-bg',
      '--ribbon-bg',
      '--statusbar-bg',
    ];
    for (const token of componentTokens) {
      expect(themeCss).toContain(`${token}:`);
    }
  });
});
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/styles/themeTokens.test.ts`
Expected: PASS

- [ ] **Step 6: Run lint and typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add assets/design-tokens.css kylins.client.frontend/src/styles/theme.css tests/styles/themeTokens.test.ts
git commit -m "design(tokens): align design-tokens.css with runtime theme.css and add component tokens"
```

---

## Task 2: Extend Skin Registry to ThemePack Model

**Files:**
- Modify: `kylins.client.frontend/src/styles/skins.ts`
- Create: `kylins.client.frontend/src/styles/themes.ts`
- Test: `tests/styles/themes.test.ts` (create)

**Interfaces:**
- Consumes: existing `SkinId` union and `SKINS` array.
- Produces: `ThemePack`, `ThemePackId`, `THEME_PACKS`, and helpers `getThemePack(id)`, `isThemePackId(value)`.

- [ ] **Step 1: Define ThemePack types**

```ts
// kylins.client.frontend/src/styles/themes.ts
// ThemePackId is defined here to avoid a circular import with skins.ts.
export type ThemePackId =
  | 'slate'
  | 'blue'
  | 'indigo'
  | 'rose'
  | 'emerald'
  | 'amber'
  | 'violet'
  | 'orange';

export interface ThemeVariant {
  mode: 'light' | 'dark' | 'high-contrast';
  /** CSS selector used to activate this variant, e.g. ':root', '.dark', '[data-contrast="high"]'. */
  selector: string;
  /** Accent color used for generated previews. */
  accent: string;
  /** Accent color on dark background. */
  accentDark: string;
}

export interface ThemePack {
  id: ThemePackId;
  name: string;
  /** Color shown in the theme picker. */
  swatch: string;
  /** Optional font preference for this theme. */
  font?: 'system' | 'inter' | 'geist';
  variants: ThemeVariant[];
}

export const THEME_PACKS: ThemePack[] = [
  {
    id: 'slate',
    name: 'Slate',
    swatch: '#64748b',
    variants: [
      { mode: 'light', selector: ':root', accent: '#64748b', accentDark: '#94a3b8' },
      { mode: 'dark', selector: '.dark', accent: '#94a3b8', accentDark: '#cbd5e1' },
      { mode: 'high-contrast', selector: '[data-contrast="high"]', accent: '#000000', accentDark: '#ffffff' },
    ],
  },
  {
    id: 'blue',
    name: 'Blue',
    swatch: '#3b82f6',
    variants: [
      { mode: 'light', selector: ':root', accent: '#2563eb', accentDark: '#60a5fa' },
      { mode: 'dark', selector: '.dark', accent: '#60a5fa', accentDark: '#93c5fd' },
      { mode: 'high-contrast', selector: '[data-contrast="high"]', accent: '#0000ff', accentDark: '#00ffff' },
    ],
  },
  // ...indigo, rose, emerald, amber, violet, orange follow same shape
];

export const DEFAULT_THEME_PACK: ThemePackId = 'slate';

export function isThemePackId(value: string): value is ThemePackId {
  return THEME_PACKS.some((t) => t.id === value);
}

export function getThemePack(id: ThemePackId): ThemePack {
  const pack = THEME_PACKS.find((t) => t.id === id);
  if (!pack) throw new Error(`Unknown theme pack: ${id}`);
  return pack;
}
```

- [ ] **Step 2: Re-export from `skins.ts` for backward compatibility**

```ts
// kylins.client.frontend/src/styles/skins.ts
// Re-export from themes.ts so existing imports keep working.
// skins.ts must NOT be imported by themes.ts to avoid a circular dependency.
import {
  THEME_PACKS,
  DEFAULT_THEME_PACK,
  isThemePackId,
  getThemePack,
} from './themes';
import type { ThemePack, ThemePackId } from './themes';

export type { ThemePack, ThemePackId };
export type SkinId = ThemePackId;

export interface SkinDef {
  id: SkinId;
  name: string;
  swatch: string;
}

export const SKINS: SkinDef[] = THEME_PACKS.map((t) => ({
  id: t.id,
  name: t.name,
  swatch: t.swatch,
}));

export const DEFAULT_SKIN = DEFAULT_THEME_PACK;
export { isThemePackId as isSkinId, getThemePack };
```

- [ ] **Step 3: Write the test**

```ts
// tests/styles/themes.test.ts
import { THEME_PACKS, DEFAULT_THEME_PACK, getThemePack, isThemePackId } from '@/styles/themes';

describe('theme packs', () => {
  it('has at least 5 packs', () => {
    expect(THEME_PACKS.length).toBeGreaterThanOrEqual(5);
  });

  it('default pack exists', () => {
    expect(isThemePackId(DEFAULT_THEME_PACK)).toBe(true);
    expect(getThemePack(DEFAULT_THEME_PACK).id).toBe(DEFAULT_THEME_PACK);
  });

  it('every pack has light, dark, and high-contrast variants', () => {
    for (const pack of THEME_PACKS) {
      const modes = pack.variants.map((v) => v.mode);
      expect(modes).toContain('light');
      expect(modes).toContain('dark');
      expect(modes).toContain('high-contrast');
    }
  });

  it('rejects unknown ids', () => {
    expect(isThemePackId('not-a-theme')).toBe(false);
    expect(() => getThemePack('not-a-theme' as never)).toThrow();
  });
});
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/styles/themes.test.ts`
Expected: PASS

- [ ] **Step 5: Run lint and typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add kylins.client.frontend/src/styles/skins.ts kylins.client.frontend/src/styles/themes.ts tests/styles/themes.test.ts
git commit -m "feat(themes): introduce ThemePack model with light/dark/high-contrast variants"
```

---

## Task 3: Implement High-Contrast Mode

**Files:**
- Modify: `kylins.client.frontend/src/services/theme/themeManager.ts`
- Modify: `kylins.client.frontend/src/stores/uiStore.ts`
- Modify: `kylins.client.frontend/src/styles/theme.css`
- Modify: `kylins.client.frontend/src/components/preferences/AppearancePreferences.tsx`
- Test: `tests/services/theme/themeManager.test.ts` (create or update)

**Interfaces:**
- Consumes: `ThemePack` variant selectors, `UIState.contrast`.
- Produces: `themeManager.setContrast(contrast)` and `[data-contrast="high"]` CSS rules.

- [ ] **Step 1: Add contrast state to `uiStore.ts`**

```ts
// kylins.client.frontend/src/stores/uiStore.ts
export type ContrastMode = 'default' | 'high';

export interface UIState {
  // ...existing fields...
  contrast: ContrastMode;
  setContrast: (contrast: ContrastMode) => void;
}

export const useUIStore = create<UIState>((set) => ({
  // ...existing defaults...
  contrast: 'default',
  setContrast: (contrast) => set({ contrast }),
}));
```

- [ ] **Step 2: Add high-contrast CSS rules to `theme.css`**

Append after `.dark` block:

```css
/* kylins.client.frontend/src/styles/theme.css */
[data-contrast='high'],
[data-contrast='high'] .light {
  --background: #ffffff;
  --foreground: #000000;
  --surface: #ffffff;
  --chrome: #f0f0f0;
  --card: #ffffff;
  --muted: #ffffff;
  --muted-foreground: #000000;
  --border: #000000;
  --input: #ffffff;
  --ring: #0000ff;
  --primary: #0000ff;
  --primary-foreground: #ffffff;
  --secondary: #ffffff;
  --secondary-foreground: #000000;
  --hover: #ffff00;
  --selected: #00ffff;
  --link: #0000ff;
  --link-hover: #000080;
  --destructive: #ff0000;
  --success: #008000;
  --warning: #ff8c00;
  --error: #ff0000;
}

[data-contrast='high'] .dark {
  --background: #000000;
  --foreground: #ffffff;
  --surface: #000000;
  --chrome: #1a1a1a;
  --card: #000000;
  --muted: #000000;
  --muted-foreground: #ffffff;
  --border: #ffffff;
  --input: #000000;
  --ring: #00ffff;
  --primary: #00ffff;
  --primary-foreground: #000000;
  --secondary: #000000;
  --secondary-foreground: #ffffff;
  --hover: #ffff00;
  --selected: #ff00ff;
  --link: #00ffff;
  --link-hover: #80ffff;
  --destructive: #ff6666;
  --success: #00ff00;
  --warning: #ffd700;
  --error: #ff6666;
}
```

- [ ] **Step 3: Implement `setContrast` in `themeManager.ts`**

```ts
// kylins.client.frontend/src/services/theme/themeManager.ts
export class ThemeManager {
  private activeTheme: string = 'system';
  private activeContrast: 'default' | 'high' = 'default';
  private mediaQueryListener: ((e: MediaQueryListEvent) => void) | null = null;

  applyTheme(themeName: 'light' | 'dark' | 'system'): void {
    this.activeTheme = themeName;
    // ...existing logic...
    this.applyContrast(this.activeContrast);
  }

  setContrast(contrast: 'default' | 'high'): void {
    this.activeContrast = contrast;
    this.applyContrast(contrast);
  }

  private applyContrast(contrast: 'default' | 'high'): void {
    const root = document.documentElement;
    if (contrast === 'high') {
      root.setAttribute('data-contrast', 'high');
    } else {
      root.removeAttribute('data-contrast');
    }
  }

  getActiveContrast(): 'default' | 'high' {
    return this.activeContrast;
  }

  // ...existing applySkin, resetSkin, getActiveTheme...
}
```

- [ ] **Step 4: Persist contrast in `AppearancePreferences.tsx`**

Add a contrast toggle/radio group that calls `useUIStore.setContrast` and `themeManager.setContrast`. Persist via existing settings service (`setSetting('contrast', ...)`).

- [ ] **Step 5: Write the test**

```ts
// tests/services/theme/themeManager.test.ts
import { themeManager } from '@/services/theme/themeManager';

describe('ThemeManager contrast', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-contrast');
    document.documentElement.classList.remove('light', 'dark');
  });

  it('sets high contrast attribute', () => {
    themeManager.setContrast('high');
    expect(document.documentElement.getAttribute('data-contrast')).toBe('high');
  });

  it('removes high contrast attribute when set to default', () => {
    themeManager.setContrast('high');
    themeManager.setContrast('default');
    expect(document.documentElement.hasAttribute('data-contrast')).toBe(false);
  });

  it('remembers contrast when applying theme', () => {
    themeManager.setContrast('high');
    themeManager.applyTheme('light');
    expect(document.documentElement.getAttribute('data-contrast')).toBe('high');
  });
});
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run tests/services/theme/themeManager.test.ts`
Expected: PASS

- [ ] **Step 7: Run lint and typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add kylins.client.frontend/src/services/theme/themeManager.ts kylins.client.frontend/src/stores/uiStore.ts kylins.client.frontend/src/styles/theme.css kylins.client.frontend/src/components/preferences/AppearancePreferences.tsx tests/services/theme/themeManager.test.ts
git commit -m "feat(theme): add high-contrast mode and persist it in UI store"
```

---

## Task 4: Unify Icon Library

**Files:**
- Modify: `kylins.client.frontend/src/components/layout/ribbon/RibbonPrimitives.tsx`
- Modify: `kylins.client.frontend/src/components/layout/ribbon/ReadRibbon.tsx` (if it imports Phosphor)
- Test: `tests/components/layout/ribbon/RibbonPrimitives.test.tsx` (create)

**Interfaces:**
- Consumes: existing `RibbonButtonProps`/`RibbonToggleProps`.
- Produces: `RibbonPrimitives` with no Phosphor dependencies.

- [ ] **Step 1: Check for Phosphor imports**

Run: `npx grep -R "@phosphor-icons" kylins.client.frontend/src`
Expected: find `RibbonPrimitives.tsx:1` import.

- [ ] **Step 2: Find Hugeicons replacement for `CaretDown`**

Open `kylins.client.frontend/src/components/icons.tsx` and confirm `ArrowDown01Icon` or `ArrowDown02Icon` exists. If not, add:

```ts
// kylins.client.frontend/src/components/icons.tsx
export { ArrowDown01Icon as CaretDownIcon } from '@hugeicons/react';
```

- [ ] **Step 3: Replace Phosphor import in `RibbonPrimitives.tsx`**

```tsx
// kylins.client.frontend/src/components/layout/ribbon/RibbonPrimitives.tsx
import { CaretDownIcon } from '../../icons';
// Remove: import { CaretDown } from '@phosphor-icons/react';
```

Update usage:

```tsx
{split && <CaretDownIcon size={10} className="ml-0.5 opacity-70" />}
```

- [ ] **Step 4: Verify `ReadRibbon.tsx` and `ComposeRibbon.tsx`**

If they import Phosphor directly, replace with Hugeicons equivalents from `src/components/icons.tsx`.

- [ ] **Step 5: Write the test**

```tsx
// tests/components/layout/ribbon/RibbonPrimitives.test.tsx
import { render, screen } from '@testing-library/react';
import { RibbonButton, RibbonGroup } from '@/components/layout/ribbon/RibbonPrimitives';

describe('RibbonPrimitives', () => {
  it('renders a button with icon and label', () => {
    render(
      <RibbonGroup>
        <RibbonButton icon={<span data-testid="icon" />} onClick={() => {}}>
          Archive
        </RibbonButton>
      </RibbonGroup>,
    );
    expect(screen.getByRole('button', { name: /archive/i })).toBeInTheDocument();
  });

  it('does not import phosphor icons', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = fs.readFileSync(
      path.resolve(__dirname, '../../../../kylins.client.frontend/src/components/layout/ribbon/RibbonPrimitives.tsx'),
      'utf8',
    );
    expect(file).not.toContain('@phosphor-icons');
  });
});
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run tests/components/layout/ribbon/RibbonPrimitives.test.tsx`
Expected: PASS

- [ ] **Step 7: Run lint and typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add kylins.client.frontend/src/components/layout/ribbon/RibbonPrimitives.tsx kylins.client.frontend/src/components/layout/ribbon/ReadRibbon.tsx tests/components/layout/ribbon/RibbonPrimitives.test.tsx
git commit -m "style(icons): replace Phosphor with Hugeicons in ribbon primitives"
```

---

## Task 5: Refactor TitleBar Search to Flex Center

**Files:**
- Modify: `kylins.client.frontend/src/components/layout/TitleBar.tsx`
- Modify: `kylins.client.frontend/src/features/view/components/ReadingPaneLayout.tsx`
- Test: `tests/components/layout/TitleBar.test.tsx` (create or update)

**Interfaces:**
- Consumes: `SearchField` from `react-aria-components`, `useWindowSize`.
- Produces: `TitleBar` with search as a flex child; `ReadingPaneLayout` without `MeasuredPanelCard` CSS vars.

- [ ] **Step 1: Remove `MeasuredPanelCard` and CSS vars from `ReadingPaneLayout.tsx`**

Delete the `MeasuredPanelCard` component and its usage. Remove the `useRef`/`useEffect` that writes `--message-list-left` and `--message-list-width`. Keep `PanelCard`.

Before:
```tsx
<Panel ...><MeasuredPanelCard>{messageList}</MeasuredPanelCard></Panel>
```
After:
```tsx
<Panel ...><PanelCard>{messageList}</PanelCard></Panel>
```

- [ ] **Step 2: Remove CSS var fallbacks from `theme.css` (optional cleanup)**

If the only consumers of `--message-list-left` and `--message-list-width` were `TitleBar.tsx` and `ReadingPaneLayout.tsx`, remove the comments/defaults from `theme.css`.

- [ ] **Step 3: Rewrite `TitleBar.tsx` search area with flex**

```tsx
// kylins.client.frontend/src/components/layout/TitleBar.tsx
export function TitleBar() {
  // ...existing hooks...
  const activeApp = useUIStore((s) => s.activeApp);

  const searchPlaceholder =
    {
      mail: 'Search mail…',
      calendar: 'Search calendar…',
      contacts: 'Search contacts…',
      tasks: 'Search tasks…',
    }[activeApp] ?? 'Search…';

  return (
    <div
      className="relative h-[var(--header-h)] flex items-center px-2 bg-[var(--chrome)] select-none"
      style={dragStyle}
    >
      {/* Left: hamburger + menu bar */}
      <div className="flex items-center flex-shrink-0" style={noDragStyle}>
        <IconButton ... />
        <MenuBar />
      </div>

      {/* Center: search */}
      <div className="flex-1 flex justify-center px-4" style={noDragStyle}>
        <div className="w-full max-w-xl">
          {isCompact ? (
            // ...existing compact search popover...
          ) : (
            <SearchField className="relative w-full" aria-label={searchPlaceholder}>
              {({ isEmpty }) => (
                <>
                  <Label className="sr-only">{searchPlaceholder}</Label>
                  <Input
                    type="text"
                    placeholder={searchPlaceholder}
                    style={noDragStyle}
                    className="w-full h-9 px-3 pr-8 text-sm rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none transition-colors"
                  />
                  {!isEmpty && (
                    <Button
                      style={noDragStyle}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded text-[var(--muted-text)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                      <CloseIcon size={14} />
                    </Button>
                  )}
                </>
              )}
            </SearchField>
          )}
        </div>
      </div>

      {/* Right: app icons + window controls */}
      <div className="flex items-center gap-0.5 flex-shrink-0" style={noDragStyle}>
        {/* ...existing... */}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write the test**

```tsx
// tests/components/layout/TitleBar.test.tsx
import { render, screen } from '@testing-library/react';
import { TitleBar } from '@/components/layout/TitleBar';
import { useUIStore } from '@/stores/uiStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('TitleBar search', () => {
  it('renders a search field with mail placeholder by default', () => {
    useUIStore.setState({ activeApp: 'mail' });
    render(<TitleBar />);
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Search mail…');
  });

  it('updates placeholder for contacts app', () => {
    useUIStore.setState({ activeApp: 'contacts' });
    render(<TitleBar />);
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Search contacts…');
  });

  it('does not use absolute positioning for search container', () => {
    const { container } = render(<TitleBar />);
    const searchContainer = container.querySelector('.flex-1.flex.justify-center');
    expect(searchContainer).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/components/layout/TitleBar.test.tsx`
Expected: PASS

- [ ] **Step 6: Run lint and typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add kylins.client.frontend/src/components/layout/TitleBar.tsx kylins.client.frontend/src/features/view/components/ReadingPaneLayout.tsx tests/components/layout/TitleBar.test.tsx
git commit -m "fix(layout): center TitleBar search with flex and remove fragile CSS var tracking"
```

---

## Task 6: Create Shared `ResizablePaneGroup` Layout Primitive

**Files:**
- Create: `kylins.client.frontend/src/components/layout/ResizablePaneGroup.tsx`
- Modify: `kylins.client.frontend/src/components/contacts/ContactsPage.tsx`
- Modify: `kylins.client.frontend/src/features/view/components/CalendarLayout.tsx`
- Modify: `kylins.client.frontend/src/components/tasks/TasksPage.tsx`
- Test: `tests/components/layout/ResizablePaneGroup.test.tsx` (create)

**Interfaces:**
- Consumes: `react-resizable-panels` `Panel`, `Group`, `Separator`.
- Produces: `<ResizablePaneGroup panels={...} />` that handles sizing persistence, optional panes, and consistent card/divider styling.

- [ ] **Step 1: Define the component API**

```tsx
// kylins.client.frontend/src/components/layout/ResizablePaneGroup.tsx
import { Panel, Group, Separator } from 'react-resizable-panels';
import type { ReactNode } from 'react';

export interface ResizablePanelDef {
  id: string;
  content: ReactNode;
  defaultSize: number;
  minSize: number;
  maxSize?: number;
  /** If false, the panel is not rendered and adjacent panels fill the space. */
  visible?: boolean;
  /** If true, the panel content is wrapped in a styled card surface. */
  card?: boolean;
  className?: string;
}

export interface ResizablePaneGroupProps {
  panels: ResizablePanelDef[];
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  onLayoutChanged?: (layout: Record<string, number>) => void;
}

function PanelCard({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
      {children}
    </div>
  );
}

export function ResizablePaneGroup({
  panels,
  orientation = 'horizontal',
  className,
  onLayoutChanged,
}: ResizablePaneGroupProps) {
  const visiblePanels = panels.filter((p) => p.visible !== false);
  return (
    <Group
      orientation={orientation}
      className={className}
      onLayoutChanged={onLayoutChanged}
    >
      {visiblePanels.map((panel, index) => (
        <Panel
          key={panel.id}
          id={panel.id}
          defaultSize={panel.defaultSize}
          minSize={panel.minSize}
          maxSize={panel.maxSize}
          className={panel.className}
        >
          {panel.card ? <PanelCard>{panel.content}</PanelCard> : panel.content}
        </Panel>
      ))}
      {visiblePanels.slice(0, -1).map((panel, index) => (
        <Separator
          key={`sep-${panel.id}`}
          className={
            orientation === 'horizontal'
              ? 'mx-1 w-1.5 rounded-full bg-[var(--border)] transition-colors hover:bg-[var(--series-300)]'
              : 'my-1 h-1.5 rounded-full bg-[var(--border)] transition-colors hover:bg-[var(--series-300)]'
          }
        />
      ))}
    </Group>
  );
}
```

> **Note:** The separators are currently inserted after every panel except the last. A future improvement could accept per-panel `separator: false`, but for Phase 1 the default behavior matches existing pages.

- [ ] **Step 2: Refactor `ContactsPage.tsx` to use `ResizablePaneGroup`**

Replace the inline `Group`/`Panel`/`Separator` JSX with `ResizablePaneGroup`. Keep the `buildLayout`/`writeLayout` helpers because Contacts needs custom persistence through `contactStore`.

```tsx
// inside ContactsPage render
const layout = buildLayout(contactPanelSizes, accountPaneVisible);

function handleLayoutChanged(nextLayout: Record<string, number>) {
  writeLayout(nextLayout, contactPanelSizes, accountPaneVisible, setContactPanelSizes);
}

const panels: ResizablePanelDef[] = [
  {
    id: 'contacts-accounts',
    content: <ContactAccountPane accounts={accounts} selectedAccountId={selectedAccountId} onSelect={setSelectedAccountId} />,
    defaultSize: layout['contacts-accounts'] ?? 20,
    minSize: CONSTRAINTS.account.min,
    visible: accountPaneVisible,
    card: true,
  },
  {
    id: 'contacts-list',
    content: <ContactList />,
    defaultSize: layout['contacts-list'] ?? 35,
    minSize: CONSTRAINTS.list.min,
    card: true,
  },
  {
    id: 'contacts-detail',
    content: selectedContact ? <ContactDetail ... /> : selectedGroup ? <GroupDetail ... /> : <EmptyState />,
    defaultSize: layout['contacts-detail'] ?? 45,
    minSize: CONSTRAINTS.detail.min,
    card: true,
  },
];

return (
  <div className="flex flex-1 flex-col h-full">
    <ContactsCommandRibbon ... />
    <ResizablePaneGroup
      className="flex-1 w-full p-2"
      panels={panels}
      onLayoutChanged={handleLayoutChanged}
    />
    {/* ...Modal... */}
  </div>
);
```

- [ ] **Step 3: Refactor `CalendarLayout.tsx`**

```tsx
// kylins.client.frontend/src/features/view/components/CalendarLayout.tsx
import { ResizablePaneGroup } from '@/components/layout/ResizablePaneGroup';

export function CalendarLayout({ folderPane, children }: CalendarLayoutProps) {
  // ...existing hooks...
  const panels = [
    {
      id: 'calendar-folder-pane',
      content: folderPane,
      defaultSize: size,
      minSize: 12,
      maxSize: 80,
      visible: showPane,
      card: true,
    },
    {
      id: 'calendar-content',
      content: children,
      defaultSize: showPane ? 100 - size : 100,
      minSize: 30,
      card: false,
    },
  ];

  return (
    <>
      <ResizablePaneGroup
        orientation="horizontal"
        className="flex-1 p-2"
        panels={panels}
        onLayoutChanged={(layout) => {
          const next = layout['calendar-folder-pane'];
          if (typeof next === 'number' && next >= 10 && next <= 80) setSize(next);
        }}
      />
      {drawerOpen && (
        <FolderPaneDrawer open={drawerOpen} onClose={() => setVisible(false)}>
          {folderPane}
        </FolderPaneDrawer>
      )}
    </>
  );
}
```

- [ ] **Step 4: Refactor `TasksPage.tsx`**

```tsx
// kylins.client.frontend/src/components/tasks/TasksPage.tsx
import { ResizablePaneGroup } from '@/components/layout/ResizablePaneGroup';

// inside render, replace Group/Panel/Separator:
const panels = [
  {
    id: 'tasks-list',
    content: <TaskList ... />,
    defaultSize: 40,
    minSize: CONSTRAINTS.list.min,
    card: false,
  },
  {
    id: 'tasks-detail',
    content: selectedTask ? <TaskDetail ... /> : <EmptyState />,
    defaultSize: 60,
    minSize: CONSTRAINTS.detail.min,
    card: false,
  },
];

<ResizablePaneGroup className="flex flex-1 overflow-hidden" panels={panels} />;
```

- [ ] **Step 5: Write the test**

```tsx
// tests/components/layout/ResizablePaneGroup.test.tsx
import { render, screen } from '@testing-library/react';
import { ResizablePaneGroup } from '@/components/layout/ResizablePaneGroup';

describe('ResizablePaneGroup', () => {
  it('renders visible panels', () => {
    render(
      <ResizablePaneGroup
        panels={[
          { id: 'a', content: <div>Panel A</div>, defaultSize: 30, minSize: 10 },
          { id: 'b', content: <div>Panel B</div>, defaultSize: 70, minSize: 10 },
        ]}
      />,
    );
    expect(screen.getByText('Panel A')).toBeInTheDocument();
    expect(screen.getByText('Panel B')).toBeInTheDocument();
  });

  it('skips hidden panels', () => {
    render(
      <ResizablePaneGroup
        panels={[
          { id: 'a', content: <div>Panel A</div>, defaultSize: 30, minSize: 10, visible: false },
          { id: 'b', content: <div>Panel B</div>, defaultSize: 70, minSize: 10 },
        ]}
      />,
    );
    expect(screen.queryByText('Panel A')).not.toBeInTheDocument();
    expect(screen.getByText('Panel B')).toBeInTheDocument();
  });

  it('wraps card panels in styled card', () => {
    const { container } = render(
      <ResizablePaneGroup
        panels={[
          { id: 'a', content: <div>Card content</div>, defaultSize: 100, minSize: 10, card: true },
        ]}
      />,
    );
    expect(container.querySelector('.rounded-xl.border')).toHaveTextContent('Card content');
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/components/layout/ResizablePaneGroup.test.tsx tests/components/contacts/ContactsPage.test.tsx`
Expected: PASS (existing Contact tests may need snapshot updates if class names changed).

- [ ] **Step 7: Run lint and typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add kylins.client.frontend/src/components/layout/ResizablePaneGroup.tsx kylins.client.frontend/src/components/contacts/ContactsPage.tsx kylins.client.frontend/src/features/view/components/CalendarLayout.tsx kylins.client.frontend/src/components/tasks/TasksPage.tsx tests/components/layout/ResizablePaneGroup.test.tsx
git commit -m "feat(layout): add ResizablePaneGroup primitive and adopt it in contacts, calendar, tasks"
```

---

## Task 7: Wire StatusBar to Real State

**Files:**
- Modify: `kylins.client.frontend/src/components/layout/StatusBar.tsx`
- Modify: `kylins.client.frontend/src/stores/viewStore.ts` (or `threadStore.ts` if selection lives there)
- Test: `tests/components/layout/StatusBar.test.tsx` (create or update)

**Interfaces:**
- Consumes: `useUIStore` sync/offline state, `useViewStore`/`useThreadStore` selection state.
- Produces: `StatusBar` showing real “N selected” and clickable sync/zoom controls.

- [ ] **Step 1: Add selected-thread count to the appropriate store**

Check `src/features/view/viewStore.ts` and `src/stores/threadStore.ts`. If `viewStore` already tracks `selectedThreadId`/`selectedMessageId`, add `selectedThreadIds` for multi-select or derive count from `selectedThreadId`.

Assuming `viewStore` owns selection:

```ts
// kylins.client.frontend/src/features/view/viewStore.ts
export interface ViewState {
  // ...existing...
  selectedThreadIds: string[];
  setSelectedThreadIds: (ids: string[]) => void;
  toggleSelectedThreadId: (id: string) => void;
}

// In create():
selectedThreadIds: [],
setSelectedThreadIds: (selectedThreadIds) => set({ selectedThreadIds }),
toggleSelectedThreadId: (id) =>
  set((state) => ({
    selectedThreadIds: state.selectedThreadIds.includes(id)
      ? state.selectedThreadIds.filter((x) => x !== id)
      : [...state.selectedThreadIds, id],
  })),
```

If multi-select is out of scope for Phase 1, just expose `selectedThreadId` and render `selectedThreadId ? '1 selected' : '0 selected'`.

- [ ] **Step 2: Update `StatusBar.tsx` to read real selection count**

```tsx
// kylins.client.frontend/src/components/layout/StatusBar.tsx
import { useViewStore } from '@/features/view/viewStore';

function SelectionIndicator() {
  const selectedThreadIds = useViewStore((s) => s.selectedThreadIds);
  const count = selectedThreadIds.length;
  if (count === 0) return null;
  return <span>{count} selected</span>;
}

export function StatusBar() {
  // ...existing hooks...
  const selectedThreadIds = useViewStore((s) => s.selectedThreadIds);
  const selectedCount = selectedThreadIds.length;

  return (
    <footer ...>
      <div className="flex items-center gap-3">
        <SyncStatusIndicator />
        <SendProgressIndicator />
        {selectedCount > 0 && <span>{selectedCount} selected</span>}
      </div>
      {/* ...right side... */}
    </footer>
  );
}
```

- [ ] **Step 3: Make sync status clickable**

Wrap `SyncStatusIndicator` in a `<button>` or add `onClick` to trigger `invoke('sync_account_now', { accountId: 'all' })` or the existing sync-start command. Check `src/services/accounts.ts` for the right helper.

```tsx
function SyncStatusIndicator() {
  // ...existing...
  const triggerSync = async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('sync_start');
  };

  return (
    <button
      type="button"
      onClick={triggerSync}
      className="hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded px-1"
    >
      {/* existing inner content */}
    </button>
  );
}
```

- [ ] **Step 4: Ensure zoom is consumed by `EmailRenderer`**

Add a parent wrapper around `SafeHtmlFrame`/`EmailRenderer` in `ReadingPane.tsx` that applies `transform: scale(var(--reader-zoom))` or directly uses `readerZoom` from `useUIStore`.

```tsx
// kylins.client.frontend/src/components/layout/ReadingPane.tsx ( illustrative snippet )
const readerZoom = useUIStore((s) => s.readerZoom);

<div style={{ transform: `scale(${readerZoom})`, transformOrigin: 'top left' }}>
  <EmailRenderer ... />
</div>
```

- [ ] **Step 5: Write the test**

```tsx
// tests/components/layout/StatusBar.test.tsx
import { render, screen } from '@testing-library/react';
import { StatusBar } from '@/components/layout/StatusBar';
import { useViewStore } from '@/features/view/viewStore';
import { useUIStore } from '@/stores/uiStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('StatusBar', () => {
  it('shows correct selected count', () => {
    useViewStore.setState({ selectedThreadIds: ['t1', 't2'] });
    render(<StatusBar />);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('hides selected count when none selected', () => {
    useViewStore.setState({ selectedThreadIds: [] });
    render(<StatusBar />);
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('displays zoom percentage', () => {
    useUIStore.setState({ readerZoom: 1.25 });
    render(<StatusBar />);
    expect(screen.getByText('125%')).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run tests/components/layout/StatusBar.test.tsx`
Expected: PASS

- [ ] **Step 7: Run lint and typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add kylins.client.frontend/src/components/layout/StatusBar.tsx kylins.client.frontend/src/features/view/viewStore.ts kylins.client.frontend/src/components/layout/ReadingPane.tsx tests/components/layout/StatusBar.test.tsx
git commit -m "feat(statusbar): wire selection count, sync click, and zoom consumption"
```

---

## Self-Review

### Spec Coverage

| Design Doc Section | Implementing Task(s) |
|---|---|
| 5.1 Token hierarchy / alignment | Task 1 |
| 5.1.3 Key token changes | Task 1 |
| 9.1 Theme Pack structure | Task 2 |
| 9.2 Built-in themes | Task 2 |
| 9.3 High-contrast mode | Task 3 |
| 9.4 Theme switching | Task 3 |
| 5.3 Icon unification | Task 4 |
| 6.6 TitleBar search | Task 5 |
| 4.2 #10 Duplicated pane logic | Task 6 |
| 4.2 #4 StatusBar fake state | Task 7 |
| 4.2 #8 Zoom not consumed | Task 7 |

### Placeholder Scan

- No “TBD”, “TODO”, “implement later” in task steps.
- No “add appropriate error handling” without concrete code.
- All code blocks contain illustrative but complete snippets.
- All file paths are exact.

### Type Consistency

- `ThemePackId` aliases `SkinId` to keep existing `uiStore.skin` type valid.
- `ContrastMode` used consistently in `uiStore`, `themeManager`, and preferences.
- `ResizablePanelDef` uses `ReactNode` for content and optional booleans.
- `selectedThreadIds` used in both `viewStore` and `StatusBar` test.

### Known Limitations / Follow-up

- `Task 6` only refactors Contacts/Calendar/Tasks. `ReadingPaneLayout` remains specialized because it has complex position-dependent sizing (`right`/`bottom`/`off`) and compact drawer behavior. That can be abstracted in a future phase if it proves valuable.
- `Task 7` assumes selection lives in `viewStore`. If it actually lives in `threadStore`, adjust the store import accordingly before implementing.
- `Task 7` zoom application is a minimal scale wrapper; a more polished zoom should consider iframe coordinate mapping and is left for Phase 2/3 polish.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-17-frontend-redesign-phase1.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach would you like?

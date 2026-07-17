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
      {
        mode: 'high-contrast',
        selector: '[data-contrast="high"]',
        accent: '#000000',
        accentDark: '#ffffff',
      },
    ],
  },
  {
    id: 'blue',
    name: 'Blue',
    swatch: '#3b82f6',
    variants: [
      { mode: 'light', selector: ':root', accent: '#2563eb', accentDark: '#60a5fa' },
      { mode: 'dark', selector: '.dark', accent: '#60a5fa', accentDark: '#93c5fd' },
      {
        mode: 'high-contrast',
        selector: '[data-contrast="high"]',
        accent: '#0000ff',
        accentDark: '#00ffff',
      },
    ],
  },
  {
    id: 'indigo',
    name: 'Indigo',
    swatch: '#6366f1',
    variants: [
      { mode: 'light', selector: ':root', accent: '#4f46e5', accentDark: '#818cf8' },
      { mode: 'dark', selector: '.dark', accent: '#818cf8', accentDark: '#a5b4fc' },
      {
        mode: 'high-contrast',
        selector: '[data-contrast="high"]',
        accent: '#0000ff',
        accentDark: '#bfdbfe',
      },
    ],
  },
  {
    id: 'rose',
    name: 'Rose',
    swatch: '#f43f5e',
    variants: [
      { mode: 'light', selector: ':root', accent: '#e11d48', accentDark: '#fb7185' },
      { mode: 'dark', selector: '.dark', accent: '#fb7185', accentDark: '#fda4af' },
      {
        mode: 'high-contrast',
        selector: '[data-contrast="high"]',
        accent: '#ff0000',
        accentDark: '#ffe4e6',
      },
    ],
  },
  {
    id: 'emerald',
    name: 'Emerald',
    swatch: '#10b981',
    variants: [
      { mode: 'light', selector: ':root', accent: '#059669', accentDark: '#34d399' },
      { mode: 'dark', selector: '.dark', accent: '#34d399', accentDark: '#6ee7b7' },
      {
        mode: 'high-contrast',
        selector: '[data-contrast="high"]',
        accent: '#008000',
        accentDark: '#00ff00',
      },
    ],
  },
  {
    id: 'amber',
    name: 'Amber',
    swatch: '#f59e0b',
    variants: [
      { mode: 'light', selector: ':root', accent: '#d97706', accentDark: '#fbbf24' },
      { mode: 'dark', selector: '.dark', accent: '#fbbf24', accentDark: '#fcd34d' },
      {
        mode: 'high-contrast',
        selector: '[data-contrast="high"]',
        accent: '#ff8800',
        accentDark: '#fffbeb',
      },
    ],
  },
  {
    id: 'violet',
    name: 'Violet',
    swatch: '#8b5cf6',
    variants: [
      { mode: 'light', selector: ':root', accent: '#7c3aed', accentDark: '#a78bfa' },
      { mode: 'dark', selector: '.dark', accent: '#a78bfa', accentDark: '#c4b5fd' },
      {
        mode: 'high-contrast',
        selector: '[data-contrast="high"]',
        accent: '#8b00ff',
        accentDark: '#ede9fe',
      },
    ],
  },
  {
    id: 'orange',
    name: 'Orange',
    swatch: '#f97316',
    variants: [
      { mode: 'light', selector: ':root', accent: '#ea580c', accentDark: '#fb923c' },
      { mode: 'dark', selector: '.dark', accent: '#fb923c', accentDark: '#fdba74' },
      {
        mode: 'high-contrast',
        selector: '[data-contrast="high"]',
        accent: '#ff4500',
        accentDark: '#ffedd5',
      },
    ],
  },
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

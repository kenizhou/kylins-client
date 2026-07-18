// Re-export from themes.ts so existing imports keep working.
// skins.ts must NOT be imported by themes.ts to avoid a circular dependency.
import { THEME_PACKS, DEFAULT_THEME_PACK, isThemePackId, getThemePack } from './themes';
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

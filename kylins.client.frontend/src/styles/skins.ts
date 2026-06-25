export type SkinId =
  | 'slate'
  | 'blue'
  | 'indigo'
  | 'rose'
  | 'emerald'
  | 'amber'
  | 'violet'
  | 'orange';

export interface SkinDef {
  id: SkinId;
  name: string;
  /** Swatch color shown in the picker (the brand accent). */
  swatch: string;
}

export const SKINS: SkinDef[] = [
  { id: 'slate', name: 'Slate', swatch: '#64748b' },
  { id: 'blue', name: 'Blue', swatch: '#3b82f6' },
  { id: 'indigo', name: 'Indigo', swatch: '#6366f1' },
  { id: 'rose', name: 'Rose', swatch: '#f43f5e' },
  { id: 'emerald', name: 'Emerald', swatch: '#10b981' },
  { id: 'amber', name: 'Amber', swatch: '#f59e0b' },
  { id: 'violet', name: 'Violet', swatch: '#8b5cf6' },
  { id: 'orange', name: 'Orange', swatch: '#f97316' },
];

export const DEFAULT_SKIN: SkinId = 'slate';

export function isSkinId(value: string): value is SkinId {
  return SKINS.some((skin) => skin.id === value);
}

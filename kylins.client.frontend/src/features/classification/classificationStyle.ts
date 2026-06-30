import type { ClassificationLevel } from './classificationTypes';

/**
 * Derived visual styling for a classification level. A single hex `color` on the
 * level drives every surface (list rows, viewer/composer banners, badges,
 * watermark) so the look stays consistent and is defined in exactly one place —
 * mirroring Proton's central `icon.ts` mapping, adapted to our chosen-label model.
 */
export interface LevelStyle {
  /** The base level color (hex). */
  color: string;
  /** Readable foreground for text/icons placed on top of a solid `color` fill. */
  on: string;
  /** Subtle background tint for row backgrounds (`color` at ~8% alpha). */
  tint: string;
  /** Stronger tint for hover / emphasis (`color` at ~13% alpha). */
  tintStrong: string;
  /** Border color (== `color`). */
  border: string;
}

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = HEX_RE.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1]!, 16);
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

/**
 * Pick black or white text for legibility on a solid `color` background, using
 * the WCAG relative-luminance heuristic. Returns near-black on light colors
 * (e.g. amber) and white on dark/saturated colors (e.g. red).
 */
export function readableOn(color: string): string {
  const rgb = parseHex(color);
  if (!rgb) return '#ffffff';
  // sRGB → linear, then relative luminance.
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  return lum > 0.45 ? '#111827' : '#ffffff';
}

/** Append an 8-bit alpha (0–255) to a 6-digit hex color → 8-digit hex. */
function withAlpha(color: string, alpha: number): string {
  const rgb = parseHex(color);
  if (!rgb) return color;
  const a = Math.max(0, Math.min(255, Math.round(alpha)))
    .toString(16)
    .padStart(2, '0');
  const hex = `${rgb.r.toString(16).padStart(2, '0')}${rgb.g.toString(16).padStart(2, '0')}${rgb.b
    .toString(16)
    .padStart(2, '0')}`;
  return `#${hex}${a}`;
}

/**
 * Whether a level should receive high-visibility treatment. Honors an explicit
 * `prominent` flag, otherwise falls back to `order > 0` so the default
 * Restricted / Confidential levels are prominent and Unclassified is not.
 */
export function isProminent(level: ClassificationLevel | null | undefined): boolean {
  if (!level) return false;
  return level.prominent ?? level.order > 0;
}

export function levelStyle(level: ClassificationLevel): LevelStyle {
  const color = level.color;
  return {
    color,
    on: readableOn(color),
    tint: withAlpha(color, 0x14), // ~8%
    tintStrong: withAlpha(color, 0x22), // ~13%
    border: color,
  };
}

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THEME_PATH = path.resolve(__dirname, '../../../src/styles/theme.css');

interface ColorMap {
  [key: string]: string;
}

function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's');
  const match = css.match(regex);
  return match?.[1] ?? '';
}

function parseDeclarations(block: string): ColorMap {
  const map: ColorMap = {};
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) != null) {
    map[`--${m[1]}`] = m[2].trim();
  }
  return map;
}

function resolve(value: string, map: ColorMap, depth = 0): string {
  if (depth > 10) return value;
  const varMatch = value.match(/^var\((--[\w-]+)\)$/);
  if (!varMatch) return value;
  const next = map[varMatch[1]];
  if (next == null) return value;
  return resolve(next, map, depth + 1);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    const [r, g, b] = clean.split('').map((c) => parseInt(c + c, 16));
    return { r: r!, g: g!, b: b! };
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return { r: r!, g: g!, b: b! };
}

/** oklch(L C h) → linear sRGB (0..1 per channel). */
function oklchToLinearRgb(l: number, c: number, h: number): { r: number; g: number; b: number } {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const lc = l_ ** 3;
  const mc = m_ ** 3;
  const sc = s_ ** 3;
  return {
    r: 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    g: -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    b: -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  };
}

/** Any supported color string (hex or oklch) → linear sRGB channels. */
function colorToLinearRgb(color: string): { r: number; g: number; b: number } {
  const oklchMatch = color.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/i);
  if (oklchMatch) {
    return oklchToLinearRgb(Number(oklchMatch[1]), Number(oklchMatch[2]), Number(oklchMatch[3]));
  }
  const { r, g, b } = hexToRgb(color);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return { r: channel(r), g: channel(g), b: channel(b) };
}

function relativeLuminance(color: string): number {
  const { r, g, b } = colorToLinearRgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function assertContrast(
  foreground: string,
  background: string,
  map: ColorMap,
  expectedFgHex: string,
  expectedBgHex: string,
) {
  const fg = resolve(`var(${foreground})`, map);
  const bg = resolve(`var(${background})`, map);
  expect(fg.toLowerCase()).toBe(expectedFgHex.toLowerCase());
  expect(bg.toLowerCase()).toBe(expectedBgHex.toLowerCase());
  const ratio = contrastRatio(fg, bg);
  expect(ratio).toBeGreaterThanOrEqual(4.5);
}

describe('theme.css contrast (WCAG AA)', () => {
  const css = fs.readFileSync(THEME_PATH, 'utf-8');
  const lightBlock = parseDeclarations(extractBlock(css, ':root'));
  const darkBlock = parseDeclarations(extractBlock(css, '.dark'));

  it('light theme muted text meets AA on background and surface', () => {
    assertContrast(
      '--muted-text',
      '--background',
      lightBlock,
      'oklch(0.465 0.02 258)',
      'oklch(0.992 0.002 258)',
    );
    assertContrast(
      '--muted-text',
      '--surface',
      lightBlock,
      'oklch(0.465 0.02 258)',
      'oklch(0.965 0.006 258)',
    );
  });

  it('light theme muted foreground meets AA on background and surface', () => {
    assertContrast(
      '--muted-foreground',
      '--background',
      lightBlock,
      'oklch(0.465 0.02 258)',
      'oklch(0.992 0.002 258)',
    );
    assertContrast(
      '--muted-foreground',
      '--surface',
      lightBlock,
      'oklch(0.465 0.02 258)',
      'oklch(0.965 0.006 258)',
    );
  });

  it('light theme link meets AA on background', () => {
    assertContrast('--link', '--background', lightBlock, '#2563eb', 'oklch(0.992 0.002 258)');
  });

  it('dark theme muted text meets AA on background and surface', () => {
    assertContrast(
      '--muted-text',
      '--background',
      darkBlock,
      'oklch(0.712 0.016 258)',
      'oklch(0.205 0.012 258)',
    );
    assertContrast(
      '--muted-text',
      '--surface',
      darkBlock,
      'oklch(0.712 0.016 258)',
      'oklch(0.258 0.014 258)',
    );
  });

  it('dark theme muted foreground meets AA on background and surface', () => {
    assertContrast(
      '--muted-foreground',
      '--background',
      darkBlock,
      'oklch(0.712 0.016 258)',
      'oklch(0.205 0.012 258)',
    );
    assertContrast(
      '--muted-foreground',
      '--surface',
      darkBlock,
      'oklch(0.712 0.016 258)',
      'oklch(0.258 0.014 258)',
    );
  });

  it('dark theme link meets AA on background', () => {
    assertContrast('--link', '--background', darkBlock, '#60a5fa', 'oklch(0.205 0.012 258)');
  });
});

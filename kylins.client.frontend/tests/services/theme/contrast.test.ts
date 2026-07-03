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

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
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
    assertContrast('--muted-text', '--background', lightBlock, '#52525b', '#ffffff');
    assertContrast('--muted-text', '--surface', lightBlock, '#52525b', '#f4f4f5');
  });

  it('light theme muted foreground meets AA on background and surface', () => {
    assertContrast('--muted-foreground', '--background', lightBlock, '#52525b', '#ffffff');
    assertContrast('--muted-foreground', '--surface', lightBlock, '#52525b', '#f4f4f5');
  });

  it('light theme link meets AA on background', () => {
    assertContrast('--link', '--background', lightBlock, '#2563eb', '#ffffff');
  });

  it('dark theme muted text meets AA on background and surface', () => {
    assertContrast('--muted-text', '--background', darkBlock, '#a1a1aa', '#18181b');
    assertContrast('--muted-text', '--surface', darkBlock, '#a1a1aa', '#27272a');
  });

  it('dark theme muted foreground meets AA on background and surface', () => {
    assertContrast('--muted-foreground', '--background', darkBlock, '#a1a1aa', '#18181b');
    assertContrast('--muted-foreground', '--surface', darkBlock, '#a1a1aa', '#27272a');
  });

  it('dark theme link meets AA on background', () => {
    assertContrast('--link', '--background', darkBlock, '#60a5fa', '#18181b');
  });
});

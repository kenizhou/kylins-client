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

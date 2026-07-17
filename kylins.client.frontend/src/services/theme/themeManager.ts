import { type SkinId, DEFAULT_SKIN } from '../../styles/skins';

export interface Theme {
  name: string;
  css: string;
}

export type ContrastMode = 'default' | 'high';

export class ThemeManager {
  private activeTheme: string = 'system';
  private activeContrast: ContrastMode = 'default';
  private mediaQueryListener: ((e: MediaQueryListEvent) => void) | null = null;

  applyTheme(themeName: 'light' | 'dark' | 'system'): void {
    this.activeTheme = themeName;
    const root = document.documentElement;
    root.classList.remove('light', 'dark');

    // Remove any existing listener before switching
    if (this.mediaQueryListener) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.removeEventListener('change', this.mediaQueryListener);
      this.mediaQueryListener = null;
    }

    if (themeName === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.add(prefersDark ? 'dark' : 'light');

      const listener = (e: MediaQueryListEvent) => {
        root.classList.remove('light', 'dark');
        root.classList.add(e.matches ? 'dark' : 'light');
      };
      this.mediaQueryListener = listener;
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', listener);
    } else {
      root.classList.add(themeName);
    }

    this.applyContrast(this.activeContrast);
  }

  applySkin(skin: SkinId): void {
    const root = document.documentElement;
    root.setAttribute('data-skin', skin);
  }

  resetSkin(): void {
    document.documentElement.setAttribute('data-skin', DEFAULT_SKIN);
  }

  setContrast(contrast: ContrastMode): void {
    this.activeContrast = contrast;
    this.applyContrast(contrast);
  }

  getActiveContrast(): ContrastMode {
    return this.activeContrast;
  }

  getActiveTheme(): string {
    return this.activeTheme;
  }

  private applyContrast(contrast: ContrastMode): void {
    const root = document.documentElement;
    if (contrast === 'high') {
      root.setAttribute('data-contrast', 'high');
    } else {
      root.removeAttribute('data-contrast');
    }
  }
}

export const themeManager = new ThemeManager();

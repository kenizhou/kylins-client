export interface Theme {
  name: string;
  css: string;
}

export class ThemeManager {
  private activeTheme: string = 'system';
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
  }

  getActiveTheme(): string {
    return this.activeTheme;
  }
}

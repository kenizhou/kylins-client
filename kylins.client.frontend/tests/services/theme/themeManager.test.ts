import { describe, it, expect } from 'vitest';
import { ThemeManager } from '../../../src/services/theme/themeManager';

describe('ThemeManager', () => {
  it('applies dark theme class', () => {
    const manager = new ThemeManager();
    manager.applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('applies light theme class', () => {
    const manager = new ThemeManager();
    manager.applyTheme('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('applies system theme based on matchMedia', () => {
    const manager = new ThemeManager();

    // Simulate dark preference
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    manager.applyTheme('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    // Simulate light preference
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query !== '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    manager.applyTheme('system');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('returns the currently applied theme name', () => {
    const manager = new ThemeManager();
    manager.applyTheme('light');
    expect(manager.getActiveTheme()).toBe('light');
    manager.applyTheme('dark');
    expect(manager.getActiveTheme()).toBe('dark');
    manager.applyTheme('system');
    expect(manager.getActiveTheme()).toBe('system');
  });

  it('adds a matchMedia listener when applying system theme', () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: addListener,
      removeEventListener: removeListener,
      dispatchEvent: vi.fn(),
    }));

    const manager = new ThemeManager();
    manager.applyTheme('system');
    expect(addListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('removes the previous matchMedia listener when switching to explicit theme', () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: addListener,
      removeEventListener: removeListener,
      dispatchEvent: vi.fn(),
    }));

    const manager = new ThemeManager();
    manager.applyTheme('system');
    expect(addListener).toHaveBeenCalled();

    manager.applyTheme('light');
    expect(removeListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});

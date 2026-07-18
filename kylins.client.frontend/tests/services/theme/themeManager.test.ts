import { describe, it, expect, beforeEach } from 'vitest';
import { ThemeManager, themeManager } from '../../../src/services/theme/themeManager';

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

describe('ThemeManager contrast', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-contrast');
    document.documentElement.classList.remove('light', 'dark');
  });

  it('sets high contrast attribute', () => {
    themeManager.setContrast('high');
    expect(document.documentElement.getAttribute('data-contrast')).toBe('high');
  });

  it('removes high contrast attribute when set to default', () => {
    themeManager.setContrast('high');
    themeManager.setContrast('default');
    expect(document.documentElement.hasAttribute('data-contrast')).toBe(false);
  });

  it('remembers contrast when applying theme', () => {
    themeManager.setContrast('high');
    themeManager.applyTheme('light');
    expect(document.documentElement.getAttribute('data-contrast')).toBe('high');
  });
});

describe('ThemeManager font size', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-font-size');
  });

  it('sets data-font-size attribute', () => {
    themeManager.setFontSize('large');
    expect(document.documentElement.getAttribute('data-font-size')).toBe('large');
  });

  it('updates to small', () => {
    themeManager.setFontSize('large');
    themeManager.setFontSize('small');
    expect(document.documentElement.getAttribute('data-font-size')).toBe('small');
  });
});

describe('ThemeManager serif subjects', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('serif-subjects');
  });

  it('adds serif-subjects class', () => {
    themeManager.setSerifSubjects(true);
    expect(document.documentElement.classList.contains('serif-subjects')).toBe(true);
  });

  it('removes serif-subjects class', () => {
    themeManager.setSerifSubjects(true);
    themeManager.setSerifSubjects(false);
    expect(document.documentElement.classList.contains('serif-subjects')).toBe(false);
  });
});

describe('ThemeManager reduce motion', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-reduce-motion');
  });

  it('sets data-reduce-motion attribute', () => {
    themeManager.setReduceMotion(true);
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('true');
  });

  it('removes data-reduce-motion attribute', () => {
    themeManager.setReduceMotion(true);
    themeManager.setReduceMotion(false);
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(false);
  });
});

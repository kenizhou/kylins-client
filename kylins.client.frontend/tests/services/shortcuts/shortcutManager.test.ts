import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shortcutManager } from '../../../src/services/shortcuts/shortcutManager';
import * as settings from '../../../src/services/settings';

vi.mock('../../../src/services/settings', () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

describe('shortcutManager', () => {
  beforeEach(async () => {
    // Reset internal state between tests.
    await shortcutManager.setActiveSet('win');
    await shortcutManager.resetAll();
    vi.mocked(settings.getSetting).mockReset();
    vi.mocked(settings.setSetting).mockReset();
    vi.mocked(settings.getSetting).mockResolvedValue(null);
  });

  it('loads defaults for the active set', async () => {
    await shortcutManager.hydrate();
    expect(shortcutManager.getBinding('app:new-mail')).toBe('ctrl+n');
  });

  it('applies overrides for the active set', async () => {
    vi.mocked(settings.getSetting).mockImplementation((key: string) => {
      if (key === 'shortcuts_overrides') {
        return Promise.resolve(JSON.stringify({ win: { 'app:new-mail': 'ctrl+shift+n' } }));
      }
      return Promise.resolve(null);
    });
    await shortcutManager.hydrate();
    expect(shortcutManager.getBinding('app:new-mail')).toBe('ctrl+shift+n');
  });

  it('switches active sets independently', async () => {
    vi.mocked(settings.getSetting).mockImplementation((key: string) => {
      if (key === 'shortcuts_overrides') {
        return Promise.resolve(
          JSON.stringify({
            mac: { 'app:new-mail': 'mod+shift+n' },
            win: { 'app:new-mail': 'ctrl+shift+n' },
          }),
        );
      }
      return Promise.resolve('mac');
    });
    await shortcutManager.hydrate();
    expect(shortcutManager.getActiveSet()).toBe('mac');
    expect(shortcutManager.getBinding('app:new-mail')).toBe('mod+shift+n');

    await shortcutManager.setActiveSet('win');
    expect(shortcutManager.getBinding('app:new-mail')).toBe('ctrl+shift+n');
  });

  it('persists new overrides', async () => {
    await shortcutManager.hydrate();
    await shortcutManager.setBinding('app:new-mail', 'ctrl+shift+n');
    expect(shortcutManager.getBinding('app:new-mail')).toBe('ctrl+shift+n');
    expect(settings.setSetting).toHaveBeenCalledWith(
      'shortcuts_overrides',
      expect.stringContaining('ctrl+shift+n'),
    );
  });

  it('resets an individual binding to default', async () => {
    await shortcutManager.hydrate();
    await shortcutManager.setBinding('app:new-mail', 'ctrl+shift+n');
    expect(shortcutManager.getBinding('app:new-mail')).toBe('ctrl+shift+n');
    await shortcutManager.resetBinding('app:new-mail');
    expect(shortcutManager.getBinding('app:new-mail')).toBe('ctrl+n');
  });

  it('resets all overrides for the active set', async () => {
    await shortcutManager.hydrate();
    await shortcutManager.setBinding('app:new-mail', 'ctrl+shift+n');
    await shortcutManager.setBinding('edit:undo', 'ctrl+q');
    await shortcutManager.resetAll();
    expect(shortcutManager.getBinding('app:new-mail')).toBe('ctrl+n');
    expect(shortcutManager.getBinding('edit:undo')).toBe('ctrl+z');
  });
});

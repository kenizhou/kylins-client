import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usePreferencesStore } from '../../src/stores/preferencesStore';
import * as settingsModule from '../../src/services/settings';

vi.mock('../../src/services/settings', () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
  getSettingBool: vi.fn(() => Promise.resolve(null)),
  setSettingBool: vi.fn(() => Promise.resolve()),
  getSettingNumber: vi.fn(() => Promise.resolve(null)),
  setSettingNumber: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  vi.mocked(settingsModule.getSetting).mockReset();
  vi.mocked(settingsModule.setSetting).mockReset();
  vi.mocked(settingsModule.getSetting).mockResolvedValue(null);

  // Reset the Zustand store to defaults before each test.
  usePreferencesStore.setState({
    isOpen: false,
    activeTab: 'General',
    isHydrated: false,
    launchOnSystemStart: true,
    showIconInMenuBar: true,
    showGmailStyleImportantMarkers: true,
    showUnreadCountsForAllFolders: false,
    use24HourClock: false,
    interfaceLanguage: 'automatic',
    markAsReadDelay: '0.5',
    automaticallyLoadImages: true,
    showFullMessageHeaders: false,
    showRecipientFullNames: false,
    restrictMessageWidth: false,
    moveToTrashOnSwipe: false,
    disableSwipeGestures: false,
    descendingConversations: false,
    messageSentSound: true,
    defaultSendBehavior: 'send',
    defaultReplyBehavior: 'reply-all',
    undoSendDuration: '5',
    sendNewMessagesFrom: 'selected-account',
    enableRichText: true,
    checkSpelling: true,
    checkGrammar: false,
    spellcheckLanguage: 'system',
    showNotificationsForNewUnread: true,
    showNotificationsForRepeatedOpens: true,
    playSoundOnNewMail: true,
    resurfaceMessagesOnUnsnooze: true,
    appIconBadge: 'unread-count',
    openAttachmentFolder: false,
    displayAttachmentThumbnails: true,
    cacheAutoCleanupEnabled: false,
    shareDiagnosticsData: false,
  });
});

describe('preferencesStore', () => {
  it('hydrates boolean and string values from settings', async () => {
    vi.mocked(settingsModule.getSetting).mockImplementation((key: string) => {
      const values: Record<string, string> = {
        launch_on_system_start: 'false',
        show_notifications_for_new_unread: 'false',
        undo_send_duration: '10',
        interface_language: 'zh',
      };
      return Promise.resolve(values[key] ?? null);
    });

    await usePreferencesStore.getState().hydrate();

    const state = usePreferencesStore.getState();
    expect(state.isHydrated).toBe(true);
    expect(state.launchOnSystemStart).toBe(false);
    expect(state.showNotificationsForNewUnread).toBe(false);
    expect(state.undoSendDuration).toBe('10');
    expect(state.interfaceLanguage).toBe('zh');
  });

  it('falls back to defaults when settings are missing', async () => {
    vi.mocked(settingsModule.getSetting).mockResolvedValue(null);
    await usePreferencesStore.getState().hydrate();

    const state = usePreferencesStore.getState();
    expect(state.launchOnSystemStart).toBe(true);
    expect(state.automaticallyLoadImages).toBe(true);
    expect(state.undoSendDuration).toBe('5');
  });

  it('persists changes to settings', async () => {
    usePreferencesStore.getState().setLaunchOnSystemStart(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settingsModule.setSetting).toHaveBeenCalledWith('launch_on_system_start', 'false');
    expect(usePreferencesStore.getState().launchOnSystemStart).toBe(false);
  });

  it('persists string changes to settings', async () => {
    usePreferencesStore.getState().setUndoSendDuration('30');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settingsModule.setSetting).toHaveBeenCalledWith('undo_send_duration', '30');
    expect(usePreferencesStore.getState().undoSendDuration).toBe('30');
  });

  it('opens and closes preferences', () => {
    usePreferencesStore.getState().openPreferences('Notifications');
    expect(usePreferencesStore.getState().isOpen).toBe(true);
    expect(usePreferencesStore.getState().activeTab).toBe('Notifications');

    usePreferencesStore.getState().closePreferences();
    expect(usePreferencesStore.getState().isOpen).toBe(false);
  });
});

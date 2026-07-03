import { useCallback } from 'react';
import { useUIStore, type ThemeMode } from '../../stores/uiStore';
import { useViewStore } from '../../features/view/viewStore';
import type { ReadingPanePosition, MessageListDensity } from '../../features/view/types';
import { setSetting } from '../../services/settings';
import { themeManager } from '../../services/theme/themeManager';
import { SKINS, DEFAULT_SKIN, type SkinId } from '../../styles/skins';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { CheckboxRow } from './PreferenceRows';
import { SegmentedControl } from '../ui/SegmentedControl';
import { PreferencesTabLayout, PreferencesTabColumns } from './PreferencesTabLayout';
import {
  PreferencesAppearanceIcon,
  PreferencesSystemIcon,
  PreferencesReadingIcon,
  PreferencesMailRulesIcon,
  MailIcon,
} from '../icons';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

const READING_PANE_OPTIONS: { value: ReadingPanePosition; label: string }[] = [
  { value: 'right', label: 'Right' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'off', label: 'Off' },
];

const DENSITY_OPTIONS: { value: MessageListDensity; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'normal', label: 'Normal' },
  { value: 'comfortable', label: 'Comfortable' },
];

export function AppearancePreferences() {
  const theme = useUIStore((s) => s.theme);
  const skin = useUIStore((s) => s.skin);
  const setTheme = useUIStore((s) => s.setTheme);
  const setSkin = useUIStore((s) => s.setSkin);

  const readingPanePosition = useViewStore((s) => s.readingPanePosition);
  const messageListDensity = useViewStore((s) => s.messageListDensity);
  const folderPaneVisible = useViewStore((s) => s.folderPaneVisible);
  const commandRibbonVisible = useViewStore((s) => s.commandRibbonVisible);
  const statusBarVisible = useViewStore((s) => s.statusBarVisible);
  const conversationView = useViewStore((s) => s.conversationView);

  const setReadingPanePosition = useViewStore((s) => s.setReadingPanePosition);
  const setMessageListDensity = useViewStore((s) => s.setMessageListDensity);
  const setFolderPaneVisible = useViewStore((s) => s.setFolderPaneVisible);
  const setCommandRibbonVisible = useViewStore((s) => s.setCommandRibbonVisible);
  const setStatusBarVisible = useViewStore((s) => s.setStatusBarVisible);
  const setConversationView = useViewStore((s) => s.setConversationView);
  const resetToDefaults = useViewStore((s) => s.resetToDefaults);

  const handleThemeChange = useCallback(
    (value: ThemeMode) => {
      setTheme(value);
      themeManager.applyTheme(value);
      setSetting('theme', value).catch(() => {});
    },
    [setTheme],
  );

  const handleSkinChange = useCallback(
    (value: SkinId) => {
      setSkin(value);
      themeManager.applySkin(value);
      setSetting('skin', value).catch(() => {});
    },
    [setSkin],
  );

  const handleReset = useCallback(() => {
    // Reset view/layout state.
    resetToDefaults();

    // Reset theme and skin.
    setTheme('system');
    themeManager.applyTheme('system');
    setSetting('theme', 'system').catch(() => {});

    setSkin(DEFAULT_SKIN);
    themeManager.applySkin(DEFAULT_SKIN);
    setSetting('skin', DEFAULT_SKIN).catch(() => {});
  }, [resetToDefaults, setTheme, setSkin]);

  return (
    <PreferencesTabLayout>
      <PreferencesTabColumns
        left={
          <>
            <PreferencesSectionCard title="Mode" icon={PreferencesSystemIcon}>
              <SegmentedControl
                options={THEME_OPTIONS}
                value={theme}
                onChange={handleThemeChange}
              />
            </PreferencesSectionCard>

            <PreferencesSectionCard title="Color skin" icon={PreferencesAppearanceIcon}>
              <div className="grid grid-cols-4 sm:grid-cols-8 gap-3">
                {SKINS.map((s) => {
                  const active = skin === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => handleSkinChange(s.id)}
                      title={s.name}
                      className={`group flex flex-col items-center gap-1.5 rounded-lg p-2 transition-colors ${
                        active
                          ? 'bg-[var(--highlight)] ring-1 ring-[var(--primary)]'
                          : 'hover:bg-[var(--hover)]'
                      }`}
                    >
                      <span
                        className="h-11 w-11 rounded-full shadow-sm ring-2 ring-white/20"
                        style={{ background: s.swatch }}
                      />
                      <span className="text-[10px] font-medium text-[var(--muted-text)]">
                        {s.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </PreferencesSectionCard>

            <PreferencesSectionCard title="Message list" icon={MailIcon}>
              <div className="space-y-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-[var(--muted-text)]">Density</span>
                  <SegmentedControl
                    options={DENSITY_OPTIONS}
                    value={messageListDensity}
                    onChange={setMessageListDensity}
                  />
                </div>
                <CheckboxRow
                  label="Conversation view"
                  checked={conversationView}
                  onChange={setConversationView}
                />
              </div>
            </PreferencesSectionCard>
          </>
        }
        right={
          <>
            <PreferencesSectionCard title="Layout" icon={PreferencesAppearanceIcon}>
              <div className="space-y-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-[var(--muted-text)]">Reading pane position</span>
                  <SegmentedControl
                    options={READING_PANE_OPTIONS}
                    value={readingPanePosition}
                    onChange={setReadingPanePosition}
                  />
                </div>
                <CheckboxRow
                  label="Show folder pane"
                  checked={folderPaneVisible}
                  onChange={setFolderPaneVisible}
                />
                <CheckboxRow
                  label="Show command ribbon"
                  checked={commandRibbonVisible}
                  onChange={setCommandRibbonVisible}
                />
                <CheckboxRow
                  label="Show status bar"
                  checked={statusBarVisible}
                  onChange={setStatusBarVisible}
                />
              </div>
            </PreferencesSectionCard>

            <PreferencesSectionCard title="Reading" icon={PreferencesReadingIcon}>
              <p className="text-sm text-[var(--muted-text)]">
                Reading preferences such as auto-image loading and header display are on the General
                tab.
              </p>
            </PreferencesSectionCard>

            <PreferencesSectionCard title="Restore defaults" icon={PreferencesMailRulesIcon}>
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex items-center justify-center h-11 px-4 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
              >
                Reset appearance and layout
              </button>
            </PreferencesSectionCard>
          </>
        }
      />
    </PreferencesTabLayout>
  );
}

import { useCallback } from 'react';
import { useUIStore, type ThemeMode, type ContrastMode } from '../../stores/uiStore';
import { useViewStore } from '../../features/view/viewStore';
import type { ReadingPanePosition, MessageListDensity } from '../../features/view/types';
import { setSetting } from '../../services/settings';
import { SETTING_KEYS } from '../../services/settingsKeys';
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

const CONTRAST_OPTIONS: { value: ContrastMode; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'high', label: 'High contrast' },
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

const FONT_SIZE_OPTIONS: { value: 'small' | 'default' | 'large'; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
];

export function AppearancePreferences() {
  const theme = useUIStore((s) => s.theme);
  const contrast = useUIStore((s) => s.contrast);
  const skin = useUIStore((s) => s.skin);
  const setTheme = useUIStore((s) => s.setTheme);
  const setContrast = useUIStore((s) => s.setContrast);
  const setSkin = useUIStore((s) => s.setSkin);
  const fontSize = useUIStore((s) => s.fontSize);
  const serifSubjects = useUIStore((s) => s.serifSubjects);
  const reduceMotion = useUIStore((s) => s.reduceMotion);
  const setFontSize = useUIStore((s) => s.setFontSize);
  const setSerifSubjects = useUIStore((s) => s.setSerifSubjects);
  const setReduceMotion = useUIStore((s) => s.setReduceMotion);

  const readingPanePosition = useViewStore((s) => s.readingPanePosition);
  const messageListDensity = useViewStore((s) => s.messageListDensity);
  const folderPaneVisible = useViewStore((s) => s.folderPaneVisible);
  const commandRibbonVisible = useViewStore((s) => s.commandRibbonVisible);
  const statusBarVisible = useViewStore((s) => s.statusBarVisible);

  const setReadingPanePosition = useViewStore((s) => s.setReadingPanePosition);
  const setMessageListDensity = useViewStore((s) => s.setMessageListDensity);
  const setFolderPaneVisible = useViewStore((s) => s.setFolderPaneVisible);
  const setCommandRibbonVisible = useViewStore((s) => s.setCommandRibbonVisible);
  const setStatusBarVisible = useViewStore((s) => s.setStatusBarVisible);
  const resetToDefaults = useViewStore((s) => s.resetToDefaults);

  const handleThemeChange = useCallback(
    (value: ThemeMode) => {
      setTheme(value);
      themeManager.applyTheme(value);
      setSetting(SETTING_KEYS.theme, value).catch(() => {});
    },
    [setTheme],
  );

  const handleContrastChange = useCallback(
    (value: ContrastMode) => {
      setContrast(value);
      themeManager.setContrast(value);
      setSetting(SETTING_KEYS.contrast, value).catch(() => {});
    },
    [setContrast],
  );

  const handleSkinChange = useCallback(
    (value: SkinId) => {
      setSkin(value);
      themeManager.applySkin(value);
      setSetting(SETTING_KEYS.skin, value).catch(() => {});
    },
    [setSkin],
  );

  const handleFontSizeChange = useCallback(
    (value: 'small' | 'default' | 'large') => {
      setFontSize(value);
      themeManager.setFontSize(value);
      setSetting(SETTING_KEYS.fontSize, value).catch(() => {});
    },
    [setFontSize],
  );

  const handleSerifSubjectsChange = useCallback(
    (value: boolean) => {
      setSerifSubjects(value);
      themeManager.setSerifSubjects(value);
      setSetting(SETTING_KEYS.serifSubjects, String(value)).catch(() => {});
    },
    [setSerifSubjects],
  );

  const handleReduceMotionChange = useCallback(
    (value: boolean) => {
      setReduceMotion(value);
      themeManager.setReduceMotion(value);
      setSetting(SETTING_KEYS.reduceMotion, String(value)).catch(() => {});
    },
    [setReduceMotion],
  );

  const handleReset = useCallback(() => {
    // Reset view/layout state.
    resetToDefaults();

    // Reset theme and skin.
    setTheme('system');
    themeManager.applyTheme('system');
    setSetting(SETTING_KEYS.theme, 'system').catch(() => {});

    setContrast('default');
    themeManager.setContrast('default');
    setSetting(SETTING_KEYS.contrast, 'default').catch(() => {});

    setSkin(DEFAULT_SKIN);
    themeManager.applySkin(DEFAULT_SKIN);
    setSetting(SETTING_KEYS.skin, DEFAULT_SKIN).catch(() => {});

    setFontSize('default');
    themeManager.setFontSize('default');
    setSetting(SETTING_KEYS.fontSize, 'default').catch(() => {});

    setSerifSubjects(false);
    themeManager.setSerifSubjects(false);
    setSetting(SETTING_KEYS.serifSubjects, 'false').catch(() => {});

    setReduceMotion(false);
    themeManager.setReduceMotion(false);
    setSetting(SETTING_KEYS.reduceMotion, 'false').catch(() => {});
  }, [
    resetToDefaults,
    setTheme,
    setContrast,
    setSkin,
    setFontSize,
    setSerifSubjects,
    setReduceMotion,
  ]);

  return (
    <PreferencesTabLayout>
      <PreferencesTabColumns
        left={
          <>
            <PreferencesSectionCard title="Mode" icon={PreferencesSystemIcon}>
              <div className="space-y-3">
                <SegmentedControl
                  options={THEME_OPTIONS}
                  value={theme}
                  onChange={handleThemeChange}
                />
                <SegmentedControl
                  options={CONTRAST_OPTIONS}
                  value={contrast}
                  onChange={handleContrastChange}
                />
              </div>
            </PreferencesSectionCard>

            <PreferencesSectionCard title="Text" icon={PreferencesReadingIcon}>
              <div className="space-y-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-[var(--muted-text)]">Font size</span>
                  <SegmentedControl
                    options={FONT_SIZE_OPTIONS}
                    value={fontSize}
                    onChange={handleFontSizeChange}
                  />
                </div>
                <CheckboxRow
                  label="Serif subjects"
                  checked={serifSubjects}
                  onChange={handleSerifSubjectsChange}
                />
                <CheckboxRow
                  label="Reduce motion"
                  checked={reduceMotion}
                  onChange={handleReduceMotionChange}
                />
              </div>
            </PreferencesSectionCard>

            <PreferencesSectionCard title="Color skin" icon={PreferencesAppearanceIcon}>
              <div className="flex flex-wrap gap-2">
                {SKINS.map((s) => {
                  const active = skin === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => handleSkinChange(s.id)}
                      title={s.name}
                      aria-label={`Select ${s.name} skin`}
                      aria-pressed={active}
                      className={`group setup-focus-ring flex w-[72px] flex-col items-center gap-1.5 rounded-xl p-2 transition-colors ${
                        active
                          ? 'bg-[var(--primary-muted)] ring-2 ring-[var(--primary)]'
                          : 'hover:bg-[var(--hover)]'
                      }`}
                    >
                      <span
                        className={`h-11 w-11 rounded-full shadow-[var(--shadow-sm)] transition-transform ${active ? 'scale-105' : 'group-hover:scale-105'}`}
                        style={{ background: s.swatch }}
                      />
                      <span
                        className={`text-[10px] font-medium ${active ? 'text-[var(--primary)]' : 'text-[var(--muted-text)]'}`}
                      >
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
                Reading preferences such as auto-image loading and header display are on the Mail
                tab.
              </p>
            </PreferencesSectionCard>

            <PreferencesSectionCard title="Restore defaults" icon={PreferencesMailRulesIcon}>
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex items-center justify-center h-11 px-4 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors setup-focus-ring"
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

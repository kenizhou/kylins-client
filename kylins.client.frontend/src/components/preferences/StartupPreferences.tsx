import { useEffect } from 'react';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { CheckboxRow, ButtonRow } from './PreferenceRows';
import { PreferencesSystemIcon } from '../icons';
import { getAutostartState, setAutostartEnabled } from '../../services/startup/autostart';

export function StartupPreferences() {
  const s = usePreferencesStore();

  // Keep the UI in sync with the OS autostart state when the tab opens.
  useEffect(() => {
    let cancelled = false;
    getAutostartState().then((enabled) => {
      if (!cancelled && enabled !== s.launchOnSystemStart) {
        s.setLaunchOnSystemStart(enabled);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLaunchChange(value: boolean) {
    s.setLaunchOnSystemStart(value);
    await setAutostartEnabled(value);
  }

  return (
    <div className="p-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5" style={{ alignItems: 'start' }}>
        <PreferencesSectionCard title="System startup" icon={PreferencesSystemIcon}>
          <CheckboxRow
            label="Launch on system start"
            checked={s.launchOnSystemStart}
            onChange={handleLaunchChange}
          />
          <CheckboxRow
            label="Show icon in menu bar / system tray"
            checked={s.showIconInMenuBar}
            onChange={s.setShowIconInMenuBar}
          />
          <ButtonRow
            label="Default mail client"
            description="Use Kylins as the default mail client for your system."
          >
            <button
              type="button"
              disabled
              className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] disabled:opacity-50"
            >
              Set as default
            </button>
          </ButtonRow>
        </PreferencesSectionCard>
      </div>
    </div>
  );
}

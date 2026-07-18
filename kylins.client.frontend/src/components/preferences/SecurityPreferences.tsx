import { PreferencesTabLayout } from './PreferencesTabLayout';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { KeyManagerSection } from './KeyManagerSection';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { CheckboxRow } from './PreferenceRows';
import { SecurityIcon, ShieldCheckIcon } from '../icons';

export function SecurityPreferences() {
  const shareDiagnosticsData = usePreferencesStore((s) => s.shareDiagnosticsData);
  const setShareDiagnosticsData = usePreferencesStore((s) => s.setShareDiagnosticsData);

  return (
    <PreferencesTabLayout>
      <PreferencesSectionCard title="Privacy" icon={SecurityIcon}>
        <div className="space-y-3">
          <CheckboxRow
            label="Share diagnostics data"
            checked={shareDiagnosticsData}
            onChange={setShareDiagnosticsData}
          />
          <p className="text-xs text-muted-text">
            Diagnostics are anonymous and help improve stability. No message content is shared.
          </p>
        </div>
      </PreferencesSectionCard>

      <PreferencesSectionCard title="S/MIME Keys" icon={ShieldCheckIcon}>
        <KeyManagerSection />
      </PreferencesSectionCard>
    </PreferencesTabLayout>
  );
}

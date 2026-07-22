import { PreferencesTabLayout } from './PreferencesTabLayout';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { KeyManagerSection } from './KeyManagerSection';
import { TrustedCasSection } from './TrustedCasSection';
import { CryptoMethodSection } from './CryptoMethodSection';
import { CryptoGranularitySection } from './CryptoGranularitySection';
import { ClassificationSection } from './ClassificationSection';
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
          <p className="type-caption text-[var(--muted-text)]">
            Diagnostics are anonymous and help improve stability. No message content is shared.
          </p>
        </div>
      </PreferencesSectionCard>

      <ClassificationSection />

      {/* KeyManagerSection and TrustedCasSection render their own
          PreferencesSectionCard internally — wrapping them again would nest
          card-in-card. */}
      <KeyManagerSection />
      <TrustedCasSection />

      <PreferencesSectionCard title="Crypto method" icon={ShieldCheckIcon}>
        <CryptoMethodSection />
      </PreferencesSectionCard>

      <PreferencesSectionCard title="Encryption granularity" icon={ShieldCheckIcon}>
        <CryptoGranularitySection />
      </PreferencesSectionCard>
    </PreferencesTabLayout>
  );
}

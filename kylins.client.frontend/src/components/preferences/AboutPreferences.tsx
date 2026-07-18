import { PreferencesSectionCard } from './PreferencesSectionCard';
import { PreferencesTabLayout } from './PreferencesTabLayout';
import { InfoIcon } from '../icons';

export function AboutPreferences() {
  return (
    <PreferencesTabLayout>
      <PreferencesSectionCard title="About Kylins" icon={InfoIcon}>
        <div className="space-y-2 text-sm text-muted-text">
          <p>Kylins Mail — a desktop email client for Windows, macOS and Linux.</p>
          <p>
            Version <span className="font-medium text-foreground">{__APP_VERSION__ ?? 'dev'}</span>
          </p>
          <p>
            Attributions and licenses are available in <code>ATTRIBUTIONS.md</code>.
          </p>
        </div>
      </PreferencesSectionCard>
    </PreferencesTabLayout>
  );
}

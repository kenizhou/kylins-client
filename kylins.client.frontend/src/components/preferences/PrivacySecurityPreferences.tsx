import { usePreferencesStore } from '../../stores/preferencesStore';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { CheckboxRow, ButtonRow } from './PreferenceRows';
import { PreferencesPrivacySecurityIcon } from '../icons';

export function PrivacySecurityPreferences() {
  const s = usePreferencesStore();

  return (
    <div className="p-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5" style={{ alignItems: 'start' }}>
        <PreferencesSectionCard title="Privacy" icon={PreferencesPrivacySecurityIcon}>
          <CheckboxRow
            label="Automatically load images in viewed messages"
            checked={s.automaticallyLoadImages}
            onChange={s.setAutomaticallyLoadImages}
          />
          <CheckboxRow
            label="Show full message headers by default"
            checked={s.showFullMessageHeaders}
            onChange={s.setShowFullMessageHeaders}
          />
          <CheckboxRow
            label="Share diagnostic and usage data to help improve Kylins"
            checked={s.shareDiagnosticsData}
            onChange={s.setShareDiagnosticsData}
          />
          <ButtonRow label="Clear local data" description="Remove cached data, allowlists, and reset preferences.">
            <button
              type="button"
              disabled
              className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] disabled:opacity-50"
            >
              Reset local data
            </button>
          </ButtonRow>
        </PreferencesSectionCard>

        <PreferencesSectionCard title="Security" icon={PreferencesPrivacySecurityIcon}>
          <div className="text-sm text-[var(--foreground)] space-y-2">
            <p>
              <span className="font-medium">Encryption at rest:</span> OAuth tokens, refresh tokens,
              and IMAP passwords are encrypted with AES-256-GCM before being stored in SQLite.
            </p>
            <p className="text-xs text-[var(--muted-text)]">
              The master key is stored in the OS keyring (Windows Credential Manager, macOS
              Keychain, or Linux Secret Service).
            </p>
          </div>
        </PreferencesSectionCard>
      </div>
    </div>
  );
}

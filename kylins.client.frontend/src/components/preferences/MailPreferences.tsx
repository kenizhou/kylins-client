import { usePreferencesStore } from '../../stores/preferencesStore';
import { useViewStore } from '../../features/view/viewStore';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { CheckboxRow } from './PreferenceRows';
import { PreferencesTabLayout, PreferencesTabColumns } from './PreferencesTabLayout';
import { MailIcon, PreferencesReadingIcon, PreferencesSignaturesIcon } from '../icons';

export function MailPreferences() {
  const conversationView = useViewStore((s) => s.conversationView);
  const setConversationView = useViewStore((s) => s.setConversationView);

  const automaticallyLoadImages = usePreferencesStore((s) => s.automaticallyLoadImages);
  const setAutomaticallyLoadImages = usePreferencesStore((s) => s.setAutomaticallyLoadImages);
  const showFullMessageHeaders = usePreferencesStore((s) => s.showFullMessageHeaders);
  const setShowFullMessageHeaders = usePreferencesStore((s) => s.setShowFullMessageHeaders);

  return (
    <PreferencesTabLayout>
      <PreferencesTabColumns
        left={
          <>
            <PreferencesSectionCard title="Reading" icon={PreferencesReadingIcon}>
              <div className="space-y-3">
                <CheckboxRow
                  label="Automatically load images"
                  checked={automaticallyLoadImages}
                  onChange={setAutomaticallyLoadImages}
                />
                <CheckboxRow
                  label="Show full message headers"
                  checked={showFullMessageHeaders}
                  onChange={setShowFullMessageHeaders}
                />
                <CheckboxRow
                  label="Conversation view"
                  checked={conversationView}
                  onChange={setConversationView}
                />
              </div>
            </PreferencesSectionCard>

            <PreferencesSectionCard title="Message list" icon={MailIcon}>
              <p className="text-sm text-muted-text">
                Density and column options are on the Appearance tab.
              </p>
            </PreferencesSectionCard>
          </>
        }
        right={
          <PreferencesSectionCard title="Signatures" icon={PreferencesSignaturesIcon}>
            <p className="text-sm text-muted-text">
              Signatures can be managed per-account in Accounts preferences.
            </p>
          </PreferencesSectionCard>
        }
      />
    </PreferencesTabLayout>
  );
}

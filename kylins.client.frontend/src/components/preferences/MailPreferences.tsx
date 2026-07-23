import { usePreferencesStore } from '../../stores/preferencesStore';
import { useViewStore } from '../../features/view/viewStore';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { CheckboxRow, SelectRow } from './PreferenceRows';
import { PreferencesTabLayout } from './PreferencesTabLayout';
import { MailIcon, PreferencesReadingIcon, PreferencesComposingIcon } from '../icons';

export function MailPreferences() {
  const conversationView = useViewStore((s) => s.conversationView);
  const setConversationView = useViewStore((s) => s.setConversationView);

  const automaticallyLoadImages = usePreferencesStore((s) => s.automaticallyLoadImages);
  const setAutomaticallyLoadImages = usePreferencesStore((s) => s.setAutomaticallyLoadImages);
  const showFullMessageHeaders = usePreferencesStore((s) => s.showFullMessageHeaders);
  const setShowFullMessageHeaders = usePreferencesStore((s) => s.setShowFullMessageHeaders);

  const quoteStyle = usePreferencesStore((s) => s.quoteStyle);
  const setQuoteStyle = usePreferencesStore((s) => s.setQuoteStyle);
  const alwaysShowCcBcc = usePreferencesStore((s) => s.alwaysShowCcBcc);
  const setAlwaysShowCcBcc = usePreferencesStore((s) => s.setAlwaysShowCcBcc);

  return (
    <PreferencesTabLayout>
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

      <PreferencesSectionCard title="Composing" icon={PreferencesComposingIcon}>
        <div className="space-y-3">
          <SelectRow
            label="Quote style for replies and forwards"
            value={quoteStyle}
            options={[
              { value: 'outlook', label: 'Outlook (header block, no indent)' },
              { value: 'gmail', label: 'Gmail (indented quote)' },
            ]}
            onChange={setQuoteStyle}
          />
          <CheckboxRow
            label="Always show Cc and Bcc fields"
            checked={alwaysShowCcBcc}
            onChange={setAlwaysShowCcBcc}
          />
        </div>
      </PreferencesSectionCard>

      <PreferencesSectionCard title="Message list" icon={MailIcon}>
        <p className="text-sm text-muted-text">
          Density and column options are on the Appearance tab.
        </p>
      </PreferencesSectionCard>
    </PreferencesTabLayout>
  );
}

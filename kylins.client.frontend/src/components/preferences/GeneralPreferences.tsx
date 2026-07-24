import { usePreferencesStore } from '../../stores/preferencesStore';
import {
  PreferencesLanguageIcon,
  PreferencesSendingIcon,
  PreferencesNotificationsIcon,
} from '../icons';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { CheckboxRow, SelectRow } from './PreferenceRows';
import { PreferencesTabLayout } from './PreferencesTabLayout';

export function GeneralPreferences() {
  const s = usePreferencesStore();

  return (
    <PreferencesTabLayout>
      <div className="space-y-5">
        <PreferencesSectionCard title="Interface Language" icon={PreferencesLanguageIcon}>
          <SelectRow
            label="Display language"
            value={s.interfaceLanguage}
            options={[
              { value: 'automatic', label: 'Automatic (English)' },
              { value: 'en', label: 'English' },
              { value: 'zh', label: '中文' },
              { value: 'es', label: 'Español' },
              { value: 'fr', label: 'Français' },
            ]}
            onChange={s.setInterfaceLanguage}
          />
        </PreferencesSectionCard>

        <PreferencesSectionCard title="Sending" icon={PreferencesSendingIcon}>
          <CheckboxRow
            label="Play sound when a message is sent"
            checked={s.messageSentSound}
            onChange={s.setMessageSentSound}
          />
          <SelectRow
            label="Default send behavior"
            value={s.defaultSendBehavior}
            options={[
              { value: 'send', label: 'Send' },
              { value: 'send-later', label: 'Send later' },
            ]}
            onChange={s.setDefaultSendBehavior}
          />
          <SelectRow
            label="Default reply behavior"
            value={s.defaultReplyBehavior}
            options={[
              { value: 'reply', label: 'Reply' },
              { value: 'reply-all', label: 'Reply all' },
            ]}
            onChange={s.setDefaultReplyBehavior}
          />
          <SelectRow
            label="Send new messages from"
            value={s.sendNewMessagesFrom}
            options={[
              { value: 'selected-account', label: 'Selected account' },
              { value: 'default-account', label: 'Default account' },
            ]}
            onChange={s.setSendNewMessagesFrom}
          />
        </PreferencesSectionCard>

        <PreferencesSectionCard title="Notifications" icon={PreferencesNotificationsIcon}>
          <CheckboxRow
            label="Show notifications for new unread messages"
            checked={s.showNotificationsForNewUnread}
            onChange={s.setShowNotificationsForNewUnread}
          />
          <CheckboxRow
            label="Do Not Disturb (silence all notifications)"
            checked={s.doNotDisturb}
            onChange={s.setDoNotDisturb}
            description="When on, no desktop notifications will be shown, even for new mail."
          />
          <CheckboxRow
            label="Show notifications for repeated opens / clicks"
            checked={s.showNotificationsForRepeatedOpens}
            onChange={s.setShowNotificationsForRepeatedOpens}
          />
          <CheckboxRow
            label="Play sound when receiving new mail"
            checked={s.playSoundOnNewMail}
            onChange={s.setPlaySoundOnNewMail}
          />
          <CheckboxRow
            label="Resurface messages to the top of the inbox when unsnoozing"
            checked={s.resurfaceMessagesOnUnsnooze}
            onChange={s.setResurfaceMessagesOnUnsnooze}
          />
          <SelectRow
            label="Show badge on the app icon"
            value={s.appIconBadge}
            options={[
              { value: 'unread-count', label: 'Show unread count' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={s.setAppIconBadge}
          />
        </PreferencesSectionCard>
      </div>
    </PreferencesTabLayout>
  );
}

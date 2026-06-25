import { usePreferencesStore } from '../../stores/preferencesStore';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { CheckboxRow, SelectRow } from './PreferenceRows';
import { PreferencesNotificationsIcon } from '../icons';

export function NotificationsPreferences() {
  const s = usePreferencesStore();

  return (
    <div className="p-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5" style={{ alignItems: 'start' }}>
        <PreferencesSectionCard title="New mail notifications" icon={PreferencesNotificationsIcon}>
          <CheckboxRow
            label="Show notifications for new unread messages"
            checked={s.showNotificationsForNewUnread}
            onChange={s.setShowNotificationsForNewUnread}
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
            label="Show badge on the app icon:"
            value={s.appIconBadge}
            options={[
              { value: 'unread-count', label: 'Show Unread Count' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={s.setAppIconBadge}
          />
        </PreferencesSectionCard>
      </div>
    </div>
  );
}

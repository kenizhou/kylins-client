import { useState } from 'react';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { useAccountStore } from '../../stores/accountStore';
import { getAllAccounts } from '../../services/accounts';
import { seedDummyData, clearAllDummyData } from '../../services/db/seedDummyData';
import {
  PreferencesSystemIcon,
  PreferencesLanguageIcon,
  PreferencesNotificationsIcon,
  PreferencesReadingIcon,
  PreferencesLocalDataIcon,
} from '../icons';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { CheckboxRow, SelectRow } from './PreferenceRows';

export function GeneralPreferences() {
  const s = usePreferencesStore();
  const [seedStatus, setSeedStatus] = useState<string | null>(null);

  async function handleSeed() {
    setSeedStatus('Seeding…');
    try {
      await seedDummyData({ clearExisting: true });
      const refreshed = await getAllAccounts();
      useAccountStore.getState().setAccounts(refreshed);
      if (refreshed.length > 0 && useAccountStore.getState().activeAccountId == null) {
        useAccountStore.getState().setActiveAccount(refreshed[0]!.id);
      }
      setSeedStatus('Seeded. Close preferences to see the data.');
    } catch (e) {
      setSeedStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleClear() {
    setSeedStatus('Clearing…');
    try {
      await clearAllDummyData();
      const refreshed = await getAllAccounts();
      useAccountStore.getState().setAccounts(refreshed);
      if (refreshed.length === 0) {
        useAccountStore.getState().setActiveAccount(null);
      }
      setSeedStatus('Cleared.');
    } catch (e) {
      setSeedStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="p-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5" style={{ alignItems: 'start' }}>
        <div className="space-y-5">
          <PreferencesSectionCard title="System & Interface" icon={PreferencesSystemIcon}>
            <CheckboxRow
              label="Show Gmail-style important markers (Gmail Only)"
              checked={s.showGmailStyleImportantMarkers}
              onChange={s.setShowGmailStyleImportantMarkers}
            />
            <CheckboxRow
              label="Show unread counts for all folders / labels"
              checked={s.showUnreadCountsForAllFolders}
              onChange={s.setShowUnreadCountsForAllFolders}
            />
            <CheckboxRow
              label="Use 24-hour clock"
              checked={s.use24HourClock}
              onChange={s.setUse24HourClock}
            />
          </PreferencesSectionCard>

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

          <PreferencesSectionCard title="Notifications" icon={PreferencesNotificationsIcon}>
            <p className="text-xs text-[var(--muted-text)]">
              Detailed notification controls have moved to the{' '}
              <span className="font-medium text-[var(--primary)]">Notifications</span> tab.
            </p>
          </PreferencesSectionCard>
        </div>

        <div className="space-y-5">
          <PreferencesSectionCard title="Reading" icon={PreferencesReadingIcon}>
            <SelectRow
              label="When reading messages, mark as read:"
              value={s.markAsReadDelay}
              options={[
                { value: 'immediate', label: 'Immediately' },
                { value: '0.5', label: 'After 0.5 Seconds' },
                { value: '1', label: 'After 1 Second' },
                { value: '3', label: 'After 3 Seconds' },
              ]}
              onChange={s.setMarkAsReadDelay}
            />
            <CheckboxRow
              label="Show first and last names of all recipients"
              checked={s.showRecipientFullNames}
              onChange={s.setShowRecipientFullNames}
            />
            <CheckboxRow
              label="Restrict width of messages to maximize readability"
              checked={s.restrictMessageWidth}
              onChange={s.setRestrictMessageWidth}
            />
            <CheckboxRow
              label="Move to trash (not archive) on swipe / backspace"
              checked={s.moveToTrashOnSwipe}
              onChange={s.setMoveToTrashOnSwipe}
            />
            <CheckboxRow
              label="Disable swipe gestures on the thread list"
              checked={s.disableSwipeGestures}
              onChange={s.setDisableSwipeGestures}
            />
            <CheckboxRow
              label="Display conversations in descending chronological order"
              checked={s.descendingConversations}
              onChange={s.setDescendingConversations}
            />
          </PreferencesSectionCard>

          <PreferencesSectionCard title="Development data" icon={PreferencesLocalDataIcon}>
            <p className="text-sm text-[var(--muted-text)] mb-3">
              Generate realistic dummy accounts, contacts, emails, attachments, calendar events, signatures, templates, and tasks for local testing.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void handleSeed()}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity"
              >
                Seed dummy data
              </button>
              <button
                type="button"
                onClick={() => void handleClear()}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
              >
                Clear dummy data
              </button>
            </div>
            {seedStatus && (
              <p className="mt-3 text-xs text-[var(--muted-text)]">{seedStatus}</p>
            )}
          </PreferencesSectionCard>
        </div>
      </div>
    </div>
  );
}

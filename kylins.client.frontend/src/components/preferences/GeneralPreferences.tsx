import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { getAutostartState, setAutostartEnabled } from '../../services/startup/autostart';
import { formatFileSize } from '../../utils/fileTypeHelpers';
import {
  PreferencesSystemIcon,
  PreferencesLanguageIcon,
  PreferencesReadingIcon,
  PreferencesComposingIcon,
  PreferencesSendingIcon,
  PreferencesNotificationsIcon,
  PreferencesLocalDataIcon,
  PreferencesPrivacySecurityIcon,
} from '../icons';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { CheckboxRow, SelectRow, ButtonRow } from './PreferenceRows';
import { PreferencesTabLayout } from './PreferencesTabLayout';

export function GeneralPreferences() {
  const s = usePreferencesStore();
  const [cacheSize, setCacheSize] = useState<number | null>(null);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);

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

  useEffect(() => {
    async function loadCacheSize() {
      try {
        const size = await invoke<number>('get_cache_size');
        setCacheSize(size);
      } catch (err) {
        console.error('Failed to load cache size:', err);
        setCacheSize(null);
      }
    }
    void loadCacheSize();
  }, []);

  async function handleLaunchChange(value: boolean) {
    s.setLaunchOnSystemStart(value);
    await setAutostartEnabled(value);
  }

  async function handleClearCache() {
    setCacheStatus('Clearing…');
    try {
      await invoke('clear_cache');
      const size = await invoke<number>('get_cache_size');
      setCacheSize(size);
      setCacheStatus('Cache cleared.');
    } catch (err) {
      setCacheStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleRevealLogs() {
    try {
      await invoke('reveal_logs_directory');
    } catch (err) {
      console.error('Failed to reveal logs directory:', err);
    }
  }

  return (
    <PreferencesTabLayout>
      <div className="space-y-5">
        <PreferencesSectionCard title="System & Interface" icon={PreferencesSystemIcon}>
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
          <CheckboxRow
            label="Show Gmail-style important markers (Gmail only)"
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

        <PreferencesSectionCard title="Reading" icon={PreferencesReadingIcon}>
          <SelectRow
            label="When reading messages, mark as read"
            value={s.markAsReadDelay}
            options={[
              { value: 'immediate', label: 'Immediately' },
              { value: '0.5', label: 'After 0.5 seconds' },
              { value: '1', label: 'After 1 second' },
              { value: '3', label: 'After 3 seconds' },
            ]}
            onChange={s.setMarkAsReadDelay}
          />
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
            label="Display conversations in descending chronological order"
            checked={s.descendingConversations}
            onChange={s.setDescendingConversations}
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
        </PreferencesSectionCard>

        <PreferencesSectionCard title="Composing" icon={PreferencesComposingIcon}>
          <CheckboxRow
            label="Enable rich text and advanced editor features"
            checked={s.enableRichText}
            onChange={s.setEnableRichText}
          />
          <div className="ml-7 p-3 rounded-lg bg-[var(--highlight)] border border-[var(--border)] text-sm text-[var(--foreground)]">
            <span className="font-semibold text-[var(--foreground)]">Note:</span> Many features are
            unavailable in plain-text mode. To create a single plain-text draft, hold Alt or Option
            while clicking Compose or Reply.
          </div>
          <CheckboxRow
            label="Check messages for spelling"
            checked={s.checkSpelling}
            onChange={s.setCheckSpelling}
          />
          <CheckboxRow
            label="Check messages for grammar"
            checked={s.checkGrammar}
            onChange={s.setCheckGrammar}
          />
          <SelectRow
            label="Spellcheck language"
            value={s.spellcheckLanguage}
            options={[
              { value: 'system', label: '(System default)' },
              { value: 'en', label: 'English' },
              { value: 'zh', label: '中文' },
            ]}
            onChange={s.setSpellcheckLanguage}
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
            label="After sending, enable undo for"
            value={s.undoSendDuration}
            options={[
              { value: '0', label: 'Off' },
              { value: '5', label: '5 seconds' },
              { value: '10', label: '10 seconds' },
              { value: '30', label: '30 seconds' },
            ]}
            onChange={s.setUndoSendDuration}
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

        <PreferencesSectionCard title="Storage & Attachments" icon={PreferencesLocalDataIcon}>
          <ButtonRow
            label="Cache size"
            description={cacheSize === null ? 'Loading…' : `Using ${formatFileSize(cacheSize)}`}
          >
            <button
              type="button"
              onClick={() => void handleClearCache()}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
            >
              Clear cache
            </button>
          </ButtonRow>
          {cacheStatus && <p className="text-xs text-[var(--muted-text)]">{cacheStatus}</p>}
          <CheckboxRow
            label="Automatically clean up cached attachments and previews"
            checked={s.cacheAutoCleanupEnabled}
            onChange={s.setCacheAutoCleanupEnabled}
          />
          <CheckboxRow
            label="Display thumbnail previews for attachments when available"
            checked={s.displayAttachmentThumbnails}
            onChange={s.setDisplayAttachmentThumbnails}
          />
          <CheckboxRow
            label="Open containing folder after downloading an attachment"
            checked={s.openAttachmentFolder}
            onChange={s.setOpenAttachmentFolder}
          />
          <ButtonRow label="Application logs" description="Open the folder containing Kylins logs.">
            <button
              type="button"
              onClick={() => void handleRevealLogs()}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
            >
              Show logs
            </button>
          </ButtonRow>
        </PreferencesSectionCard>

        <PreferencesSectionCard title="Privacy & Security" icon={PreferencesPrivacySecurityIcon}>
          <CheckboxRow
            label="Share diagnostic and usage data to help improve Kylins"
            checked={s.shareDiagnosticsData}
            onChange={s.setShareDiagnosticsData}
          />
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
          <ButtonRow
            label="Clear local data"
            description="Remove cached data, allowlists, and reset preferences."
          >
            <button
              type="button"
              disabled
              className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] disabled:opacity-50"
            >
              Reset local data
            </button>
          </ButtonRow>
        </PreferencesSectionCard>
      </div>
    </PreferencesTabLayout>
  );
}

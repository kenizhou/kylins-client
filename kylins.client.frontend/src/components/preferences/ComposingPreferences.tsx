import { usePreferencesStore } from '../../stores/preferencesStore';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { CheckboxRow, SelectRow } from './PreferenceRows';
import { PreferencesComposingIcon, PreferencesSendingIcon } from '../icons';

export function ComposingPreferences() {
  const s = usePreferencesStore();

  return (
    <div className="p-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5" style={{ alignItems: 'start' }}>
        <PreferencesSectionCard title="Editor" icon={PreferencesComposingIcon}>
          <CheckboxRow
            label="Enable rich text and advanced editor features"
            checked={s.enableRichText}
            onChange={s.setEnableRichText}
          />
          <div className="ml-7 p-3 rounded-lg bg-[color-mix(in_oklab,var(--primary),transparent_92%)] border border-[color-mix(in_oklab,var(--primary),transparent_80%)] text-sm text-[var(--foreground)]">
            <span className="font-semibold text-[var(--primary)]">NOTE:</span> Many features
            are unavailable in plain-text mode. To create a single plain-text draft, hold Alt
            or Option while clicking Compose or Reply.
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
            label="Spellcheck language:"
            value={s.spellcheckLanguage}
            options={[
              { value: 'system', label: '(System Default)' },
              { value: 'en', label: 'English' },
              { value: 'zh', label: '中文' },
            ]}
            onChange={s.setSpellcheckLanguage}
          />
        </PreferencesSectionCard>

        <PreferencesSectionCard title="Sending" icon={PreferencesSendingIcon}>
          <CheckboxRow
            label="Message Sent Sound"
            checked={s.messageSentSound}
            onChange={s.setMessageSentSound}
          />
          <SelectRow
            label="Default send behavior:"
            value={s.defaultSendBehavior}
            options={[
              { value: 'send', label: 'Send' },
              { value: 'send-later', label: 'Send Later' },
            ]}
            onChange={s.setDefaultSendBehavior}
          />
          <SelectRow
            label="Default reply behavior:"
            value={s.defaultReplyBehavior}
            options={[
              { value: 'reply', label: 'Reply' },
              { value: 'reply-all', label: 'Reply All' },
            ]}
            onChange={s.setDefaultReplyBehavior}
          />
          <SelectRow
            label="After sending, enable undo for:"
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
            label="Send new messages from:"
            value={s.sendNewMessagesFrom}
            options={[
              { value: 'selected-account', label: 'Selected Account' },
              { value: 'default-account', label: 'Default Account' },
            ]}
            onChange={s.setSendNewMessagesFrom}
          />
        </PreferencesSectionCard>
      </div>
    </div>
  );
}

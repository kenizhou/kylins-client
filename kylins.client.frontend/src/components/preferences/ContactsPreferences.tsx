import { useState } from 'react';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { PreferencesTabLayout, PreferencesTabColumns } from './PreferencesTabLayout';
import { ContactsIcon, UploadIcon, DownloadIcon } from '../icons';
import { usePreferencesStore } from '@/stores/preferencesStore';

export function ContactsPreferences() {
  const [defaultSort, setDefaultSort] = useState('frequency');
  const autoExtractFromMail = usePreferencesStore((s) => s.autoExtractContactsFromMail);
  const setAutoExtractFromMail = usePreferencesStore((s) => s.setAutoExtractContactsFromMail);
  const autoExtractFromReceived = usePreferencesStore((s) => s.autoExtractContactsFromReceived);
  const setAutoExtractFromReceived = usePreferencesStore(
    (s) => s.setAutoExtractContactsFromReceived,
  );

  return (
    <PreferencesTabLayout>
      <PreferencesTabColumns
        left={
          <>
            <PreferencesSectionCard title="Contacts settings" icon={ContactsIcon}>
              <div className="space-y-4">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-[var(--muted-text)]">Default sort order</label>
                  <select
                    value={defaultSort}
                    onChange={(e) => setDefaultSort(e.target.value)}
                    className="rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                  >
                    <option value="frequency">Most frequently contacted</option>
                    <option value="name">Name (A–Z)</option>
                    <option value="recent">Most recently contacted</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm text-[var(--foreground)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoExtractFromMail}
                      onChange={(e) => setAutoExtractFromMail(e.target.checked)}
                      className="rounded border-[var(--border)] bg-[var(--background)] text-[var(--primary)]"
                    />
                    Extract contacts from outgoing mail
                  </label>
                  <p className="text-xs text-[var(--muted-text)] pl-6">
                    Adds To/Cc/Bcc recipients from sent messages and the send flow.
                  </p>

                  <label className="flex items-center gap-2 text-sm text-[var(--foreground)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoExtractFromReceived}
                      onChange={(e) => setAutoExtractFromReceived(e.target.checked)}
                      className="rounded border-[var(--border)] bg-[var(--background)] text-[var(--primary)]"
                    />
                    Extract contacts from incoming mail
                  </label>
                  <p className="text-xs text-[var(--muted-text)] pl-6">
                    Adds senders from Inbox/Archive. Off by default to reduce noise.
                  </p>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs text-[var(--muted-text)]">vCard import/export</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => alert('Import vCard — coming in Phase 1 sync wiring.')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
                    >
                      <UploadIcon size={13} />
                      Import vCard
                    </button>
                    <button
                      type="button"
                      onClick={() => alert('Export vCard — coming in Phase 1 sync wiring.')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
                    >
                      <DownloadIcon size={13} />
                      Export vCard
                    </button>
                  </div>
                </div>
              </div>
            </PreferencesSectionCard>
          </>
        }
        right={
          <>
            <PreferencesSectionCard title="Sync accounts" icon={ContactsIcon}>
              <p className="text-sm text-[var(--muted-text)]">
                CardDAV, Google Contacts, and Exchange contact sync accounts will appear here once
                implemented.
              </p>
            </PreferencesSectionCard>
          </>
        }
      />
    </PreferencesTabLayout>
  );
}

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { CheckboxRow, ButtonRow } from './PreferenceRows';
import { formatFileSize } from '../../utils/fileTypeHelpers';
import { PreferencesLocalDataIcon } from '../icons';

export function StoragePreferences() {
  const s = usePreferencesStore();
  const [cacheSize, setCacheSize] = useState<number | null>(null);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);

  async function loadCacheSize() {
    try {
      const size = await invoke<number>('get_cache_size');
      setCacheSize(size);
    } catch (err) {
      console.error('Failed to load cache size:', err);
      setCacheSize(null);
    }
  }

  useEffect(() => {
    loadCacheSize();
  }, []);

  async function handleClearCache() {
    setCacheStatus('Clearing…');
    try {
      await invoke('clear_cache');
      await loadCacheSize();
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
    <div className="p-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5" style={{ alignItems: 'start' }}>
        <PreferencesSectionCard title="Cache" icon={PreferencesLocalDataIcon}>
          <ButtonRow
            label="Cache size"
            description={cacheSize === null ? 'Loading…' : `Using ${formatFileSize(cacheSize)}`}
          >
            <button
              type="button"
              onClick={() => void handleClearCache()}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
            >
              Clear Cache
            </button>
          </ButtonRow>
          {cacheStatus && <p className="text-xs text-[var(--muted-text)]">{cacheStatus}</p>}
          <CheckboxRow
            label="Automatically clean up cached attachments and previews"
            checked={s.cacheAutoCleanupEnabled}
            onChange={s.setCacheAutoCleanupEnabled}
          />
        </PreferencesSectionCard>

        <PreferencesSectionCard title="Attachments" icon={PreferencesLocalDataIcon}>
          <CheckboxRow
            label="Open containing folder after downloading attachment"
            checked={s.openAttachmentFolder}
            onChange={s.setOpenAttachmentFolder}
          />
          <CheckboxRow
            label="Display thumbnail previews for attachments when available"
            checked={s.displayAttachmentThumbnails}
            onChange={s.setDisplayAttachmentThumbnails}
          />
        </PreferencesSectionCard>

        <PreferencesSectionCard title="Local data" icon={PreferencesLocalDataIcon}>
          <ButtonRow
            label="Application logs"
            description="Open the folder containing Kylins logs."
          >
            <button
              type="button"
              onClick={() => void handleRevealLogs()}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
            >
              Show logs
            </button>
          </ButtonRow>
          <ButtonRow
            label="Reset accounts and settings"
            description="Remove all accounts and reset preferences to defaults."
          >
            <button
              type="button"
              disabled
              className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] disabled:opacity-50"
            >
              Reset everything
            </button>
          </ButtonRow>
        </PreferencesSectionCard>
      </div>
    </div>
  );
}

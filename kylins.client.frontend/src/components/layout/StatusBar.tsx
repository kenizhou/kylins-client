import { Button } from 'react-aria-components';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import { useUIStore } from '../../stores/uiStore';
import { useAccountStore } from '../../stores/accountStore';
import { useViewStore } from '../../features/view/viewStore';
import type { MessageListDensity, ReadingPanePosition } from '../../features/view/types';
import { formatRelativeTime } from '../../utils/relativeTime';
import { PlusIcon, MinimizeIcon, SpinnerIcon } from '../icons';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;

const DENSITY_LABEL: Record<MessageListDensity, string> = {
  compact: 'Compact',
  normal: 'Normal',
  comfortable: 'Comfortable',
};

const POSITION_LABEL: Record<ReadingPanePosition, string> = {
  right: 'Reading pane right',
  bottom: 'Reading pane bottom',
  off: 'Reading pane off',
};

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

// Priority order: higher beats lower for the "worst state" StatusBar label.
// rate_limited > syncing > error > idle. (syncing wins over error because a
// syncing account with an error elsewhere still shows "Syncing…".)
const STATE_PRIORITY: Record<string, number> = {
  rate_limited: 4,
  syncing: 3,
  error: 2,
  idle: 1,
};

function pickWorstState(states: Record<string, string>): string | undefined {
  let worst: string | undefined;
  let worstPri = 0;
  for (const s of Object.values(states)) {
    const pri = STATE_PRIORITY[s] ?? 0;
    if (pri > worstPri) {
      worstPri = pri;
      worst = s;
    }
  }
  return worst;
}

function SyncStatusIndicator() {
  const aggregatedPending = useUIStore((s) => s.aggregatedPending);
  const syncStateByAccount = useUIStore((s) => s.syncStateByAccount);
  const accounts = useAccountStore((s) => s.accounts);

  // Tick every 30s so "2m ago" rolls forward without a sync event.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const triggerSync = async () => {
    try {
      await invoke('sync_start');
    } catch (e) {
      console.error('StatusBar sync trigger failed:', e);
    }
  };

  const worst = pickWorstState(syncStateByAccount);

  const dotColor =
    worst === 'rate_limited'
      ? 'var(--warning)'
      : worst === 'syncing'
        ? 'var(--primary)'
        : worst === 'error'
          ? 'var(--destructive)'
          : 'var(--success)';

  const content = (() => {
    if (worst === 'rate_limited') {
      return <span title="A provider asked us to slow down">Rate limited</span>;
    }
    if (worst === 'syncing') {
      return <span>Syncing…</span>;
    }
    if (worst === 'error') {
      return <span title="Last sync round failed for at least one account">Sync error</span>;
    }
    // idle or no state reported yet -> "Synced · {relative}".
    const def = accounts.find((a) => a.isDefault) ?? accounts[0];
    const rel = formatRelativeTime(def?.lastSyncAt ?? null);
    return (
      <span title={def?.lastSyncAt ? new Date(def.lastSyncAt * 1000).toLocaleString() : undefined}>
        {aggregatedPending > 0 ? `Offline — ${aggregatedPending} pending` : `Synced · ${rel}`}
      </span>
    );
  })();

  return (
    <button
      type="button"
      onClick={triggerSync}
      aria-label="Sync now"
      className="inline-flex items-center gap-1.5 hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded px-1"
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: dotColor }}
      />
      {content}
    </button>
  );
}

function SendProgressIndicator() {
  const sendProgress = useUIStore((s) => s.sendProgress);
  if (!sendProgress.active) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[var(--primary)]"
      title={sendProgress.message}
    >
      <SpinnerIcon size={12} />
      <span>{sendProgress.message ?? 'Sending…'}</span>
    </span>
  );
}

function SelectionIndicator() {
  const selectedThreadIds = useViewStore((s) => s.selectedThreadIds);
  const count = selectedThreadIds.length;
  if (count === 0) return null;
  return <span>{count} selected</span>;
}

export function StatusBar() {
  const readerZoom = useUIStore((s) => s.readerZoom);
  const setReaderZoom = useUIStore((s) => s.setReaderZoom);
  const messageListDensity = useViewStore((s) => s.messageListDensity);
  const readingPanePosition = useViewStore((s) => s.readingPanePosition);

  return (
    <footer className="h-[var(--status-h)] flex items-center justify-between px-3 text-xs bg-[var(--chrome)] border-t border-[var(--border-subtle)] text-[var(--muted-text)] shrink-0">
      <div className="flex items-center gap-3">
        <SyncStatusIndicator />
        <SendProgressIndicator />
        <SelectionIndicator />
      </div>
      <div className="flex items-center gap-3">
        <InjectedComponentSet role="status-bar" containersRequired={false} />
        <div className="flex items-center gap-0.5">
          <Button
            onPress={() => setReaderZoom(clampZoom(+(readerZoom - 0.1).toFixed(1)))}
            aria-label="Zoom out"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-40"
          >
            <MinimizeIcon size={11} />
          </Button>
          <Button
            onPress={() => setReaderZoom(1)}
            aria-label="Reset zoom"
            className="min-w-11 h-7 text-center tabular-nums rounded-md transition-colors hover:text-[var(--foreground)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-40"
          >
            {Math.round(readerZoom * 100)}%
          </Button>
          <Button
            onPress={() => setReaderZoom(clampZoom(+(readerZoom + 0.1).toFixed(1)))}
            aria-label="Zoom in"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-40"
          >
            <PlusIcon size={11} />
          </Button>
        </div>
        <span>{DENSITY_LABEL[messageListDensity]}</span>
        <span className="mx-1 h-3 w-px bg-[var(--border-subtle)]" />
        <span>{POSITION_LABEL[readingPanePosition]}</span>
      </div>
    </footer>
  );
}

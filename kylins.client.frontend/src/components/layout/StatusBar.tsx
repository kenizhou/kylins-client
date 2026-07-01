import { useEffect, useState } from 'react';
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import { useUIStore } from '../../stores/uiStore';
import { useAccountStore } from '../../stores/accountStore';
import { formatRelativeTime } from '../../utils/relativeTime';
import { IconButton } from '@/components/ui/IconButton';
import { PlusIcon, MinimizeIcon } from '../icons';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;

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

  const worst = pickWorstState(syncStateByAccount);

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
}

export function StatusBar() {
  const readerZoom = useUIStore((s) => s.readerZoom);
  const setReaderZoom = useUIStore((s) => s.setReaderZoom);

  return (
    <footer className="h-[var(--status-h)] flex items-center justify-between px-3 text-[11px] bg-[var(--chrome)] text-[var(--muted-text)] shrink-0">
      <div className="flex items-center gap-3">
        <SyncStatusIndicator />
        <span>1 selected</span>
      </div>
      <div className="flex items-center gap-3">
        <InjectedComponentSet role="status-bar" containersRequired={false} />
        <div className="flex items-center gap-0.5">
          <IconButton
            icon={<MinimizeIcon size={11} />}
            title="Zoom out"
            onClick={() => setReaderZoom(clampZoom(+(readerZoom - 0.1).toFixed(1)))}
          />
          <button
            type="button"
            onClick={() => setReaderZoom(1)}
            className="min-w-[2.5rem] h-8 text-center tabular-nums rounded transition-colors hover:text-[var(--foreground)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            title="Reset zoom"
          >
            {Math.round(readerZoom * 100)}%
          </button>
          <IconButton
            icon={<PlusIcon size={11} />}
            title="Zoom in"
            onClick={() => setReaderZoom(clampZoom(+(readerZoom + 0.1).toFixed(1)))}
          />
        </div>
        <span>Compact</span>
        <span>Reading pane right</span>
      </div>
    </footer>
  );
}

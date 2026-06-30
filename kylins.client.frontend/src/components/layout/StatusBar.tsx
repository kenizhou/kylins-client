import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import { useUIStore } from '../../stores/uiStore';
import { IconButton } from '@/components/ui/IconButton';
import { PlusIcon, MinimizeIcon } from '../icons';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function StatusBar() {
  const readerZoom = useUIStore((s) => s.readerZoom);
  const setReaderZoom = useUIStore((s) => s.setReaderZoom);
  const pendingCount = useUIStore((s) => s.pendingCount);

  return (
    <footer className="h-[var(--status-h)] flex items-center justify-between px-3 text-[11px] bg-[var(--chrome)] text-[var(--muted-text)] shrink-0">
      <div className="flex items-center gap-3">
        <span>Synced · 3 accounts</span>
        <span>1 selected</span>
        {pendingCount > 0 && (
          <span title={`${pendingCount} operation${pendingCount === 1 ? '' : 's'} pending sync`}>
            {pendingCount} pending
          </span>
        )}
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

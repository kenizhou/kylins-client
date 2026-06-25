import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import { useUIStore } from '../../stores/uiStore';
import { PlusIcon, MinimizeIcon } from '../icons';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function StatusBar() {
  const readerZoom = useUIStore((s) => s.readerZoom);
  const setReaderZoom = useUIStore((s) => s.setReaderZoom);

  return (
    <footer className="h-[var(--status-h)] flex items-center justify-between px-3 text-[11px] bg-[var(--chrome)] text-[var(--muted-text)] shrink-0">
      <div className="flex items-center gap-3">
        <span>Synced · 3 accounts</span>
        <span>1 selected</span>
      </div>
      <div className="flex items-center gap-3">
        <InjectedComponentSet role="status-bar" containersRequired={false} />
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setReaderZoom(clampZoom(+(readerZoom - 0.1).toFixed(1)))}
            aria-label="Zoom out"
            className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
          >
            <MinimizeIcon size={11} />
          </button>
          <button
            type="button"
            onClick={() => setReaderZoom(1)}
            className="min-w-[2.5rem] text-center tabular-nums transition-colors hover:text-[var(--foreground)]"
            title="Reset zoom"
          >
            {Math.round(readerZoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setReaderZoom(clampZoom(+(readerZoom + 0.1).toFixed(1)))}
            aria-label="Zoom in"
            className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
          >
            <PlusIcon size={11} />
          </button>
        </div>
        <span>Compact</span>
        <span>Reading pane right</span>
      </div>
    </footer>
  );
}

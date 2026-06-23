import { useViewStore } from '../viewStore';
import { DEFAULT_MESSAGE_LIST_COLUMNS } from '../defaults';

interface ViewSettingsDialogProps {
  onClose: () => void;
}

export function ViewSettingsDialog({ onClose }: ViewSettingsDialogProps) {
  const visibleColumnIds = useViewStore((s) => s.visibleColumnIds);
  const setVisibleColumnIds = useViewStore((s) => s.setVisibleColumnIds);
  const resetToDefaults = useViewStore((s) => s.resetToDefaults);

  const toggleColumn = (id: string) => {
    if (visibleColumnIds.includes(id)) {
      setVisibleColumnIds(visibleColumnIds.filter((c) => c !== id));
    } else {
      setVisibleColumnIds([...visibleColumnIds, id]);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40">
      <div className="w-[480px] max-h-[80vh] flex flex-col bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <h2 className="text-base font-semibold text-[var(--foreground)]">View Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--muted-text)] hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-[var(--foreground)] mb-2">
              Message list columns
            </h3>
            <div className="space-y-1">
              {DEFAULT_MESSAGE_LIST_COLUMNS.map((col) => (
                <label
                  key={col.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--hover)] cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={visibleColumnIds.includes(col.id)}
                    onChange={() => toggleColumn(col.id)}
                    className="rounded border-[var(--border)]"
                  />
                  <span className="text-sm text-[var(--foreground)]">{col.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border)]">
          <button
            type="button"
            onClick={() => {
              resetToDefaults();
            }}
            className="text-sm text-[var(--muted-text)] hover:text-[var(--foreground)]"
          >
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-sm rounded bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

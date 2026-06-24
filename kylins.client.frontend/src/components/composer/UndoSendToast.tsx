// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// "Sending… Undo" toast shown during the configurable undo-send window. velo
// wraps this in CSSTransition; Kylins uses a plain conditional render (the
// slide-in/countdown animations live in globals.css under .composer-toast).

import { useComposerStore } from '@/stores/composerStore';

export function UndoSendToast() {
  const undoSendVisible = useComposerStore((s) => s.undoSendVisible);
  const undoSendTimer = useComposerStore((s) => s.undoSendTimer);
  const setUndoSendTimer = useComposerStore((s) => s.setUndoSendTimer);
  const setUndoSendVisible = useComposerStore((s) => s.setUndoSendVisible);

  if (!undoSendVisible) return null;

  const handleUndo = () => {
    if (undoSendTimer) {
      clearTimeout(undoSendTimer);
      setUndoSendTimer(null);
    }
    setUndoSendVisible(false);
  };

  return (
    <div className="composer-toast fixed bottom-4 left-1/2 z-[80] -translate-x-1/2 overflow-hidden rounded-lg bg-[var(--foreground)] text-[var(--background)] shadow-lg">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <span className="text-sm">Sending email...</span>
        <button
          onClick={handleUndo}
          className="text-sm font-medium text-[var(--primary)] underline hover:opacity-80"
        >
          Undo
        </button>
      </div>
      <div className="h-0.5 bg-white/20">
        <div className="composer-countdown h-full rounded-full bg-[var(--primary)]" />
      </div>
    </div>
  );
}

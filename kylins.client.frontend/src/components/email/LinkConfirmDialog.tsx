// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Confirmation gate shown before opening a link that looks suspicious (display
// text host ≠ href host, IP-literal host, or the message itself is flagged).
// Surfaces the real destination so the user can make an informed choice.

import { AttachmentIcon } from '../icons';

interface LinkConfirmDialogProps {
  href: string;
  displayText?: string;
  suspicious: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function LinkConfirmDialog({
  href,
  displayText,
  suspicious,
  onConfirm,
  onCancel,
}: LinkConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center bg-black/30"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-96 rounded-md border border-[var(--border)] bg-[var(--background)] p-4 shadow-xl"
      >
        <h3 className="mb-1 text-sm font-semibold text-[var(--foreground)]">Open this link?</h3>
        <p className="mb-3 text-xs text-[var(--muted-text)]">
          {suspicious
            ? 'This link may be misleading. The address you would open is shown below — confirm only if you trust it.'
            : 'You are about to open an external link.'}
        </p>

        {displayText && displayText.trim() && (
          <div className="mb-2">
            <div className="mb-0.5 text-[0.625rem] uppercase text-[var(--muted-foreground)]">
              Link text
            </div>
            <div className="break-all rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--foreground)]">
              {displayText}
            </div>
          </div>
        )}
        <div className="mb-4">
          <div className="mb-0.5 flex items-center gap-1 text-[0.625rem] uppercase text-[var(--muted-foreground)]">
            <AttachmentIcon size={10} /> Destination
          </div>
          <div className="break-all rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 font-mono text-xs text-[var(--foreground)]">
            {href}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="h-7 rounded px-3 text-sm text-[var(--foreground)] hover:bg-[var(--hover)]"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`h-7 rounded px-3 text-sm text-[var(--primary-fg)] ${
              suspicious ? 'bg-[var(--destructive)]' : 'bg-[var(--primary)]'
            } hover:opacity-90`}
          >
            Open link
          </button>
        </div>
      </div>
    </div>
  );
}

// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Confirmation gate shown before opening a link that looks suspicious (display
// text host ≠ href host, IP-literal host, or the message itself is flagged).
// Surfaces the real destination so the user can make an informed choice.

import { useEffect } from 'react';
import { LinkIcon, BellIcon } from '../icons';

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
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onConfirm, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="link-confirm-title"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--background)] p-5 shadow-xl"
      >
        <div className="mb-3 flex items-start gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              suspicious
                ? 'bg-[var(--destructive)]/10 text-[var(--destructive)]'
                : 'bg-[var(--accent)] text-[var(--selected-text)]'
            }`}
          >
            {suspicious ? <BellIcon size={18} /> : <LinkIcon size={18} />}
          </div>
          <div className="min-w-0 flex-1">
            <h3 id="link-confirm-title" className="text-sm font-semibold text-[var(--foreground)]">
              {suspicious ? 'Suspicious link' : 'Open this link?'}
            </h3>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted-text)]">
              {suspicious
                ? 'This link may be misleading. The address below is the real destination — open it only if you trust it.'
                : 'You are about to open an external link.'}
            </p>
          </div>
        </div>

        {displayText && displayText.trim() && (
          <div className="mb-3">
            <div className="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-text)]">
              Link text
            </div>
            <div className="break-words rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)]">
              {displayText}
            </div>
          </div>
        )}

        <div className="mb-5">
          <div className="mb-1 flex items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-text)]">
            <LinkIcon size={10} /> Destination
          </div>
          <div className="break-all rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-xs text-[var(--foreground)]">
            {href}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="h-8 rounded-md px-3 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--hover)]"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`h-8 rounded-md px-3 text-sm text-[var(--primary-fg)] transition-colors hover:opacity-90 ${
              suspicious ? 'bg-[var(--destructive)]' : 'bg-[var(--primary)]'
            }`}
          >
            {suspicious ? 'Open anyway' : 'Open link'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Confirmation gate shown before opening a link that looks suspicious (display
// text host ≠ href host, IP-literal host, or the message itself is flagged).
// Surfaces the real destination so the user can make an informed choice.

import { useEffect } from 'react';
import { LinkIcon, BellIcon } from '../icons';
import { Button, Dialog, Modal as RACModal, ModalOverlay } from 'react-aria-components';

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
      if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onConfirm]);

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      isDismissable
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-black/40 p-4"
    >
      <RACModal className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-xl outline-none">
        <Dialog
          aria-label={suspicious ? 'Suspicious link' : 'Open this link?'}
          className="outline-none"
        >
          <div className="mb-3 flex items-start gap-3">
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                suspicious
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-highlight text-highlight-text'
              }`}
            >
              {suspicious ? <BellIcon size={18} /> : <LinkIcon size={18} />}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-foreground">
                {suspicious ? 'Suspicious link' : 'Open this link?'}
              </h3>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-text">
                {suspicious
                  ? 'This link may be misleading. The address below is the real destination — open it only if you trust it.'
                  : 'You are about to open an external link.'}
              </p>
            </div>
          </div>

          {displayText && displayText.trim() && (
            <div className="mb-3">
              <div className="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted-text">
                Link text
              </div>
              <div className="break-words rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground">
                {displayText}
              </div>
            </div>
          )}

          <div className="mb-5">
            <div className="mb-1 flex items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted-text">
              <LinkIcon size={10} /> Destination
            </div>
            <div className="break-all rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground">
              {href}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              slot="close"
              className="h-8 rounded-md px-3 text-sm text-foreground transition-colors hover:bg-hover"
            >
              Cancel
            </Button>
            <Button
              onPress={onConfirm}
              className={`h-8 rounded-md px-3 text-sm text-primary-fg transition-colors hover:opacity-90 ${
                suspicious ? 'bg-destructive' : 'bg-primary'
              }`}
            >
              {suspicious ? 'Open anyway' : 'Open link'}
            </Button>
          </div>
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
}

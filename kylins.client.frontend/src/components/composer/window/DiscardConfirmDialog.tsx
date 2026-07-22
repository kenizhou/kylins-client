import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';

export interface DiscardConfirmDialogProps {
  isOpen: boolean;
  onDiscard: () => void;
  onCancel: () => void;
}

/**
 * Discard confirmation: shown before deleting the draft from the overflow
 * menu's Discard action. Cancel / Discard (destructive).
 */
export function DiscardConfirmDialog({ isOpen, onDiscard, onCancel }: DiscardConfirmDialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-[var(--backdrop)]"
    >
      <Modal className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-floating)] shadow-[var(--shadow-lg)]">
        <Dialog className="w-80 p-4 outline-none" aria-label="Discard this draft?">
          <Heading slot="title" className="text-sm font-medium text-[var(--foreground)]">
            Discard this draft?
          </Heading>
          <p className="mt-1 text-xs text-[var(--muted-text)]">
            Your message and its saved draft will be permanently deleted.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              onPress={onCancel}
              autoFocus
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Cancel
            </Button>
            <Button
              onPress={onDiscard}
              className="rounded-lg bg-[var(--destructive)] px-3 py-1.5 text-xs font-medium text-[var(--destructive-foreground,var(--primary-fg))] shadow-[var(--shadow-sm)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Discard
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

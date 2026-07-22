import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';

export interface CloseConfirmDialogProps {
  isOpen: boolean;
  onSaveDraft: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

/**
 * Pop-out close confirmation: shown when the window close is requested with
 * unsaved content. Save Draft / Don't Save / Cancel.
 */
export function CloseConfirmDialog({
  isOpen,
  onSaveDraft,
  onDiscard,
  onCancel,
}: CloseConfirmDialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-[var(--backdrop)]"
    >
      <Modal className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-floating)] shadow-[var(--shadow-lg)]">
        <Dialog className="w-80 p-4 outline-none" aria-label="Save this draft?">
          <Heading slot="title" className="text-sm font-medium text-[var(--foreground)]">
            Save this draft?
          </Heading>
          <p className="mt-1 text-xs text-[var(--muted-text)]">Your message has unsaved changes.</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              onPress={onSaveDraft}
              className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-fg)] shadow-[var(--shadow-sm)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Yes
            </Button>
            <Button
              onPress={onDiscard}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--destructive)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              No
            </Button>
            <Button
              onPress={onCancel}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Cancel
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

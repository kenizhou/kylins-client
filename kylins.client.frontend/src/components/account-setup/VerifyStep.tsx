import { useState } from 'react';
import { CloseIcon } from '../icons';
import { Modal } from '../ui/Modal';
import { SetupCard, SetupButton, SetupBackButton } from './setup-ui';

export interface VerifyStepProps {
  error?: string | null;
  onRetry?: () => void;
  onBack?: () => void;
  onReplace?: () => void;
}

export function VerifyStep({ error, onRetry, onBack, onReplace }: VerifyStepProps) {
  const isDuplicateError = error?.toLowerCase().includes('already exists') ?? false;
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);

  return (
    <SetupCard>
      <div className="flex flex-col items-center gap-5 py-6 text-center">
        {error ? (
          <>
            <div className="success-pop grid h-14 w-14 place-items-center rounded-full bg-error-bg">
              <CloseIcon size={28} className="text-destructive" aria-hidden="true" />
            </div>
            <div className="flex flex-col gap-1" role="alert" aria-live="assertive">
              <h1 className="text-balance text-xl font-semibold text-destructive">
                Couldn’t connect
              </h1>
              <p className="max-w-xs text-balance text-sm text-muted-text">{error}</p>
            </div>
            <div className="mt-2 flex items-center gap-3">
              {onBack && <SetupBackButton onPress={onBack} />}
              {isDuplicateError && onReplace && (
                <SetupButton onPress={() => setReplaceConfirmOpen(true)}>
                  Replace existing account
                </SetupButton>
              )}
              {onRetry && <SetupButton onPress={onRetry}>Retry</SetupButton>}
            </div>
          </>
        ) : (
          <>
            <span className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <div className="flex flex-col gap-1">
              <h1 className="text-balance text-xl font-semibold text-foreground">Connecting…</h1>
              <p className="text-balance text-sm text-muted-text">
                Verifying your credentials and syncing folders.
              </p>
            </div>
          </>
        )}
      </div>

      {onReplace && (
        <Modal
          isOpen={replaceConfirmOpen}
          onClose={() => setReplaceConfirmOpen(false)}
          title="Replace account?"
          subtitle="The existing account and its local data will be removed."
          disableBackdropClose
          footer={
            <>
              <SetupButton variant="ghost" onPress={() => setReplaceConfirmOpen(false)}>
                Cancel
              </SetupButton>
              <SetupButton
                onPress={() => {
                  setReplaceConfirmOpen(false);
                  onReplace();
                }}
              >
                Replace account
              </SetupButton>
            </>
          }
        >
          <p className="text-sm text-muted-text">
            Replacing will delete the existing account configuration, folders, and locally synced
            messages. This cannot be undone.
          </p>
        </Modal>
      )}
    </SetupCard>
  );
}

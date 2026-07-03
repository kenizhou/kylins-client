import { SetupCard, SetupButton, SetupBackButton } from './setup-ui';

export interface VerifyStepProps {
  error?: string | null;
  onRetry?: () => void;
  onBack?: () => void;
  onReplace?: () => void;
}

export function VerifyStep({ error, onRetry, onBack, onReplace }: VerifyStepProps) {
  const isDuplicateError = error?.toLowerCase().includes('already exists') ?? false;

  return (
    <SetupCard>
      <div className="flex flex-col items-center gap-5 py-6 text-center">
        {error ? (
          <>
            <div className="success-pop grid h-14 w-14 place-items-center rounded-full bg-red-500/10">
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                className="text-[var(--destructive)]"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </div>
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-semibold text-[var(--destructive)]">Couldn’t connect</h1>
              <p className="max-w-xs text-sm text-[var(--muted-text)]">{error}</p>
            </div>
            <div className="mt-2 flex items-center gap-3">
              {onBack && <SetupBackButton onPress={onBack} />}
              {isDuplicateError && onReplace && (
                <SetupButton onPress={onReplace}>Replace existing account</SetupButton>
              )}
              {onRetry && <SetupButton onPress={onRetry}>Retry</SetupButton>}
            </div>
          </>
        ) : (
          <>
            <span className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
            <div className="flex flex-col gap-1">
              <h1 className="text-xl font-semibold text-[var(--foreground)]">Connecting…</h1>
              <p className="text-sm text-[var(--muted-text)]">
                Verifying your credentials and syncing folders.
              </p>
            </div>
          </>
        )}
      </div>
    </SetupCard>
  );
}

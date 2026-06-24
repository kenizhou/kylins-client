export interface VerifyStepProps {
  error?: string | null;
  onRetry?: () => void;
  onBack?: () => void;
}

export function VerifyStep({ error, onRetry, onBack }: VerifyStepProps) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
      {error ? (
        <>
          <h1 className="text-xl font-semibold text-[var(--destructive)]">Couldn’t connect</h1>
          <p className="text-sm text-[var(--muted-text)]">{error}</p>
          <div className="flex gap-3">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="rounded border border-[var(--border)] px-4 py-2 text-sm"
              >
                Back
              </button>
            )}
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="rounded bg-[var(--primary)] px-4 py-2 text-sm text-[var(--primary-foreground)]"
              >
                Retry
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
          <p className="text-sm text-[var(--muted-text)]">Connecting…</p>
        </>
      )}
    </div>
  );
}

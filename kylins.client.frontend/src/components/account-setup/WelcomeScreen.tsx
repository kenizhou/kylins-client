export interface WelcomeScreenProps {
  onDone: () => void;
}

export function WelcomeScreen({ onDone }: WelcomeScreenProps) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
      <h1 className="text-2xl font-semibold text-[var(--foreground)]">Welcome to Kylins Mail</h1>
      <p className="text-sm text-[var(--muted-text)]">
        Your account is connected. Let’s open your inbox.
      </p>
      <button
        type="button"
        onClick={onDone}
        className="rounded bg-[var(--primary)] px-5 py-2 text-sm font-medium text-[var(--primary-foreground)]"
      >
        Looks good!
      </button>
    </div>
  );
}

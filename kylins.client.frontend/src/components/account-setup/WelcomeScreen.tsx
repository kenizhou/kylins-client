import { SetupCard, SetupButton } from './setup-ui';

export interface WelcomeScreenProps {
  onDone: () => void;
}

export function WelcomeScreen({ onDone }: WelcomeScreenProps) {
  return (
    <SetupCard>
      <div className="flex flex-col items-center gap-6 py-4 text-center">
        <div className="success-pop grid h-16 w-16 place-items-center rounded-full bg-[var(--accent)]">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[var(--primary)]"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Account connected</h1>
          <p className="text-sm text-[var(--muted-text)]">You’re all set. Welcome to your inbox.</p>
        </div>

        <SetupButton onClick={onDone}>Open inbox</SetupButton>
      </div>
    </SetupCard>
  );
}

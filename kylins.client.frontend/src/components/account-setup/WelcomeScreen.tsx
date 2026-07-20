import { CheckIcon } from '../icons';
import { SetupCard, SetupButton } from './setup-ui';

export interface WelcomeScreenProps {
  onDone: () => void;
}

export function WelcomeScreen({ onDone }: WelcomeScreenProps) {
  return (
    <SetupCard>
      <div className="flex flex-col items-center gap-6 py-4 text-center">
        <div className="success-pop grid h-16 w-16 place-items-center rounded-full bg-accent">
          <CheckIcon size={32} className="text-primary" aria-hidden="true" />
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="type-display text-balance text-foreground">Account connected</h1>
          <p className="text-balance text-sm text-muted-text">
            You’re all set. Welcome to your inbox.
          </p>
        </div>

        <SetupButton onPress={onDone}>Open inbox</SetupButton>
      </div>
    </SetupCard>
  );
}

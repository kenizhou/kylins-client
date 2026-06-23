import { PROVIDERS, type SetupProviderId } from '../../services/auth/providers';

const TILE_ORDER: SetupProviderId[] = [
  'gmail',
  'outlook',
  'microsoft365',
  'yahoo',
  'imap',
  'exchange',
];

export interface ProviderPickerProps {
  onPick: (id: SetupProviderId) => void;
}

function ProviderButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <span className="grid h-8 w-8 place-items-center rounded-md bg-[var(--muted)] text-xs font-bold">
        {name.charAt(0)}
      </span>
      {name}
    </button>
  );
}

export function ProviderPicker({ onPick }: ProviderPickerProps) {
  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <h1 className="text-center text-2xl font-semibold text-[var(--foreground)]">
        Add an account
      </h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {TILE_ORDER.map((id) => (
          <ProviderButton key={id} name={PROVIDERS[id].name} onClick={() => onPick(id)} />
        ))}
      </div>
    </div>
  );
}

import { PROVIDERS, type SetupProviderId } from '../../services/auth/providers';
import { SetupCard, SetupHeader, ProviderTile } from './setup-ui';

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

export function ProviderPicker({ onPick }: ProviderPickerProps) {
  return (
    <SetupCard width="lg">
      <SetupHeader
        title="Welcome to Kylins Mail"
        subtitle="Choose your email provider to get started. You can add more accounts later."
        hideMark
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TILE_ORDER.map((id, index) => (
          <ProviderTile
            key={id}
            id={id}
            name={PROVIDERS[id].name}
            onClick={() => onPick(id)}
            style={{ animationDelay: `${index * 40}ms` }}
          />
        ))}
      </div>

      <p className="mt-6 text-center type-caption text-muted-text">
        Don’t see your provider? Use Other (IMAP/SMTP) or Exchange.
      </p>
    </SetupCard>
  );
}

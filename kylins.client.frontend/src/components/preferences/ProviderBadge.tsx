import type { MailProvider } from '../../types';
import type { SetupProviderId } from '../../services/auth/providers';
import { ProviderGlyph, PROVIDER_ACCENTS } from '../account-setup/setup-ui';

const PROVIDER_LABELS: Record<SetupProviderId, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  microsoft365: 'Microsoft 365',
  yahoo: 'Yahoo',
  imap: 'IMAP',
  exchange: 'Exchange',
};

function resolveSetupProviderId(
  provider: MailProvider,
  setupProviderId?: string,
): SetupProviderId {
  if (setupProviderId && setupProviderId in PROVIDER_LABELS) {
    return setupProviderId as SetupProviderId;
  }
  if (provider === 'gmail_api') return 'gmail';
  if (provider === 'eas') return 'exchange';
  return 'imap';
}

interface ProviderBadgeProps {
  provider: MailProvider;
  setupProviderId?: string;
  size?: 'sm' | 'md';
}

export function ProviderBadge({ provider, setupProviderId, size = 'sm' }: ProviderBadgeProps) {
  const id = resolveSetupProviderId(provider, setupProviderId);
  const label = PROVIDER_LABELS[id];
  const accent = PROVIDER_ACCENTS[id];
  const badgeClass =
    size === 'md'
      ? 'h-9 w-9 rounded-lg'
      : 'h-7 w-7 rounded-md';

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`inline-flex items-center justify-center ${badgeClass} text-white`}
        style={{ backgroundColor: accent }}
        title={label}
      >
        <ProviderGlyph id={id} className="h-4 w-4" />
      </span>
      <span className="text-xs font-medium text-[var(--foreground)]">{label}</span>
    </span>
  );
}

import type { Contact } from '@/services/db/contacts';
import { LockIcon } from '@/components/icons';

const SOURCE_LABELS: Record<string, string> = {
  mail: 'Mail',
  local: 'Local',
  carddav: 'CardDAV',
  google_people: 'Google',
  eas_gal: 'EAS',
};

const SOURCE_STYLES: Record<string, string> = {
  mail: 'bg-[color-mix(in_srgb,var(--muted-text)_10%,transparent)] text-[var(--muted-text)] border-[color-mix(in_srgb,var(--muted-text)_25%,transparent)]',
  local:
    'bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] text-[var(--primary)] border-[color-mix(in_srgb,var(--primary)_25%,transparent)]',
  carddav:
    'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)] border-[color-mix(in_srgb,var(--success)_25%,transparent)]',
  google_people:
    'bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] text-[var(--primary)] border-[color-mix(in_srgb,var(--primary)_25%,transparent)]',
  eas_gal:
    'bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_25%,transparent)]',
};

interface SourceBadgeProps {
  contact: Contact;
}

export function SourceBadge({ contact }: SourceBadgeProps) {
  const label = SOURCE_LABELS[contact.source] ?? contact.source;
  const style = SOURCE_STYLES[contact.source] ?? SOURCE_STYLES.local;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${style}`}
      title={contact.isReadonly ? `${label} (read-only)` : label}
    >
      {contact.isReadonly && <LockIcon size={10} />}
      {label}
    </span>
  );
}

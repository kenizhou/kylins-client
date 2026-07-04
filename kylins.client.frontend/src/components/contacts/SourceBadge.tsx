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
  mail: 'bg-[var(--secondary)] text-[var(--secondary-foreground)]',
  local: 'bg-[var(--primary)]/10 text-[var(--primary)]',
  carddav: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  google_people: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  eas_gal: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

interface SourceBadgeProps {
  contact: Contact;
}

export function SourceBadge({ contact }: SourceBadgeProps) {
  const label = SOURCE_LABELS[contact.source] ?? contact.source;
  const style = SOURCE_STYLES[contact.source] ?? SOURCE_STYLES.local;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${style}`}
      title={contact.isReadonly ? `${label} (read-only)` : label}
    >
      {contact.isReadonly && <LockIcon size={10} />}
      {label}
    </span>
  );
}

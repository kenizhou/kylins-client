import type { Contact } from '../../services/db/contacts';

interface ContactAvatarProps {
  contact?: Contact | null;
  name?: string | null;
  email?: string;
  size?: number;
  className?: string;
}

export function ContactAvatar({
  contact,
  name,
  email,
  size = 36,
  className = '',
}: ContactAvatarProps) {
  const displayName = contact?.displayName ?? name ?? contact?.email ?? email ?? '?';
  const initial = (displayName.trim()[0] ?? '?').toUpperCase();
  const avatarUrl = contact?.avatarUrl;

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full overflow-hidden shrink-0 bg-[var(--primary)] text-[var(--primary-fg)] ${className}`}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.42) }}
      title={displayName}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={displayName} className="w-full h-full object-cover" />
      ) : (
        initial
      )}
    </span>
  );
}

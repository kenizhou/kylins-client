import { ClassificationIcon } from '@/components/icons';
import { useSecurityIndicatorIcons } from '../useSecurityIndicatorIcons';

export interface SecurityChipsProps {
  isEncrypted?: boolean;
  isSigned?: boolean;
  /** 'icon' = icon-only (list rows); 'label' = icon + text (viewer/ribbon status). */
  variant?: 'icon' | 'label';
  size?: number;
}

/**
 * Encrypted / Signed indicators, sharing one icon source
 * (`useSecurityIndicatorIcons`) so the glyphs stay consistent across the message
 * list, reading pane, and ribbon status group. Renders nothing when neither flag
 * is set.
 */
export function SecurityChips({
  isEncrypted,
  isSigned,
  variant = 'icon',
  size = 12,
}: SecurityChipsProps) {
  const { encryptedIcon, signedIcon } = useSecurityIndicatorIcons();
  if (!isEncrypted && !isSigned) return null;

  if (variant === 'label') {
    return (
      <span className="inline-flex items-center gap-2 text-[var(--muted-text)]">
        {isEncrypted && (
          <span className="inline-flex items-center gap-0.5 text-[11px]">
            <ClassificationIcon icon={encryptedIcon} size={size} />
            Encrypted
          </span>
        )}
        {isSigned && (
          <span className="inline-flex items-center gap-0.5 text-[11px]">
            <ClassificationIcon icon={signedIcon} size={size} />
            Signed
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-0.5 text-[var(--muted-text)]">
      {isEncrypted && (
        <span title="Encrypted" aria-label="Encrypted">
          <ClassificationIcon icon={encryptedIcon} size={size} />
        </span>
      )}
      {isSigned && (
        <span title="Signed" aria-label="Signed">
          <ClassificationIcon icon={signedIcon} size={size} />
        </span>
      )}
    </span>
  );
}

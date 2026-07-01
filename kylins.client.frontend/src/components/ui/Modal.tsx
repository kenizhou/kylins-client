import { useEffect } from 'react';
import { CloseIcon } from '../icons';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  icon?: React.ComponentType<{ size?: number }>;
  footer?: React.ReactNode;
  size?: 'md' | 'lg' | 'xl' | 'full';
  className?: string;
  contentClassName?: string;
  disableBackdropClose?: boolean;
}

const SIZE_CLASSES: Record<NonNullable<ModalProps['size']>, string> = {
  md: 'w-[680px] h-[640px]',
  lg: 'w-full max-w-[920px] h-[680px] max-h-[90vh]',
  xl: 'w-full max-w-[1100px] h-[760px] max-h-[92vh]',
  full: 'w-[92vw] h-[92vh]',
};

export function Modal({
  isOpen,
  onClose,
  children,
  title,
  subtitle,
  icon: Icon,
  footer,
  size = 'md',
  className = '',
  contentClassName = '',
  disableBackdropClose = false,
}: ModalProps) {
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !disableBackdropClose) {
        onClose();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const hasHeader = Boolean(title || subtitle || Icon);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (!disableBackdropClose && e.target === e.currentTarget) {
          onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title || 'Dialog'}
    >
      <div
        className={`relative flex flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl ${SIZE_CLASSES[size]} ${className}`}
      >
        {hasHeader && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] shrink-0">
            <div className="flex items-center gap-3">
              {Icon && (
                <span className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-[var(--primary)] text-[var(--primary-fg)]">
                  <Icon size={20} />
                </span>
              )}
              <div>
                {title && (
                  <h2 className="text-lg font-semibold text-[var(--foreground)]">{title}</h2>
                )}
                {subtitle && <p className="text-xs text-[var(--muted-text)]">{subtitle}</p>}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--foreground)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              aria-label="Close"
            >
              <CloseIcon size={16} />
            </button>
          </div>
        )}

        {!hasHeader && (
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--foreground)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            aria-label="Close"
          >
            <CloseIcon size={16} />
          </button>
        )}

        <div className={`flex-1 overflow-auto kylins-scrollbar ${contentClassName}`}>
          {children}
        </div>

        {footer && (
          <div className="flex items-center justify-between px-6 py-3 border-t border-[var(--border)] bg-[color-mix(in_oklab,var(--surface),black_4%)] shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

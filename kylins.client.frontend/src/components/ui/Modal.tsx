import { CloseIcon } from '../icons';
import { Dialog, Modal as RACModal, ModalOverlay } from 'react-aria-components';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  icon?: React.ComponentType<{ size?: number }>;
  footer?: React.ReactNode;
  size?: 'md' | 'lg' | 'xl' | 'full' | 'auto';
  className?: string;
  contentClassName?: string;
  disableBackdropClose?: boolean;
  closeAriaLabel?: string;
}

const SIZE_CLASSES: Record<NonNullable<ModalProps['size']>, string> = {
  // `md` caps width/height to the viewport so the dialog never overflows on a
  // small screen (the overlay centers + pads but does not scroll, so a fixed
  // 680x640 box would clip both edges — incl. the close/save buttons — below
  // that size). `w-full max-w-[680px]` shrinks to fit; `max-h-[88vh]` keeps it
  // within the viewport and lets the inner `overflow-auto` scroll the rest.
  md: 'w-full max-w-[680px] h-[640px] max-h-[88vh]',
  lg: 'w-full max-w-[920px] h-[680px] max-h-[90vh]',
  xl: 'w-full max-w-[1100px] h-[760px] max-h-[92vh]',
  full: 'w-[92vw] h-[92vh]',
  auto: 'w-auto h-auto max-w-[min(90vw,1200px)] max-h-[90vh]',
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
  closeAriaLabel = 'Close',
}: ModalProps) {
  const hasHeader = Boolean(title || subtitle || Icon);

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable={!disableBackdropClose}
      isKeyboardDismissDisabled={disableBackdropClose}
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-[var(--backdrop)] p-4"
    >
      <RACModal
        className={`relative flex flex-col overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-surface shadow-[var(--shadow-xl)] ${SIZE_CLASSES[size]} ${className}`}
      >
        <Dialog aria-label={title || 'Dialog'} className="flex h-full flex-col outline-none">
          {({ close }) => (
            <>
              {hasHeader && (
                <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--chrome-tint)] px-6 py-3.5">
                  <div className="flex items-center gap-3">
                    {Icon && (
                      <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl iris-line text-primary-fg shadow-[var(--shadow-sm)]">
                        <Icon size={20} />
                      </span>
                    )}
                    <div>
                      {title && <h2 className="type-subject text-foreground">{title}</h2>}
                      {subtitle && <p className="type-caption text-muted-text">{subtitle}</p>}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={close}
                    className="flex h-11 w-11 items-center justify-center rounded-md text-muted-text transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={closeAriaLabel}
                  >
                    <CloseIcon size={16} />
                  </button>
                </div>
              )}

              {!hasHeader && (
                <button
                  type="button"
                  onClick={close}
                  className="absolute right-3 top-3 z-10 flex h-11 w-11 items-center justify-center rounded-md text-muted-text transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={closeAriaLabel}
                >
                  <CloseIcon size={16} />
                </button>
              )}

              <div className={`flex-1 overflow-auto kylins-scrollbar ${contentClassName}`}>
                {children}
              </div>

              {footer && (
                <div className="flex shrink-0 items-center justify-between border-t border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-6 py-3">
                  {footer}
                </div>
              )}
            </>
          )}
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
}

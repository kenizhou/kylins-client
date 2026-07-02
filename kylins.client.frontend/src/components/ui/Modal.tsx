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
  const hasHeader = Boolean(title || subtitle || Icon);

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable={!disableBackdropClose}
      isKeyboardDismissDisabled={disableBackdropClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <RACModal
        className={`relative flex flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl ${SIZE_CLASSES[size]} ${className}`}
      >
        <Dialog aria-label={title || 'Dialog'} className="flex h-full flex-col outline-none">
          {({ close }) => (
            <>
              {hasHeader && (
                <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
                  <div className="flex items-center gap-3">
                    {Icon && (
                      <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-fg">
                        <Icon size={20} />
                      </span>
                    )}
                    <div>
                      {title && <h2 className="text-lg font-semibold text-foreground">{title}</h2>}
                      {subtitle && <p className="text-xs text-muted-text">{subtitle}</p>}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={close}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-text transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Close"
                  >
                    <CloseIcon size={16} />
                  </button>
                </div>
              )}

              {!hasHeader && (
                <button
                  type="button"
                  onClick={close}
                  className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-md text-muted-text transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Close"
                >
                  <CloseIcon size={16} />
                </button>
              )}

              <div className={`flex-1 overflow-auto kylins-scrollbar ${contentClassName}`}>
                {children}
              </div>

              {footer && (
                <div className="flex shrink-0 items-center justify-between border-t border-border bg-[color-mix(in_oklab,var(--surface),black_4%)] px-6 py-3">
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

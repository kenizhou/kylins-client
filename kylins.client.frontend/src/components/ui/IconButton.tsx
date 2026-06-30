import { forwardRef, type ReactNode } from 'react';

export interface IconButtonProps {
  icon: ReactNode;
  label?: string;
  title?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  active?: boolean;
  className?: string;
  onClick?: () => void;
}

/**
 * Consistent icon-only or icon+label button with accessible touch targets.
 *
 * - `sm` = 32×32 (minimum comfortable desktop hit area)
 * - `md` = 36×36 (ribbon/toolbar buttons)
 *
 * Always renders a visible focus ring and clearly disabled state.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, title, size = 'sm', disabled = false, active = false, className, onClick },
  ref,
) {
  const sizeClass = size === 'md' ? 'h-9 px-2 gap-1.5' : 'h-8 w-8';
  const labelClass = label ? 'px-2 w-auto' : '';

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={title ?? label}
      className={`inline-flex items-center justify-center rounded text-[var(--muted-foreground)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'bg-[var(--selected)] text-[var(--selected-text)]'
          : 'hover:bg-[var(--hover)] hover:text-[var(--foreground)]'
      } ${sizeClass} ${labelClass} ${className ?? ''}`}
    >
      {icon}
      {label && <span className="whitespace-nowrap text-sm text-[var(--foreground)]">{label}</span>}
    </button>
  );
});

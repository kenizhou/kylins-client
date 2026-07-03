import { Button } from 'react-aria-components';
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
 * Consistent icon-only or icon+label button with accessible 44×44 touch targets.
 *
 * - `sm` = 44×44 icon-only button
 * - `md` = 44 px tall button with icon + label
 *
 * Always renders a visible focus ring and clearly disabled state.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, title, size = 'sm', disabled = false, active = false, className, onClick },
  ref,
) {
  const sizeClass = size === 'md' ? 'h-11 px-2 gap-1.5 min-w-11' : 'h-11 w-11';
  const labelClass = label ? 'px-2 w-auto' : '';

  return (
    <Button
      ref={ref}
      isDisabled={disabled}
      onPress={onClick}
      aria-label={title ?? label}
      data-active={active || undefined}
      className={`relative inline-flex items-center justify-center rounded text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? 'bg-selected text-selected-text' : 'hover:bg-hover hover:text-foreground'
      } ${sizeClass} ${labelClass} ${className ?? ''}`}
    >
      {icon}
      {label && <span className="whitespace-nowrap text-sm text-foreground">{label}</span>}
    </Button>
  );
});

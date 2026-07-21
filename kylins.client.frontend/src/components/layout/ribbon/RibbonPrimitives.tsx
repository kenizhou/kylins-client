import { CaretDownIcon } from '../../icons';
import { forwardRef, type ReactNode } from 'react';
import { Button } from 'react-aria-components';

export interface RibbonGroupProps {
  children: ReactNode;
}

export function RibbonGroup({ children }: RibbonGroupProps) {
  return (
    <div className="flex min-w-0 flex-wrap items-stretch border-r-[var(--border-subtle)] px-1 last:border-r-0">
      {children}
    </div>
  );
}

export interface RibbonButtonProps {
  children?: ReactNode;
  icon?: ReactNode;
  primary?: boolean;
  split?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  iconOnly?: boolean;
  onClick?: () => void;
}

export const RibbonButton = forwardRef<HTMLButtonElement, RibbonButtonProps>(function RibbonButton(
  { children, icon, primary, split, disabled, title, className, iconOnly, onClick },
  ref,
) {
  return (
    <Button
      ref={ref}
      isDisabled={disabled}
      onPress={onClick}
      aria-label={title ?? (typeof children === 'string' ? children : undefined)}
      className={`my-auto flex h-11 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 ${
        primary
          ? 'bg-primary text-primary-fg shadow-[var(--shadow-sm)] hover:opacity-90 disabled:hover:opacity-40'
          : 'text-[var(--text)] hover:bg-[var(--primary-subtle)] active:bg-[var(--primary-muted)] disabled:hover:bg-transparent'
      } ${iconOnly ? 'w-11 justify-center px-0' : ''} ${className ?? ''}`}
    >
      {icon}
      <span className={`whitespace-nowrap ${iconOnly ? 'sr-only' : ''}`}>{children}</span>
      {split && !iconOnly && <CaretDownIcon size={10} className="ml-0.5 opacity-70" />}
    </Button>
  );
});

export interface RibbonToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  icon?: ReactNode;
  label: string;
  title?: string;
  disabled?: boolean;
}

export function RibbonToggle({
  checked,
  onChange,
  icon,
  label,
  title,
  disabled,
}: RibbonToggleProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={title ?? label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex h-11 items-center gap-1.5 rounded-md px-2 text-xs ${
        disabled
          ? 'cursor-not-allowed opacity-60'
          : 'cursor-pointer hover:bg-[var(--primary-subtle)]'
      }`}
    >
      {icon}
      <span className="flex-1 whitespace-nowrap text-foreground">{label}</span>
      <div
        className={`ml-auto flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${
          checked
            ? 'border-primary bg-primary text-primary-fg'
            : 'border-[var(--border-subtle)] bg-[var(--surface-floating)]'
        }`}
      >
        {checked && (
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path
              d="M1.5 5.5L4 8l4-5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
    </button>
  );
}

export interface RibbonStatusItemProps {
  icon?: ReactNode;
  label: string;
  color?: string;
}

export function RibbonStatusItem({ icon, label, color }: RibbonStatusItemProps) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{
        borderColor: color ? `${color}80` : 'var(--border)',
        color: color ?? 'var(--muted-text)',
        backgroundColor: color ? `${color}15` : undefined,
      }}
    >
      {icon}
      {label}
    </span>
  );
}

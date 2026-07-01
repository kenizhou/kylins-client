import { CaretDown } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

export interface RibbonGroupProps {
  children: ReactNode;
}

export function RibbonGroup({ children }: RibbonGroupProps) {
  return (
    <div className="flex items-stretch px-1 border-r border-[var(--border)] last:border-r-0">
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
  onClick?: () => void;
}

export function RibbonButton({
  children,
  icon,
  primary,
  split,
  disabled,
  title,
  className,
  onClick,
}: RibbonButtonProps) {
  return (
    <button
      className={`flex items-center gap-1.5 px-2.5 h-8 my-auto text-sm rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40 ${
        primary
          ? 'bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 disabled:hover:opacity-40'
          : 'text-[var(--text)] hover:bg-[var(--hover)] disabled:hover:bg-transparent'
      } ${className ?? ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      type="button"
    >
      {icon}
      <span className="whitespace-nowrap">{children}</span>
      {split && <CaretDown size={10} className="ml-0.5 opacity-70" />}
    </button>
  );
}

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
    <label
      title={title}
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-[var(--hover)]'
      }`}
    >
      {icon}
      <span className="whitespace-nowrap text-[var(--foreground)]">{label}</span>
      <input
        type="checkbox"
        className="ml-auto h-3.5 w-3.5 accent-[var(--primary)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
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

import type { ComponentType, ReactNode } from 'react';

interface PreferencesSectionCardProps {
  title: string;
  icon?: ComponentType<{ size?: number }>;
  children: ReactNode;
  className?: string;
}

export function PreferencesSectionCard({
  title,
  icon: Icon,
  children,
  className = '',
}: PreferencesSectionCardProps) {
  return (
    <div
      className={`rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)] ${className}`}
    >
      <div className="flex items-center gap-2.5 mb-4">
        {Icon && (
          <span className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-[var(--highlight)] text-[var(--highlight-text)]">
            <Icon size={16} />
          </span>
        )}
        <h3 className="type-pane-title text-[var(--foreground)]">{title}</h3>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

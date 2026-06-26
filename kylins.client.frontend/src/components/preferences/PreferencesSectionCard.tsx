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
      className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm ${className}`}
    >
      <div className="flex items-center gap-2.5 mb-4">
        {Icon && (
          <span className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-[var(--highlight)] text-[var(--highlight-text)]">
            <Icon size={16} />
          </span>
        )}
        <h3 className="text-sm font-semibold text-[var(--foreground)]">{title}</h3>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

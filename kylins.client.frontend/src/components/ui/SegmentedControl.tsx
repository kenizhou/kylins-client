import type { ReactNode } from 'react';

interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: SegmentedControlProps<T>): ReactNode {
  return (
    <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--background)] p-1">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              active
                ? 'bg-[var(--primary)] text-[var(--primary-fg)]'
                : 'text-[var(--muted-text)] hover:text-[var(--foreground)] hover:bg-[var(--hover)]'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

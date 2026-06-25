import type { ReactNode } from 'react';

export function CheckboxRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer group rounded-md hover:bg-[color-mix(in_oklab,var(--surface),black_4%)] px-2 -mx-2 transition-colors">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--ring)]"
      />
      <span className="text-sm text-[var(--foreground)]">{label}</span>
    </label>
  );
}

export function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 py-2">
      <span className="text-sm text-[var(--foreground)]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none sm:w-auto w-full"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ButtonRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-2">
      <div className="space-y-0.5">
        <span className="text-sm text-[var(--foreground)]">{label}</span>
        {description && (
          <p className="text-xs text-[var(--muted-text)]">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

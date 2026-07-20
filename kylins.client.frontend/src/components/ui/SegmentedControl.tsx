import type { ReactNode } from 'react';
import { useId } from 'react';
import { ToggleButton, ToggleButtonGroup } from 'react-aria-components';

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
  const baseId = useId();

  return (
    <ToggleButtonGroup
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const next = Array.from(keys)[0];
        if (next) onChange(String(next).slice(baseId.length + 1) as T);
      }}
      className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-1 shadow-[var(--shadow-sm)]"
    >
      {options.map((opt) => (
        <ToggleButton
          key={opt.value}
          id={`${baseId}-${opt.value}`}
          className="min-h-11 px-3 py-1.5 text-xs font-medium rounded-md transition-colors text-muted-text hover:bg-hover hover:text-foreground selected:bg-primary selected:text-primary-fg selected:shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {opt.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

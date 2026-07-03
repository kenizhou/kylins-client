import type { ReactNode } from 'react';
import {
  Checkbox,
  Select,
  Label,
  Button,
  Popover,
  ListBox,
  ListBoxItem,
  SelectValue,
} from 'react-aria-components';

export function CheckboxRow({
  label,
  checked,
  onChange,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  /**
   * Optional help text rendered under the label. Used by controls whose
   * effect isn't obvious from the label alone (e.g. Do Not Disturb).
   */
  description?: string;
}) {
  return (
    <Checkbox
      isSelected={checked}
      onChange={onChange}
      className="group flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 -mx-2 transition-colors hover:bg-[color-mix(in_oklab,var(--surface),black_4%)]"
    >
      {({ isSelected }) => (
        <>
          <div
            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
              isSelected
                ? 'border-primary bg-primary text-primary-fg'
                : 'border-border bg-background'
            }`}
          >
            {isSelected && (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
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
          <span className="space-y-0.5">
            <span className="block text-sm text-foreground">{label}</span>
            {description && <span className="block text-xs text-muted-text">{description}</span>}
          </span>
        </>
      )}
    </Checkbox>
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
    <Select
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:gap-3"
    >
      <Label className="text-sm text-foreground">{label}</Label>
      <Button className="flex h-9 w-full items-center justify-between rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-ring sm:w-auto">
        <SelectValue />
        <span aria-hidden="true" className="text-muted-text">
          ▾
        </span>
      </Button>
      <Popover className="min-w-[--trigger-width] rounded-lg border border-border bg-background shadow-lg">
        <ListBox className="py-1 outline-none">
          {options.map((opt) => (
            <ListBoxItem
              key={opt.value}
              id={opt.value}
              className="cursor-pointer px-3 py-2 text-sm text-foreground hover:bg-hover selected:bg-selected selected:text-selected-text focus-visible:outline-none"
            >
              {opt.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
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
    <div className="flex flex-col justify-between gap-3 py-2 sm:flex-row sm:items-center">
      <div className="space-y-0.5">
        <span className="text-sm text-foreground">{label}</span>
        {description && <p className="text-xs text-muted-text">{description}</p>}
      </div>
      {children}
    </div>
  );
}

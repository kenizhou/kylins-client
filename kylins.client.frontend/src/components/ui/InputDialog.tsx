// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Minimal modal dialog for one-or-more text inputs (used by the composer's
// "Insert Link" toolbar action). Styled with Kylins' CSS-var tokens.

import { useEffect, useRef, useState } from 'react';

export interface InputField {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
}

interface InputDialogProps {
  isOpen: boolean;
  title: string;
  fields: InputField[];
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => void;
}

export function InputDialog({
  isOpen,
  title,
  fields,
  submitLabel = 'OK',
  onClose,
  onSubmit,
}: InputDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

  // Initialize values only on the closed→open transition (not on every re-render
  // while open), so typing isn't reset.
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      const init: Record<string, string> = {};
      for (const f of fields) init[f.key] = f.defaultValue ?? '';
      setValues(init);
      const t = setTimeout(() => firstFieldRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    wasOpenRef.current = isOpen;
    return undefined;
  }, [isOpen, fields]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(values);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-80 rounded-md border border-[var(--border)] bg-[var(--background)] p-4 shadow-xl"
      >
        <h3 className="mb-3 text-sm font-medium text-[var(--foreground)]">{title}</h3>
        <div className="space-y-3">
          {fields.map((f, i) => (
            <label key={f.key} className="block">
              <span className="mb-1 block text-xs text-[var(--muted-text)]">{f.label}</span>
              <input
                ref={i === 0 ? firstFieldRef : undefined}
                type="text"
                value={values[f.key] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className="h-7 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
              />
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-7 rounded px-3 text-sm text-[var(--foreground)] hover:bg-[var(--hover)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="h-7 rounded bg-[var(--primary)] px-3 text-sm text-[var(--primary-fg)] hover:opacity-90"
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

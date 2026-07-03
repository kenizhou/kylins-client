// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Minimal modal dialog for one-or-more text inputs (used by the composer's
// "Insert Link" toolbar action). Styled with Kylins' CSS-var tokens.

import { useEffect, useRef, useState } from 'react';
import { CloseIcon } from '../icons';
import {
  Button,
  Dialog,
  Input,
  Label,
  Modal as RACModal,
  ModalOverlay,
  TextField,
} from 'react-aria-components';

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
  const wasOpenRef = useRef(false);

  // Initialize values only on the closed→open transition (not on every re-render
  // while open), so typing isn't reset.
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      const init: Record<string, string> = {};
      for (const f of fields) init[f.key] = f.defaultValue ?? '';
      setValues(init);
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, fields]);

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-black/30 p-4"
    >
      <RACModal className="relative w-80 rounded-lg border border-border bg-background p-4 shadow-xl outline-none">
        <Dialog aria-label={title} className="outline-none">
          {({ close }) => (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onSubmit(values);
                close();
              }}
              className="relative"
            >
              <Button
                slot="close"
                className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                aria-label="Close"
              >
                <CloseIcon size={14} />
              </Button>

              <h3 className="mb-3 pr-6 text-sm font-medium text-foreground">{title}</h3>

              <div className="space-y-3">
                {fields.map((f, i) => (
                  <TextField key={f.key} name={f.key} className="block">
                    <Label className="mb-1 block text-xs text-muted-text">{f.label}</Label>
                    <Input
                      autoFocus={i === 0}
                      type="text"
                      value={values[f.key] ?? ''}
                      placeholder={f.placeholder}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      className="h-8 w-full rounded border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
                    />
                  </TextField>
                ))}
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <Button
                  slot="close"
                  className="h-8 rounded px-3 text-sm text-foreground transition-colors hover:bg-hover"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="h-8 rounded bg-primary px-3 text-sm text-primary-fg transition-opacity hover:opacity-90"
                >
                  {submitLabel}
                </Button>
              </div>
            </form>
          )}
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
}

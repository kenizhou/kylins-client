// Passphrase prompt modal for the S/MIME identity import flow
// (`.p12`/`.pfx` + encrypted-PKCS#8 PEM). Mirrors the existing `InputDialog`
// + `LinkConfirmDialog` patterns: react-aria-components `ModalOverlay` +
// `Dialog`, which auto-renders into a portal, traps focus, restores focus
// to the initiator on close, and wires ESC-to-dismiss + click-backdrop.
//
// Two ways to use it:
//   1. Controlled component: `<PassphrasePrompt isOpen onSubmit onCancel />`
//      (the parent owns the open state — matches `InputDialog`).
//   2. Imperative helper: `const pass = await openPassphrasePrompt();`
//      (renders into a portal + resolves with the entered string or null).
//
// Accessibility:
//   - `role="dialog"` (RAC `Dialog`) + `aria-modal` (RAC `ModalOverlay`).
//   - `aria-label="Passphrase"` on the input (the visible `<Label>` also
//     wires `htmlFor`/`id` for screen readers).
//   - Focus moves to the input on open; RAC restores focus to the
//     initiator (the Import button) on close.
//
// i18n: strings kept as named constants — when a translations layer lands,
// swap them for `t('...')` lookups.

import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Button,
  Dialog,
  Label,
  Modal as RACModal,
  ModalOverlay,
  TextField,
} from 'react-aria-components';

export const PASSPHRASE_PROMPT_STRINGS = {
  title: 'Enter passphrase',
  label: 'Passphrase',
  placeholder: 'Bundle passphrase',
  cancel: 'Cancel',
  ok: 'OK',
};

export interface PassphrasePromptProps {
  isOpen: boolean;
  title?: string;
  label?: string;
  placeholder?: string;
  /** Called with the entered passphrase when the user clicks OK / presses Enter. */
  onSubmit: (passphrase: string) => void;
  /** Called when the user cancels (ESC, backdrop click, or Cancel button). */
  onCancel: () => void;
}

/**
 * Controlled modal for entering a bundle passphrase. Render this wherever
 * the import flow lives and toggle `isOpen`. `onSubmit` fires only when the
 * input is non-empty (the OK button + Enter both gate on `value.trim()`).
 */
export function PassphrasePrompt({
  isOpen,
  title = PASSPHRASE_PROMPT_STRINGS.title,
  label = PASSPHRASE_PROMPT_STRINGS.label,
  placeholder = PASSPHRASE_PROMPT_STRINGS.placeholder,
  onSubmit,
  onCancel,
}: PassphrasePromptProps) {
  const [value, setValue] = useState('');
  const wasOpenRef = useRef(false);

  // Reset the input only on the closed→open transition (not on every
  // re-render while open), so typing isn't reset. Mirrors `InputDialog`'s
  // `wasOpenRef` pattern to avoid the `react-hooks/set-state-in-effect`
  // cascading-render lint.
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setValue('');
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  // Note: Enter submits via the `<form onSubmit>` below (the input + OK
  // button both live inside the form, so a real-browser Enter from the
  // input triggers form submission natively, and clicking OK — a
  // `type="submit"` button — submits explicitly). An earlier revision also
  // bound a global `window.addEventListener('keydown', …)` Enter handler,
  // but that misfired when focus was on the Cancel button: pressing Enter
  // to activate Cancel would also trip the global handler → `onSubmit`
  // ran with the in-progress value, importing when the user intended to
  // cancel. The form-scoped path does not have this hazard. ESC remains
  // wired via RAC's `ModalOverlay` (`onOpenChange(false)` → `onCancel`).

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      isDismissable
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-black/40 p-4"
    >
      <RACModal className="relative w-80 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 shadow-xl outline-none">
        <Dialog aria-label={title} className="outline-none">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) onSubmit(value);
            }}
            className="relative"
          >
            <h3 className="mb-3 pr-6 text-sm font-medium text-[var(--foreground)]">{title}</h3>

            <TextField name="passphrase" className="block">
              <Label className="mb-1 block text-xs text-[var(--muted-text)]">{label}</Label>
              <input
                autoFocus
                type="password"
                value={value}
                placeholder={placeholder}
                aria-label={label}
                onChange={(e) => setValue(e.target.value)}
                className="h-11 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
              />
            </TextField>

            <div className="mt-4 flex justify-end gap-2">
              <Button
                slot="close"
                className="h-11 rounded px-3 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--hover)]"
              >
                {PASSPHRASE_PROMPT_STRINGS.cancel}
              </Button>
              <Button
                type="submit"
                isDisabled={!value.trim()}
                className="h-11 rounded bg-[var(--primary)] px-3 text-sm text-[var(--primary-fg)] transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {PASSPHRASE_PROMPT_STRINGS.ok}
              </Button>
            </div>
          </form>
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
}

export interface PassphrasePromptOptions {
  title?: string;
  label?: string;
  placeholder?: string;
}

/**
 * Open the passphrase prompt modal and resolve with the entered passphrase
 * (`string`) on OK, or `null` when cancelled (ESC / backdrop / Cancel). The
 * modal mounts into a top-level portal, so it can be called from anywhere —
 * no host component required. Useful when the caller prefers a Promise
 * shape (`const pass = await openPassphrasePrompt(); if (pass === null) return;`).
 *
 * Scoping: the caller decides WHEN to prompt. For the S/MIME import flow
 * we prompt unconditionally for `.p12`/`.pfx` (always passphrase-protected)
 * and also for an encrypted-PKCS#8 PEM, detected by a content sniff in
 * `KeyManagerSection.onImport` (the file is read via `readTextFile` and
 * checked for the `ENCRYPTED PRIVATE KEY` label). Plain PEM skips the
 * prompt.
 */
export function openPassphrasePrompt(options?: PassphrasePromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const host = document.createElement('div');
    host.dataset.passphrasePromptHost = '';
    document.body.appendChild(host);

    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      root.unmount();
      host.remove();
      resolve(value);
    };

    const root = createRoot(host);
    root.render(
      <PassphrasePromptBodyImperative
        options={options}
        onSubmit={(pass) => finish(pass)}
        onCancel={() => finish(null)}
      />,
    );
  });
}

/** Internal: the always-open body used by the imperative `openPassphrasePrompt`. */
function PassphrasePromptBodyImperative({
  options,
  onSubmit,
  onCancel,
}: {
  options?: PassphrasePromptOptions;
  onSubmit: (passphrase: string) => void;
  onCancel: () => void;
}) {
  return (
    <PassphrasePrompt
      isOpen
      title={options?.title}
      label={options?.label}
      placeholder={options?.placeholder}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

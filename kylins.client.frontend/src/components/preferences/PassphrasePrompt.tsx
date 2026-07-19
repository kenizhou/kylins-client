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
  // Confirm-mode strings (export .p12 — "create a password that protects a
  // key" UX; the user must retype to guard against a typo that would lock
  // them out of their backup). Import keeps single-field — the passphrase
  // already exists somewhere, the user is unlocking not creating.
  confirmTitle: 'Choose a passphrase',
  confirmLabel: 'Confirm passphrase',
  confirmPlaceholder: 'Re-enter passphrase',
  confirmMismatch: 'Passphrases do not match',
};

export interface PassphrasePromptProps {
  isOpen: boolean;
  title?: string;
  label?: string;
  placeholder?: string;
  /**
   * When `true`, render a second "Confirm passphrase" input that must match
   * the first before submit is enabled. Used for the .p12 export flow
   * (creating a key-backup passphrase — the standard two-field "create a
   * password" UX guards against a typo). Import (single field) is the
   * default — the passphrase already exists, the user is unlocking not
   * creating.
   */
  confirm?: boolean;
  /** Override the confirm-field label (defaults to "Confirm passphrase"). */
  confirmLabel?: string;
  /** Override the confirm-field placeholder. */
  confirmPlaceholder?: string;
  /** Override the title used in confirm mode (defaults to "Choose a passphrase"). */
  confirmTitle?: string;
  /** Called with the entered passphrase when the user clicks OK / presses Enter. */
  onSubmit: (passphrase: string) => void;
  /** Called when the user cancels (ESC, backdrop click, or Cancel button). */
  onCancel: () => void;
}

/**
 * Controlled modal for entering a bundle passphrase. Render this wherever
 * the import flow lives and toggle `isOpen`. `onSubmit` fires only when the
 * input is non-empty (the OK button + Enter both gate on `value.trim()`) AND,
 * in `confirm` mode, the two inputs match.
 */
export function PassphrasePrompt({
  isOpen,
  title = PASSPHRASE_PROMPT_STRINGS.title,
  label = PASSPHRASE_PROMPT_STRINGS.label,
  placeholder = PASSPHRASE_PROMPT_STRINGS.placeholder,
  confirm = false,
  confirmLabel = PASSPHRASE_PROMPT_STRINGS.confirmLabel,
  confirmPlaceholder = PASSPHRASE_PROMPT_STRINGS.confirmPlaceholder,
  confirmTitle = PASSPHRASE_PROMPT_STRINGS.confirmTitle,
  onSubmit,
  onCancel,
}: PassphrasePromptProps) {
  const [value, setValue] = useState('');
  const [confirmValue, setConfirmValue] = useState('');
  const wasOpenRef = useRef(false);

  // Effective title swaps to the confirm-mode title when `confirm` is set
  // AND the caller did not override `title` explicitly. We detect "no
  // explicit override" by checking against the default export title; if the
  // caller passed a custom `title`, honor it in both modes.
  const effectiveTitle =
    confirm && title === PASSPHRASE_PROMPT_STRINGS.title ? confirmTitle : title;

  // Reset both inputs only on the closed→open transition (not on every
  // re-render while open), so typing isn't reset. Mirrors `InputDialog`'s
  // `wasOpenRef` pattern to avoid the `react-hooks/set-state-in-effect`
  // cascading-render lint.
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setValue('');
      setConfirmValue('');
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  // Mismatch flag: shown ONLY when the user has typed something into the
  // confirm field AND it does not match the primary. Cleared the moment they
  // match again (live feedback — the error disappears as soon as the user
  // fixes it). An empty confirm field does not show the error; the OK button
  // is disabled separately via `canSubmit`.
  const mismatch = confirm && confirmValue.length > 0 && confirmValue !== value;
  const canSubmit = value.trim().length > 0 && (!confirm || confirmValue === value);

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
        <Dialog aria-label={effectiveTitle} className="outline-none">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              // `canSubmit` already gates the OK button; this is the
              // equivalent gate for the Enter-key form-submit path so a
              // mismatched confirm never fires `onSubmit`.
              if (canSubmit) onSubmit(value);
            }}
            className="relative"
          >
            <h3 className="mb-3 pr-6 text-sm font-medium text-[var(--foreground)]">
              {effectiveTitle}
            </h3>

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

            {confirm && (
              <TextField name="passphrase-confirm" className="mt-3 block">
                <Label className="mb-1 block text-xs text-[var(--muted-text)]">
                  {confirmLabel}
                </Label>
                <input
                  type="password"
                  value={confirmValue}
                  placeholder={confirmPlaceholder}
                  aria-label={confirmLabel}
                  aria-invalid={mismatch}
                  aria-describedby={mismatch ? 'passphrase-confirm-mismatch' : undefined}
                  onChange={(e) => setConfirmValue(e.target.value)}
                  className="h-11 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                />
                {mismatch && (
                  <p
                    id="passphrase-confirm-mismatch"
                    role="alert"
                    className="mt-1 text-xs text-[var(--destructive)]"
                  >
                    {PASSPHRASE_PROMPT_STRINGS.confirmMismatch}
                  </p>
                )}
              </TextField>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button
                slot="close"
                className="h-11 rounded px-3 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--hover)]"
              >
                {PASSPHRASE_PROMPT_STRINGS.cancel}
              </Button>
              <Button
                type="submit"
                isDisabled={!canSubmit}
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
  /**
   * When `true`, render a second "Confirm passphrase" input that must match
   * the first. Used for the .p12 export flow (creating a key-backup
   * passphrase). Import (single field) is the default.
   */
  confirm?: boolean;
  confirmLabel?: string;
  confirmPlaceholder?: string;
  confirmTitle?: string;
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
      confirm={options?.confirm}
      confirmLabel={options?.confirmLabel}
      confirmPlaceholder={options?.confirmPlaceholder}
      confirmTitle={options?.confirmTitle}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

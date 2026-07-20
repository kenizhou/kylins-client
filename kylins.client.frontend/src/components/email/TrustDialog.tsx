// G6 Task 5: TrustDialog — RAC modal that lets the user accept or reject an
// unverified S/MIME signer.
//
// Shown by the ReadingPane when `selectedMessage.signatureState` is one of the
// "user-decidable" states (`valid-unverified` | `unknown-key` | `mismatch`).
// "Trust signer" writes a `verified` row to `trust_decisions`; "Don't trust"
// writes `rejected`. The parent re-opens the message after `onResolved` so the
// crypto pipeline re-evaluates the signature state against the fresh decision
// (see `mail/crypto.rs:resolve_signer_trust`).
//
// Structure mirrors `LinkConfirmDialog.tsx` (RAC `ModalOverlay`/`Modal`/
// `Dialog`, self-contained, action pair). The Cancel affordance is the
// backdrop/Escape (`onOpenChange(false)` → `onCancel`), which intentionally
// does NOT write a trust row — pure dismiss.
//
// IPC errors do NOT close the dialog: the action handler toasts an error and
// keeps the modal mounted so the user can retry.

import { useState } from 'react';
import { Button, Dialog, Modal as RACModal, ModalOverlay } from 'react-aria-components';
import { putTrustDecision } from '../../services/db/cryptoReceive';
import { useToastStore } from '../../stores/toastStore';

export interface TrustDialogProps {
  accountId: string;
  messageId: string;
  /** Signer cert email (From↔SAN resolved by the backend). Null for
   *  `unknown-key` where we deliberately don't trust the cert-supplied email. */
  signerEmail: string | null;
  /** Signer cert fingerprint (SHA-256 hex, possibly colon-formatted). */
  signerFingerprint: string;
  /** Why the dialog is being shown — drives the headline + body copy. */
  signatureState: 'valid-unverified' | 'unknown-key' | 'mismatch';
  /** Optional extra context line (issuer CN, chain state, revocation, etc.).
   *  Kept loose (string) so the dialog doesn't couple to the still-shifting
   *  chain-detail shape on the backend. */
  chainInfo?: string | null;
  /** Fired after a successful 'verified' write. Parent clears pendingTrust and
   *  re-opens the message so the badge flips to `valid-verified`. */
  onResolved: () => void;
  /** Fired on dismiss (backdrop/Escape) OR after a 'rejected' write. Parent
   *  unmounts the dialog. */
  onCancel: () => void;
}

// ──────────────────────────────────────────────────────────────────────────
// Copy per signatureState. The user-facing wording deliberately distinguishes
// the three decidably-untrusted states so the user has context for the choice.
// ──────────────────────────────────────────────────────────────────────────
function stateCopy(state: TrustDialogProps['signatureState']): {
  headline: string;
  body: string;
} {
  switch (state) {
    case 'valid-unverified':
      return {
        headline: 'Trust this signer?',
        body: "The signature is valid, but the signer's certificate chain isn't backed by a root you've marked as trusted.",
      };
    case 'unknown-key':
      return {
        headline: 'Trust this unknown signer?',
        body: "The signer's certificate is not in your keyring. Trusting it will mark future messages from this key as verified.",
      };
    case 'mismatch':
      return {
        headline: 'Trust this signer anyway?',
        body: 'The signer identity does not match the message From. Trusting it is not recommended unless you have verified the sender out-of-band.',
      };
  }
}

export function TrustDialog({
  accountId,
  messageId,
  signerEmail,
  signerFingerprint,
  signatureState,
  chainInfo,
  onResolved,
  onCancel,
}: TrustDialogProps) {
  const [busy, setBusy] = useState(false);
  const pushToast = useToastStore((s) => s.push);
  const { headline, body } = stateCopy(signatureState);

  async function writeDecision(decision: 'verified' | 'rejected', after: () => void) {
    if (busy) return;
    setBusy(true);
    try {
      await putTrustDecision({
        accountId,
        // The backend keys trust on the 4-tuple (account_id, peer_email,
        // 'smime', fingerprint) with EXACT match on both email + fingerprint
        // (db/trust_decisions.rs). For every signature state — including
        // `unknown-key` — the Rust row stores signer_email = the RFC 5322 From
        // header (mail/crypto.rs), so `signerEmail` round-trips the same value
        // the backend will look up. The `?? ''` fallback only fires for the
        // rare no-From-header case; an empty peer_email still isolates the row
        // by fingerprint + can be purged later from KeyManager.
        peerEmail: signerEmail ?? '',
        standard: 'smime',
        fingerprint: signerFingerprint,
        decision,
      });
      pushToast(decision === 'verified' ? 'Signer trusted' : 'Signer rejected', 'success');
      after();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast(`Trust decision failed: ${msg}`, 'error');
      // Keep the dialog mounted so the user can retry.
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        // Backdrop click / Escape. Pure dismiss — no DB write.
        if (!open && !busy) onCancel();
      }}
      isDismissable={!busy}
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-[var(--backdrop)] p-4"
    >
      <RACModal className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-xl outline-none">
        <Dialog
          aria-label={headline}
          className="outline-none"
          id={`trust-dialog-${messageId}`}
          data-testid="trust-dialog"
        >
          <div className="mb-3 flex items-start gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--amber)]/10 text-[var(--amber)]"
              aria-hidden="true"
            >
              {/* Inline shield glyph (mirrors CryptoBadge.tsx). */}
              <svg
                width={18}
                height={18}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 3l8 3v6c0 4.5-3 7.5-8 9-5-1.5-8-4.5-8-9V6l8-3z" />
                <path d="M12 9.5v3.5" />
                <circle cx="12" cy="16" r="0.6" fill="currentColor" stroke="currentColor" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-foreground">{headline}</h3>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-text">{body}</p>
            </div>
          </div>

          <div className="mb-3">
            <div className="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted-text">
              Signer
            </div>
            <div className="break-all rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground">
              {signerEmail ?? (
                <span className="italic text-muted-text">Unknown (not in your keyring)</span>
              )}
            </div>
          </div>

          <div className="mb-3">
            <div className="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted-text">
              Fingerprint
            </div>
            <div
              data-testid="trust-dialog-fingerprint"
              className="break-all rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground"
            >
              {signerFingerprint}
            </div>
          </div>

          {chainInfo && chainInfo.trim() && (
            <div className="mb-5">
              <div className="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted-text">
                Chain
              </div>
              <div className="break-words rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-text">
                {chainInfo}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              isDisabled={busy}
              onPress={() => void writeDecision('rejected', onCancel)}
              className="h-11 rounded-md px-3 text-sm text-foreground transition-colors hover:bg-hover disabled:opacity-50"
            >
              Don't trust
            </Button>
            <Button
              isDisabled={busy}
              onPress={() => void writeDecision('verified', onResolved)}
              className="h-11 rounded-md bg-primary px-3 text-sm text-primary-fg transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {busy ? '…' : 'Trust signer'}
            </Button>
          </div>
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
}

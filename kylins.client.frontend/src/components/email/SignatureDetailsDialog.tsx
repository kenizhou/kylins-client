// Signature details dialog — read-only RAC modal surfacing the parsed signer
// cert + chain path + verification outcome for a signed S/MIME message.
//
// Triggered by clicking the `CryptoBadge` in the ReadingPane (only when
// `message.isSigned`). On mount it calls `getSignerDetails` (backend re-parses
// the cached CMS blob — pure parse + DB reads, no decrypt, no network) and
// renders three sections: Verification, Signer certificate, Chain path.
//
// Structure mirrors `TrustDialog.tsx` (RAC `ModalOverlay`/`Modal`/`Dialog`,
// self-contained). Read-only — the only action is Close (`slot="close"`, RAC
// dismisses the overlay automatically). IPC errors do NOT close the dialog:
// the handler toasts an error and keeps the modal mounted so the user can
// retry (but since the fetch is on mount, the only retry is re-opening —
// matching the read-only contract).

import { useEffect, useState } from 'react';
import { Button, Dialog, Modal as RACModal, ModalOverlay } from 'react-aria-components';
import { getSignerDetails, type SignerDetails } from '../../services/db/cryptoReceive';
import { useToastStore } from '../../stores/toastStore';

export interface SignatureDetailsDialogProps {
  accountId: string;
  messageId: string;
  onClose: () => void;
}

// ──────────────────────────────────────────────────────────────────────────
// OID → human label maps (small, common S/MIME algorithms). Falls back to the
// dotted OID string so unknown algorithms still surface something useful.
// ──────────────────────────────────────────────────────────────────────────
const PUBLIC_KEY_LABELS: Record<string, string> = {
  '1.2.840.10045.2.1': 'EC (ECDSA/ECDH)',
  '1.2.840.113549.1.1.1': 'RSA',
  '1.3.101.112': 'Ed25519',
  '1.3.101.111': 'Ed448',
  '1.2.156.10197.1.301': 'SM2',
};

const SIGNATURE_LABELS: Record<string, string> = {
  '1.2.840.10045.4.3.2': 'ECDSA-with-SHA256',
  '1.2.840.10045.4.3.3': 'ECDSA-with-SHA384',
  '1.2.840.10045.4.3.4': 'ECDSA-with-SHA512',
  '1.2.840.113549.1.1.11': 'RSA-with-SHA256',
  '1.2.840.113549.1.1.12': 'RSA-with-SHA384',
  '1.2.840.113549.1.1.13': 'RSA-with-SHA512',
  '1.3.101.112': 'Ed25519',
  '1.2.156.10197.1.501': 'SM2-with-SM3',
};

function publicKeyLabel(oid: string): string {
  return PUBLIC_KEY_LABELS[oid] ?? oid;
}
function signatureLabel(oid: string): string {
  return SIGNATURE_LABELS[oid] ?? oid;
}

const SIGNATURE_STATE_LABELS: Record<string, string> = {
  'valid-verified': 'Valid (verified)',
  'valid-unverified': 'Valid (unverified)',
  invalid: 'Invalid',
  'unknown-key': 'Unknown signer',
  mismatch: 'Signer mismatch',
  'not-signed': 'Not signed',
};

const DECRYPT_STATE_LABELS: Record<string, string> = {
  ok: 'Decrypted',
  'no-key': 'No matching key',
  failed: 'Decryption failed',
  'n/a': 'Not encrypted',
};

const REVOCATION_LABELS: Record<string, string> = {
  good: 'Good',
  revoked: 'Revoked',
  unchecked: 'Unchecked',
};

const TRUST_LABELS: Record<string, string> = {
  personal: 'Personal (your key)',
  verified: 'Verified',
  unverified: 'Unverified',
  rejected: 'Rejected',
  undecided: 'Undecided',
};

function formatEpoch(epochSeconds: number): string {
  // epochSeconds is a SQLite `strftime('%s','now')` / x509 timestamp (UTC,
  // seconds). Render in the user's locale for readability.
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return '—';
  return new Date(epochSeconds * 1000).toLocaleString();
}

function validityLabel(notBeforeUnix: number, notAfterUnix: number): string {
  const now = Date.now() / 1000;
  if (Number.isFinite(notAfterUnix) && now > notAfterUnix) return 'expired';
  if (Number.isFinite(notBeforeUnix) && now < notBeforeUnix) return 'not yet valid';
  return 'valid';
}

// ──────────────────────────────────────────────────────────────────────────
// Field block — mirrors TrustDialog's label/value styling tokens so the two
// crypto dialogs read as one system.
// ──────────────────────────────────────────────────────────────────────────
function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-text)]">
        {label}
      </div>
      <div
        className={`break-all rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] ${
          mono ? 'font-mono text-xs' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export function SignatureDetailsDialog({
  accountId,
  messageId,
  onClose,
}: SignatureDetailsDialogProps) {
  const [details, setDetails] = useState<SignerDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const pushToast = useToastStore((s) => s.push);

  useEffect(() => {
    let cancelled = false;
    getSignerDetails(accountId, messageId)
      .then((d) => {
        if (cancelled) return;
        setDetails(d);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        pushToast(`Failed to load signature details: ${msg}`, 'error');
        setLoading(false);
        // Stay mounted (read-only) — the parent's onClose (backdrop/Escape)
        // is the only dismiss path, mirroring the IPC-error contract.
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, messageId, pushToast]);

  const headline = 'Signature details';

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        // Backdrop click / Escape → dismiss. No DB write (read-only dialog).
        if (!open) onClose();
      }}
      isDismissable={!loading}
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-black/40 p-4"
    >
      <RACModal className="w-full max-w-lg rounded-lg border border-[var(--border)] bg-[var(--background)] p-5 shadow-xl outline-none">
        <Dialog
          aria-label={headline}
          className="outline-none"
          id={`signature-details-${messageId}`}
          data-testid="signature-details-dialog"
        >
          <div className="mb-4 flex items-start gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--primary)]/10 text-[var(--primary)]"
              aria-hidden="true"
            >
              {/* Inline shield glyph (mirrors CryptoBadge/TrustDialog). */}
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
                <path d="M9 12l2 2 4-4" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-[var(--foreground)]">{headline}</h3>
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted-text)]">
                The signer certificate, certification path, and verification outcome for this
                message.
              </p>
            </div>
          </div>

          {loading ? (
            <div
              data-testid="signature-details-loading"
              className="py-8 text-center text-sm text-[var(--muted-text)]"
            >
              Loading…
            </div>
          ) : !details ? (
            <div
              data-testid="signature-details-empty"
              className="py-8 text-center text-sm text-[var(--muted-text)]"
            >
              No signature information available. Open the message first so it can be verified.
            </div>
          ) : (
            <div data-testid="signature-details-body" className="max-h-[60vh] overflow-auto pr-1">
              {/* Verification outcome (persisted — authoritative, includes
                  CRL-based revocation from open time). */}
              <Field
                label="Signature"
                value={SIGNATURE_STATE_LABELS[details.signatureState] ?? details.signatureState}
              />
              <div className="mb-3 grid grid-cols-2 gap-3">
                <Field
                  label="Chain"
                  value={
                    details.chainValid === null
                      ? 'Unchecked'
                      : details.chainValid
                        ? 'Valid'
                        : 'Invalid'
                  }
                />
                <Field
                  label="Revocation"
                  value={REVOCATION_LABELS[details.revocationState] ?? details.revocationState}
                />
              </div>
              <div className="mb-3 grid grid-cols-2 gap-3">
                <Field
                  label="Trust"
                  value={TRUST_LABELS[details.trustState] ?? details.trustState}
                />
                <Field
                  label="Decryption"
                  value={DECRYPT_STATE_LABELS[details.decryptState] ?? details.decryptState}
                />
              </div>
              <Field label="Verified at" value={formatEpoch(Number(details.verifiedAt))} />
              {details.failureReason && (
                <div className="mb-4 rounded-md border border-[var(--amber)]/40 bg-[var(--amber)]/5 px-3 py-2 text-xs text-[var(--amber)]">
                  {details.failureReason}
                </div>
              )}

              {/* Signer certificate (re-parsed from the cached CMS). */}
              {details.signer ? (
                <>
                  <div className="mb-1 mt-2 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-text)]">
                    Signer certificate
                  </div>
                  <div className="mb-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Subject" value={details.signer.subjectCn ?? '—'} />
                      <Field label="Issuer" value={details.signer.issuerCn ?? '—'} />
                    </div>
                    <Field label="Serial" value={details.signer.serialHex} mono />
                    <Field label="Fingerprint" value={details.signer.fingerprint} mono />
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Valid from" value={formatEpoch(details.signer.notBeforeUnix)} />
                      <Field label="Valid to" value={formatEpoch(details.signer.notAfterUnix)} />
                    </div>
                    <Field
                      label="Validity"
                      value={validityLabel(
                        details.signer.notBeforeUnix,
                        details.signer.notAfterUnix,
                      )}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <Field
                        label="Key algorithm"
                        value={publicKeyLabel(details.signer.publicKeyAlgorithmOid)}
                      />
                      <Field
                        label="Signature algorithm"
                        value={signatureLabel(details.signer.signatureAlgorithmOid)}
                      />
                    </div>
                    {details.signer.signingTimeUnix != null && (
                      <Field
                        label="Signed at"
                        value={formatEpoch(details.signer.signingTimeUnix)}
                      />
                    )}
                  </div>
                </>
              ) : (
                <div className="mb-3 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--muted-text)]">
                  Full signer certificate details are unavailable for this message (the signed data
                  is inside the decrypted body and is not re-parsed from the database). The
                  verification outcome above is still authoritative.
                </div>
              )}

              {/* Chain path (intermediates + the account's trust anchors). */}
              {details.chainPath.length > 0 && (
                <>
                  <div className="mb-1 mt-2 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-text)]">
                    Chain path
                  </div>
                  <ul className="mb-3 space-y-1">
                    {details.chainPath.map((entry, i) => (
                      <li
                        key={i}
                        className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs"
                      >
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 font-semibold ${
                            entry.isAnchor
                              ? 'bg-[var(--primary)]/10 text-[var(--primary)]'
                              : 'bg-[var(--hover)] text-[var(--muted-text)]'
                          }`}
                        >
                          {entry.isAnchor ? 'anchor' : 'intermediate'}
                        </span>
                        <span className="min-w-0 break-all text-[var(--foreground)]">
                          {entry.subjectCn ?? '—'}
                        </span>
                        <span className="shrink-0 text-[var(--muted-text)]">←</span>
                        <span className="min-w-0 break-all text-[var(--muted-text)]">
                          {entry.issuerCn ?? '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <div className="mt-2 flex justify-end">
            <Button
              onPress={onClose}
              className="h-11 rounded-md bg-[var(--primary)] px-4 text-sm text-[var(--primary-fg)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Close
            </Button>
          </div>
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
}

// G6 Task 2: granular CryptoBadge component.
//
// Renders the full MessageCryptoResult taxonomy (G6 T1) as compact glyphs
// for the reading pane / read ribbon. Replaces the binary SecurityChips
// (isEncrypted / isSigned) when the caller has the granular signature /
// decrypt / revocation states. SecurityChips stays intact for the
// message-list rows where only the boolean flags are available.
//
// Taxonomy → glyph mapping (see plan 4 §7 + the SignatureState table):
//
//   decrypt:
//     'ok'      → solid lock      (success)
//     'no-key'  → broken lock     (warning)
//     'failed'  → broken lock     (error)
//     'n/a'     → no glyph
//
//   signature:
//     'valid-verified'    → shield + ✓  (success)
//     'valid-unverified'  → shield + ◐  (warning)
//     'unknown-key'       → shield + ?  (muted)
//     'mismatch'          → shield + ⚠  (warning)
//     'invalid'           → shield + ✕  (error)
//     'not-signed'        → no glyph
//
//   revocation (overlay, only when unchecked/revoked):
//     'unchecked' → warning triangle (warning)
//     'revoked'   → warning triangle (error)
//     'good'      → no glyph
//
// Accessibility: the outer wrapper carries the combined `aria-label` +
// `title` (so the same text serves the screen-reader announcement and the
// visual tooltip). Sub-glyphs are `aria-hidden`. The label always names the
// signer email + fingerprint + chain/revocation detail, per the brief.
//
// The component is deterministic and presentational — no IPC, no stores. It
// reads only from its props, which makes it trivial to test and to reuse in
// the list row, reading pane, and read ribbon.

import type { CSSProperties, ReactNode } from 'react';
import type { MessageCryptoResult } from '@/services/db/cryptoReceive';

export interface CryptoBadgeProps {
  signatureState?: MessageCryptoResult['signatureState'];
  decryptState?: MessageCryptoResult['decryptState'];
  revocationState?: MessageCryptoResult['revocationState'];
  signerEmail?: string | null;
  signerFingerprint?: string | null;
  variant: 'icon' | 'label';
  size?: number;
}

// Narrowed unions. The Rust side stores these as String (the SQLite columns
// carry CHECK constraints matching exactly these literals), but the TS type
// forwards `string`. We narrow at the boundary so the switch-statements
// below are exhaustive and the SVG glyph pick is type-safe.
type SignatureState =
  | 'not-signed'
  | 'valid-verified'
  | 'valid-unverified'
  | 'invalid'
  | 'unknown-key'
  | 'mismatch';
type DecryptState = 'ok' | 'no-key' | 'failed' | 'n/a';
type RevocationState = 'good' | 'revoked' | 'unchecked';
type Tone = 'success' | 'warning' | 'error' | 'muted';

const SIGNATURE_STATES: ReadonlySet<string> = new Set<SignatureState>([
  'not-signed',
  'valid-verified',
  'valid-unverified',
  'invalid',
  'unknown-key',
  'mismatch',
]);
const DECRYPT_STATES: ReadonlySet<string> = new Set<DecryptState>([
  'ok',
  'no-key',
  'failed',
  'n/a',
]);
const REVOCATION_STATES: ReadonlySet<string> = new Set<RevocationState>([
  'good',
  'revoked',
  'unchecked',
]);

function isSignatureState(v?: string | null): v is SignatureState {
  return !!v && SIGNATURE_STATES.has(v);
}
function isDecryptState(v?: string | null): v is DecryptState {
  return !!v && DECRYPT_STATES.has(v);
}
function isRevocationState(v?: string | null): v is RevocationState {
  return !!v && REVOCATION_STATES.has(v);
}

/**
 * Normalise a fingerprint string into `AB:CD:EF:...` form (first 6 pairs).
 * Accepts hex with or without separators. Returns null if the input has no
 * usable hex characters. We cap at 6 pairs (12 hex chars) so the tooltip
 * stays readable; the full fingerprint is already available elsewhere in the
 * UI via the KeyManager / trust-decision flows.
 */
function formatFingerprint(fp?: string | null): string | null {
  if (!fp) return null;
  const hex = fp.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!hex) return null;
  const pairs: string[] = [];
  for (let i = 0; i < hex.length && pairs.length < 6; i += 2) {
    const pair = hex.slice(i, i + 2);
    if (pair.length === 2) pairs.push(pair);
  }
  return pairs.length ? pairs.join(':') : null;
}

function toneVar(tone: Tone): string {
  switch (tone) {
    case 'success':
      return 'var(--success)';
    case 'warning':
      return 'var(--amber)';
    case 'error':
      return 'var(--error)';
    case 'muted':
      return 'var(--muted-text)';
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Inline SVG glyphs
//
// Each is 24×24 and uses `currentColor` so the wrapper span's `style.color`
// controls the tone. The icons are intentionally distinct shapes (not just
// color variants) so the state remains readable without color (a11y) and in
// the icon-only list-row variant.
// ──────────────────────────────────────────────────────────────────────────

function LockClosedGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" fill="currentColor" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function LockBrokenGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 6.5-1.5" />
      {/* diagonal strike = "cannot decrypt" */}
      <path d="M4 4l16 16" />
    </svg>
  );
}

function ShieldGlyph({
  size,
  mark,
}: {
  size: number;
  mark: 'check' | 'half' | 'question' | 'alert' | 'x';
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3l8 3v6c0 4.5-3 7.5-8 9-5-1.5-8-4.5-8-9V6l8-3z" />
      {mark === 'check' && <path d="M9 12l2 2 4-4" />}
      {mark === 'half' && (
        <g>
          <circle cx="12" cy="13" r="3" fill="currentColor" stroke="none" />
          <path d="M12 10v6" stroke="var(--surface)" />
        </g>
      )}
      {mark === 'question' && (
        <g>
          <path d="M10.5 11a1.8 1.8 0 1 1 2.7 1.5c-.6.35-.95.75-.95 1.5" />
          <circle cx="12" cy="16" r="0.6" fill="currentColor" stroke="currentColor" />
        </g>
      )}
      {mark === 'alert' && (
        <g>
          <path d="M12 9.5v3.5" />
          <circle cx="12" cy="16" r="0.6" fill="currentColor" stroke="currentColor" />
        </g>
      )}
      {mark === 'x' && <path d="M10 11l4 4M14 11l-4 4" />}
    </svg>
  );
}

function WarningGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3l9 16H3z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="currentColor" />
    </svg>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Segments — each rendered state contributes one {glyph, label, tooltip}.
// ──────────────────────────────────────────────────────────────────────────

interface Segment {
  glyph: ReactNode;
  label: string;
  tooltip: string;
  tone: Tone;
}

function decryptSegment(state: DecryptState, size: number): Segment {
  switch (state) {
    case 'ok':
      return {
        glyph: <LockClosedGlyph size={size} />,
        label: 'Encrypted',
        tooltip: 'Encrypted — decrypted successfully',
        tone: 'success',
      };
    case 'no-key':
      return {
        glyph: <LockBrokenGlyph size={size} />,
        label: "Can't decrypt — no key",
        tooltip: 'Encrypted — cannot decrypt (no matching key)',
        tone: 'warning',
      };
    case 'failed':
      return {
        glyph: <LockBrokenGlyph size={size} />,
        label: 'Decryption failed',
        tooltip: 'Encrypted — decryption failed',
        tone: 'error',
      };
    case 'n/a':
      // filtered by caller; unreachable in practice.
      throw new Error('decryptState "n/a" filtered before segment construction');
  }
}

function signatureSegment(
  state: SignatureState,
  signerEmail: string | null | undefined,
  fingerprint: string | null | undefined,
  size: number,
): Segment {
  const email = signerEmail ?? null;
  const fp = formatFingerprint(fingerprint);
  const fpClause = fp ? ` (${fp})` : '';
  const who = email ?? (fp ? `fingerprint ${fp}` : 'unknown signer');
  switch (state) {
    case 'valid-verified':
      return {
        glyph: <ShieldGlyph size={size} mark="check" />,
        label: 'Signed',
        tooltip: `Signed by ${who}${fpClause}; signature valid, chain verified`,
        tone: 'success',
      };
    case 'valid-unverified':
      return {
        glyph: <ShieldGlyph size={size} mark="half" />,
        label: 'Signed (unverified)',
        tooltip: `Signed by ${who}${fpClause}; signature valid, chain unverified`,
        tone: 'warning',
      };
    case 'unknown-key':
      // The signer key isn't in the user's keyring, so we deliberately don't
      // surface the (untrusted) email from the cert — fingerprint only.
      return {
        glyph: <ShieldGlyph size={size} mark="question" />,
        label: 'Signed (unknown key)',
        tooltip: `Signed by unknown key${fpClause}; signer key not in keyring`,
        tone: 'muted',
      };
    case 'mismatch':
      return {
        glyph: <ShieldGlyph size={size} mark="alert" />,
        label: 'Signature mismatch',
        tooltip: `Signed by ${who}${fpClause}; signer mismatch — content may have been altered`,
        tone: 'warning',
      };
    case 'invalid':
      return {
        glyph: <ShieldGlyph size={size} mark="x" />,
        label: 'Signature invalid',
        tooltip: `Signed by ${who}${fpClause}; signature invalid`,
        tone: 'error',
      };
    case 'not-signed':
      throw new Error('signatureState "not-signed" filtered before segment construction');
  }
}

function revocationSegment(state: RevocationState, size: number): Segment | null {
  switch (state) {
    case 'unchecked':
      return {
        glyph: <WarningGlyph size={size} />,
        label: 'Revocation unchecked',
        tooltip: 'Revocation status unchecked',
        tone: 'warning',
      };
    case 'revoked':
      return {
        glyph: <WarningGlyph size={size} />,
        label: 'Cert revoked',
        tooltip: 'Signer certificate REVOKED',
        tone: 'error',
      };
    case 'good':
      return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────

export function CryptoBadge({
  signatureState,
  decryptState,
  revocationState,
  signerEmail,
  signerFingerprint,
  variant,
  size = 14,
}: CryptoBadgeProps) {
  const segments: Segment[] = [];

  if (isDecryptState(decryptState) && decryptState !== 'n/a') {
    segments.push(decryptSegment(decryptState, size));
  }
  if (isSignatureState(signatureState) && signatureState !== 'not-signed') {
    segments.push(signatureSegment(signatureState, signerEmail, signerFingerprint, size));
  }
  if (isRevocationState(revocationState) && revocationState !== 'good') {
    const seg = revocationSegment(revocationState, size);
    if (seg) segments.push(seg);
  }

  if (segments.length === 0) return null;

  const ariaLabel = segments.map((s) => s.tooltip).join('; ');
  const wrapperStyle: CSSProperties = { color: 'var(--muted-text)' };
  const className =
    variant === 'label'
      ? 'inline-flex items-center gap-1.5 text-[11px] text-[var(--muted-text)]'
      : 'inline-flex items-center gap-0.5 text-[var(--muted-text)]';

  return (
    <span
      data-testid="crypto-badge"
      role="img"
      aria-label={ariaLabel}
      title={ariaLabel}
      className={className}
      style={wrapperStyle}
    >
      {segments.map((seg, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-0.5"
          style={{ color: toneVar(seg.tone) }}
          aria-hidden="true"
        >
          {seg.glyph}
          {variant === 'label' && <span>{seg.label}</span>}
        </span>
      ))}
    </span>
  );
}

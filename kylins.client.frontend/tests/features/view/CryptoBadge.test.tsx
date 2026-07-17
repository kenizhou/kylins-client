// G6 Task 2: granular CryptoBadge component tests.
//
// Verifies the full MessageCryptoResult taxonomy is rendered with the right
// glyph + accessible label. Mirrors the SecurityChips / KeyManager.test.tsx
// style: real component render + @testing-library queries, no Tauri mocks
// needed (CryptoBadge is a pure presentational component with no IPC).
//
// The component is consumed by the reading pane + read ribbon (Task 3 will
// wire it in). Tests assert primarily on `aria-label` / `title` because that
// is both the user-facing tooltip text and the screen-reader announcement —
// the most stable contract the component exposes. We also assert on visible
// label text when `variant='label'`.

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CryptoBadge } from '../../../src/features/view/CryptoBadge';

// Helper: query by the outer badge wrapper. The wrapper span carries the
// combined `aria-label` and `title` per the brief's tooltip contract.
function badge() {
  return document.querySelector('[data-testid="crypto-badge"]') as HTMLElement | null;
}

describe('CryptoBadge', () => {
  // -------------------------------------------------------------------------
  // Null rendering — nothing to show.
  // -------------------------------------------------------------------------
  describe('null rendering', () => {
    it('renders nothing when no state props are passed', () => {
      const { container } = render(<CryptoBadge variant="label" />);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when all states are absent / good', () => {
      const { container } = render(
        <CryptoBadge
          variant="label"
          decryptState="n/a"
          signatureState="not-signed"
          revocationState="good"
        />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing for not-signed alone with no decrypt state', () => {
      const { container } = render(<CryptoBadge variant="label" signatureState="not-signed" />);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing for decrypt=n/a alone', () => {
      const { container } = render(<CryptoBadge variant="label" decryptState="n/a" />);
      expect(container.firstChild).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Signature taxonomy
  // -------------------------------------------------------------------------
  describe('signature states', () => {
    it('valid-verified: shield+check, success tone, signer in tooltip', () => {
      render(
        <CryptoBadge
          variant="label"
          signatureState="valid-verified"
          signerEmail="alice@example.com"
          signerFingerprint="AB:CD:EF:01:02:03:04:05"
        />,
      );
      const el = badge();
      expect(el).not.toBeNull();
      expect(el?.getAttribute('aria-label')).toMatch(/signed by alice@example\.com/i);
      expect(el?.getAttribute('aria-label')).toMatch(/AB:CD:EF/i);
      expect(el?.getAttribute('aria-label')).toMatch(/chain verified/i);
      // Visible label includes "Signed"
      expect(el?.textContent ?? '').toMatch(/signed/i);
    });

    it('valid-unverified: chain-unverified detail in tooltip', () => {
      render(
        <CryptoBadge
          variant="label"
          signatureState="valid-unverified"
          signerEmail="bob@example.com"
        />,
      );
      const el = badge();
      expect(el?.getAttribute('aria-label')).toMatch(/signed by bob@example\.com/i);
      expect(el?.getAttribute('aria-label')).toMatch(/chain unverified/i);
    });

    it('unknown-key: signer unknown detail in tooltip', () => {
      render(
        <CryptoBadge
          variant="label"
          signatureState="unknown-key"
          signerFingerprint="FF:EE:DD:CC:BB:AA"
        />,
      );
      const el = badge();
      expect(el?.getAttribute('aria-label')).toMatch(/unknown key/i);
      expect(el?.getAttribute('aria-label')).toMatch(/FF:EE:DD/i);
    });

    it('mismatch: signer-mismatch detail in tooltip', () => {
      render(
        <CryptoBadge variant="label" signatureState="mismatch" signerEmail="eve@example.com" />,
      );
      const el = badge();
      expect(el?.getAttribute('aria-label')).toMatch(/mismatch/i);
    });

    it('invalid: invalid-signature detail in tooltip', () => {
      render(
        <CryptoBadge variant="label" signatureState="invalid" signerEmail="eve@example.com" />,
      );
      const el = badge();
      expect(el?.getAttribute('aria-label')).toMatch(/signature invalid/i);
    });

    it('not-signed with decrypt=ok renders the decrypt glyph only', () => {
      render(<CryptoBadge variant="label" decryptState="ok" signatureState="not-signed" />);
      const el = badge();
      expect(el).not.toBeNull();
      // Should mention encryption, NOT signing.
      expect(el?.getAttribute('aria-label')).toMatch(/decrypt/i);
      expect(el?.getAttribute('aria-label')).not.toMatch(/signed by/i);
    });
  });

  // -------------------------------------------------------------------------
  // Decrypt taxonomy
  // -------------------------------------------------------------------------
  describe('decrypt states', () => {
    it('ok: solid lock, success tone', () => {
      render(<CryptoBadge variant="label" decryptState="ok" />);
      const el = badge();
      expect(el?.getAttribute('aria-label')).toMatch(/decrypt/i);
      expect(el?.getAttribute('aria-label')).toMatch(/ok|success/i);
      expect(el?.textContent ?? '').toMatch(/encrypt/i);
    });

    it('no-key: broken lock + no-key label', () => {
      render(<CryptoBadge variant="label" decryptState="no-key" />);
      const el = badge();
      expect(el?.getAttribute('aria-label')).toMatch(/no key|no matching key/i);
      expect(el?.textContent ?? '').toMatch(/no key/i);
    });

    it('failed: broken lock + failed label', () => {
      render(<CryptoBadge variant="label" decryptState="failed" />);
      const el = badge();
      expect(el?.getAttribute('aria-label')).toMatch(/decrypt/i);
      expect(el?.getAttribute('aria-label')).toMatch(/fail/i);
      expect(el?.textContent ?? '').toMatch(/fail/i);
    });
  });

  // -------------------------------------------------------------------------
  // Revocation overlay
  // -------------------------------------------------------------------------
  describe('revocation overlay', () => {
    it('unchecked: amber warning with revocation-unchecked detail', () => {
      render(
        <CryptoBadge
          variant="label"
          signatureState="valid-verified"
          signerEmail="alice@example.com"
          revocationState="unchecked"
        />,
      );
      const el = badge();
      expect(el?.getAttribute('aria-label')).toMatch(/revocation status unchecked/i);
      expect(el?.textContent ?? '').toMatch(/unchecked/i);
    });

    it('revoked: red warning with revoked detail', () => {
      render(
        <CryptoBadge
          variant="label"
          signatureState="valid-verified"
          signerEmail="alice@example.com"
          revocationState="revoked"
        />,
      );
      const el = badge();
      expect(el?.getAttribute('aria-label')).toMatch(/revoked/i);
      expect(el?.textContent ?? '').toMatch(/revoked/i);
    });

    it('good: no revocation warning in label', () => {
      render(
        <CryptoBadge
          variant="label"
          signatureState="valid-verified"
          signerEmail="alice@example.com"
          revocationState="good"
        />,
      );
      const el = badge();
      expect(el?.getAttribute('aria-label')).not.toMatch(/revocation|revoked/i);
    });
  });

  // -------------------------------------------------------------------------
  // Combined encryption + signature
  // -------------------------------------------------------------------------
  describe('combinations', () => {
    it('encrypted + signed valid-verified renders both glyphs and combined label', () => {
      render(
        <CryptoBadge
          variant="label"
          decryptState="ok"
          signatureState="valid-verified"
          signerEmail="alice@example.com"
          signerFingerprint="AB:CD:EF"
        />,
      );
      const el = badge();
      expect(el?.getAttribute('aria-label')).toMatch(/decrypt/i);
      expect(el?.getAttribute('aria-label')).toMatch(/signed by alice@example\.com/i);
      // Visible label has both Encrypted and Signed text.
      expect(el?.textContent ?? '').toMatch(/encrypt/i);
      expect(el?.textContent ?? '').toMatch(/signed/i);
    });

    it('decrypt no-key + signature invalid renders both errors', () => {
      render(
        <CryptoBadge
          variant="label"
          decryptState="no-key"
          signatureState="invalid"
          signerEmail="eve@example.com"
        />,
      );
      const el = badge();
      expect(el?.getAttribute('aria-label')).toMatch(/no matching key/i);
      expect(el?.getAttribute('aria-label')).toMatch(/signature invalid/i);
    });
  });

  // -------------------------------------------------------------------------
  // variant='icon' (compact)
  // -------------------------------------------------------------------------
  describe('variant=icon', () => {
    it('renders the badge without visible label text', () => {
      render(
        <CryptoBadge
          variant="icon"
          signatureState="valid-verified"
          signerEmail="alice@example.com"
        />,
      );
      const el = badge();
      expect(el).not.toBeNull();
      // aria-label still set for accessibility.
      expect(el?.getAttribute('aria-label')).toMatch(/signed by alice@example\.com/i);
      // Icon variant should NOT show the long-form label text — just the glyph.
      expect(el?.textContent ?? '').not.toMatch(/signed by/i);
    });

    it('renders null in icon variant when nothing to show', () => {
      const { container } = render(<CryptoBadge variant="icon" />);
      expect(container.firstChild).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Defensive: unknown / future string values
  // -------------------------------------------------------------------------
  describe('defensive handling of unknown values', () => {
    it('treats an unknown signature state string as no signature', () => {
      const { container } = render(
        <CryptoBadge variant="label" signatureState="some-future-state" />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('treats an unknown decrypt state string as no decrypt', () => {
      const { container } = render(
        <CryptoBadge variant="label" decryptState="some-future-state" />,
      );
      expect(container.firstChild).toBeNull();
    });
  });
});

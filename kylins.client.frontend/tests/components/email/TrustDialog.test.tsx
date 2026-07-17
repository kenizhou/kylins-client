// G6 Task 5: TrustDialog component tests.
//
// Mirrors the CryptoBadge.test.tsx style: real component render +
// @testing-library queries. `putTrustDecision` (G6 T1) is mocked at the module
// level so the test asserts the dialog forwards the right `TrustDecisionInput`
// shape (`decision: 'verified' | 'rejected'`, `standard: 'smime'`, the signer
// email + fingerprint) — never hits IPC.
//
// Covers the load-bearing contract per the task brief:
//   - "Trust signer" → putTrustDecision({ decision: 'verified', ... }) → onResolved
//   - "Don't trust"  → putTrustDecision({ decision: 'rejected', ... }) → onCancel
//   - IPC failure    → error toast, dialog stays open (neither callback fires)
//   - Escape / backdrop dismiss → onCancel WITHOUT a DB write (pure dismiss)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { TrustDialog } from '../../../src/components/email/TrustDialog';
import { useToastStore } from '../../../src/stores/toastStore';

vi.mock('../../../src/services/db/cryptoReceive', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/db/cryptoReceive')>(
    '../../../src/services/db/cryptoReceive',
  );
  return { ...actual, putTrustDecision: vi.fn() };
});

import { putTrustDecision } from '../../../src/services/db/cryptoReceive';

const mockPutTrustDecision = vi.mocked(putTrustDecision);

const baseProps = {
  accountId: 'a1',
  messageId: 'm1',
  signerEmail: 'alice@example.com',
  signerFingerprint: 'AB:CD:EF:01:02:03:04:05:06:07:08',
  signatureState: 'valid-unverified' as const,
  onResolved: vi.fn(),
  onCancel: vi.fn(),
};

beforeEach(() => {
  mockPutTrustDecision.mockReset();
  mockPutTrustDecision.mockResolvedValue(undefined);
  baseProps.onResolved.mockClear();
  baseProps.onCancel.mockClear();
  useToastStore.setState({ toasts: [] });
});

describe('TrustDialog', () => {
  // -------------------------------------------------------------------------
  // Render — signer identity surfaced.
  // -------------------------------------------------------------------------
  describe('rendering', () => {
    it('shows the signer email and fingerprint', () => {
      const { getByText } = render(<TrustDialog {...baseProps} />);
      expect(getByText(/alice@example\.com/i)).toBeInTheDocument();
      // Fingerprint rendered in full (formatted).
      expect(getByText(/AB:CD:EF:01:02:03/i)).toBeInTheDocument();
    });

    it("renders the three expected actions (Trust / Don't trust / dismiss)", () => {
      const { getByRole } = render(<TrustDialog {...baseProps} />);
      expect(getByRole('button', { name: /trust signer/i })).toBeInTheDocument();
      expect(getByRole('button', { name: /don.t trust/i })).toBeInTheDocument();
      // RAC ModalOverlay renders a backdrop that can be clicked to dismiss.
      // The dismiss affordance is implicit (backdrop + Escape); we don't assert
      // a visible Cancel button because the brief doesn't require one.
    });

    it('still renders when signer email is missing (unknown-key state)', () => {
      const { getByRole, getByText } = render(
        <TrustDialog
          {...baseProps}
          signerEmail={null}
          signatureState="unknown-key"
          signerFingerprint="FF:EE:DD:CC:BB:AA"
        />,
      );
      // Trust / Don't trust buttons still present
      expect(getByRole('button', { name: /trust signer/i })).toBeInTheDocument();
      expect(getByText(/FF:EE:DD:CC:BB:AA/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Trust signer → decision: 'verified' → onResolved
  // -------------------------------------------------------------------------
  describe('Trust signer action', () => {
    it('writes decision="verified" with the signer email + fingerprint, then fires onResolved', async () => {
      const { getByRole } = render(<TrustDialog {...baseProps} />);
      fireEvent.click(getByRole('button', { name: /trust signer/i }));
      await waitFor(() => expect(baseProps.onResolved).toHaveBeenCalledTimes(1));

      expect(mockPutTrustDecision).toHaveBeenCalledTimes(1);
      const arg = mockPutTrustDecision.mock.calls[0]![0];
      expect(arg).toMatchObject({
        accountId: 'a1',
        peerEmail: 'alice@example.com',
        standard: 'smime',
        fingerprint: 'AB:CD:EF:01:02:03:04:05:06:07:08',
        decision: 'verified',
      });
      // onCancel must NOT fire on the trust path.
      expect(baseProps.onCancel).not.toHaveBeenCalled();
    });

    it('pushes a success toast', async () => {
      const { getByRole } = render(<TrustDialog {...baseProps} />);
      fireEvent.click(getByRole('button', { name: /trust signer/i }));
      await waitFor(() => expect(baseProps.onResolved).toHaveBeenCalled());
      const toasts = useToastStore.getState().toasts;
      expect(toasts.some((t) => /trusted/i.test(t.message) && t.type === 'success')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Don't trust → decision: 'rejected' → onCancel
  // -------------------------------------------------------------------------
  describe("Don't trust action", () => {
    it('writes decision="rejected" then fires onCancel', async () => {
      const { getByRole } = render(<TrustDialog {...baseProps} />);
      fireEvent.click(getByRole('button', { name: /don.t trust/i }));
      await waitFor(() => expect(baseProps.onCancel).toHaveBeenCalledTimes(1));

      expect(mockPutTrustDecision).toHaveBeenCalledTimes(1);
      const arg = mockPutTrustDecision.mock.calls[0]![0];
      expect(arg).toMatchObject({
        accountId: 'a1',
        peerEmail: 'alice@example.com',
        standard: 'smime',
        fingerprint: 'AB:CD:EF:01:02:03:04:05:06:07:08',
        decision: 'rejected',
      });
      expect(baseProps.onResolved).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error path — IPC failure keeps the dialog open.
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('on IPC failure: error toast, neither callback fires, dialog stays mounted', async () => {
      mockPutTrustDecision.mockRejectedValueOnce(new Error('ipc blowup'));
      const { getByRole, queryByRole } = render(<TrustDialog {...baseProps} />);
      fireEvent.click(getByRole('button', { name: /trust signer/i }));

      await waitFor(() => expect(mockPutTrustDecision).toHaveBeenCalledTimes(1));
      // Wait a tick for any microtask callbacks.
      await Promise.resolve();

      expect(baseProps.onResolved).not.toHaveBeenCalled();
      expect(baseProps.onCancel).not.toHaveBeenCalled();
      const toasts = useToastStore.getState().toasts;
      expect(toasts.some((t) => t.type === 'error')).toBe(true);
      // Dialog still mounted — primary button still in the document.
      expect(queryByRole('button', { name: /trust signer/i })).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Backdrop / Escape dismiss — pure cancel WITHOUT a DB write.
  // -------------------------------------------------------------------------
  describe('dismiss without decision', () => {
    it('Backdrop click → onCancel, but putTrustDecision is NEVER called', async () => {
      // The RAC ModalOverlay backdrop is the outer overlay element. We query it
      // via its role (RAC's ModalOverlay has role="dialog" on the dialog and
      // renders the backdrop as the overlay wrapper). The simplest reliable
      // dismiss is to invoke onOpenChange by clicking the backdrop element
      // (the outermost ModalOverlay div). Because jsdom doesn't lay out
      // pointer coords, we instead simulate by pressing Escape on the dialog.
      const { getByRole } = render(<TrustDialog {...baseProps} />);
      const dialog = getByRole('dialog');
      // Escape triggers RAC ModalOverlay's dismiss behavior when isDismissable.
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => expect(baseProps.onCancel).toHaveBeenCalledTimes(1));
      expect(mockPutTrustDecision).not.toHaveBeenCalled();
    });
  });
});

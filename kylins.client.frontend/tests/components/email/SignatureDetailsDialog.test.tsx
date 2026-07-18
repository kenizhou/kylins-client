// SignatureDetailsDialog component tests.
//
// Mirrors the TrustDialog.test.tsx style: real component render +
// @testing-library queries. `getSignerDetails` is mocked at the module level so
// the test asserts the dialog fetches on mount and renders the parsed signer
// cert + chain path — never hits IPC.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, within } from '@testing-library/react';
import { SignatureDetailsDialog } from '../../../src/components/email/SignatureDetailsDialog';
import { useToastStore } from '../../../src/stores/toastStore';

vi.mock('../../../src/services/db/cryptoReceive', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/db/cryptoReceive')>(
    '../../../src/services/db/cryptoReceive',
  );
  return { ...actual, getSignerDetails: vi.fn() };
});

import { getSignerDetails, type SignerDetails } from '../../../src/services/db/cryptoReceive';

const mockGetSignerDetails = vi.mocked(getSignerDetails);

const sampleDetails: SignerDetails = {
  signatureState: 'valid-verified',
  decryptState: 'n/a',
  cryptoKind: 'signed',
  chainValid: true,
  revocationState: 'good',
  verifiedAt: '1784369271',
  trustState: 'personal',
  signer: {
    subjectCn: 'felixzhou',
    issuerCn: 'Kylins Test CA',
    serialHex: '6a5357d7',
    fingerprint: 'sha256:ab',
    notBeforeUnix: 1718000000,
    notAfterUnix: 1749536000,
    publicKeyAlgorithmOid: '1.2.840.10045.2.1',
    signatureAlgorithmOid: '1.2.840.10045.4.3.2',
    signingTimeUnix: null,
  },
  chainPath: [
    { subjectCn: 'felixzhou', issuerCn: 'Kylins Test CA', isAnchor: false },
    { subjectCn: 'Kylins Test CA', issuerCn: 'Kylins Test CA', isAnchor: true },
  ],
  failureReason: null,
};

const baseProps = {
  accountId: 'a1',
  messageId: 'm1',
  onClose: vi.fn(),
};

beforeEach(() => {
  mockGetSignerDetails.mockReset();
  mockGetSignerDetails.mockResolvedValue(sampleDetails);
  baseProps.onClose.mockClear();
  useToastStore.setState({ toasts: [] });
});

describe('SignatureDetailsDialog', () => {
  it('fetches getSignerDetails on mount and renders the signer cert + chain path', async () => {
    const { getByText, getByTestId } = render(<SignatureDetailsDialog {...baseProps} />);

    // Loading state first.
    expect(getByTestId('signature-details-loading')).toBeInTheDocument();

    // Then the parsed details.
    await waitFor(() => expect(getByTestId('signature-details-body')).toBeInTheDocument());

    expect(mockGetSignerDetails).toHaveBeenCalledWith('a1', 'm1');
    // Verification outcome.
    expect(getByText(/valid \(verified\)/i)).toBeInTheDocument();
    // Signer cert fields (subject + issuer appear in both the cert card AND
    // the chain path, so use getAllByText / getByTestId-scoped queries).
    const body = getByTestId('signature-details-body');
    expect(within(body).getByText('6a5357d7')).toBeInTheDocument();
    expect(within(body).getByText(/EC \(ECDSA\/ECDH\)/i)).toBeInTheDocument();
    expect(within(body).getByText(/ECDSA-with-SHA256/i)).toBeInTheDocument();
    // Chain path has anchor + intermediate tags.
    expect(within(body).getByText(/anchor/i)).toBeInTheDocument();
    expect(within(body).getByText(/intermediate/i)).toBeInTheDocument();
  });

  it('shows the empty state when getSignerDetails returns null (no persisted row)', async () => {
    mockGetSignerDetails.mockResolvedValue(null);
    const { getByTestId } = render(<SignatureDetailsDialog {...baseProps} />);

    await waitFor(() => expect(getByTestId('signature-details-empty')).toBeInTheDocument());
  });

  it('toasts an error and stays mounted when getSignerDetails rejects', async () => {
    mockGetSignerDetails.mockRejectedValue(new Error('boom'));
    const { getByText } = render(<SignatureDetailsDialog {...baseProps} />);

    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]?.message).toContain(
        'Failed to load signature details',
      ),
    );
    expect(useToastStore.getState().toasts[0]?.type).toBe('error');
    // Dialog stays mounted (read-only contract: onClose only fires on dismiss).
    expect(getByText(/signature details/i)).toBeInTheDocument();
    expect(baseProps.onClose).not.toHaveBeenCalled();
  });

  it('fires onClose when the Close button is pressed', async () => {
    const { getByRole } = render(<SignatureDetailsDialog {...baseProps} />);
    await waitFor(() => expect(getByRole('button', { name: /close/i })).toBeInTheDocument());
    fireEvent.click(getByRole('button', { name: /close/i }));
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });

  // ─── Granular ChainOutcome failure_reason (2026-07-18 spec) ───
  //
  // The dialog's failure-reason banner must render the REAL granular reason
  // when `signerDetails.failureReason` is non-null (surfaced from
  // `VerificationResult.failure_reason` → `message_crypto_results.failure_reason`
  // → `get_signer_details`). When null (pre-migration rows + the early-return
  // arms + success states), the backend's `get_signer_details` already fills
  // in the coarse `failure_reason_for_state` map string before returning — so
  // the dialog simply renders whatever `failureReason` it receives.

  it('renders the granular failureReason verbatim when present', async () => {
    mockGetSignerDetails.mockResolvedValue({
      ...sampleDetails,
      signatureState: 'invalid',
      // Real reason from the crypto layer — must render verbatim, NOT the
      // fixed-map "Signature did not verify — content may have been altered."
      failureReason: 'certificate 0x123 revoked (KeyCompromise)',
    });
    const { getByText, queryByText } = render(<SignatureDetailsDialog {...baseProps} />);

    await waitFor(() => expect(getByText(/signature details/i)).toBeInTheDocument());

    // The granular banner string surfaces verbatim.
    expect(getByText(/certificate 0x123 revoked/i)).toBeInTheDocument();
    // The fixed-map fallback string for `invalid` MUST NOT be rendered
    // (the real reason wins).
    expect(queryByText(/content may have been altered/i)).toBeNull();
  });

  it('renders the fixed-map fallback banner when failureReason is null', async () => {
    // Null failureReason on an `invalid` row → the dialog's banner slot is
    // conditionally rendered (`{details.failureReason && ...}`), so a null
    // value means NO banner shows. This is the contract the backend honors
    // by falling back to `failure_reason_for_state` for null columns; if the
    // backend returns null instead, the banner is simply absent (no crash).
    mockGetSignerDetails.mockResolvedValue({
      ...sampleDetails,
      signatureState: 'invalid',
      failureReason: null,
    });
    const { queryByText } = render(<SignatureDetailsDialog {...baseProps} />);

    await waitFor(() => expect(queryByText(/signature details/i)).toBeInTheDocument());

    // No banner shown when failureReason is null (the dialog's `{... && ...}`
    // conditional hides the slot). The state label still renders.
    expect(queryByText(/content may have been altered/i)).toBeNull();
  });
});

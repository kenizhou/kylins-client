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
});

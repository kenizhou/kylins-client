// DA-Task 3: AttachmentList crypto branch. Verifies that when a decrypted
// encrypted message is rendered, the component shows attachments sourced from
// the decrypted inner MIME (`decryptedAttachments` prop) and routes downloads
// through `fetchCryptoAttachment` + `copy_cached_attachment` (NOT the plain
// `sync_fetch_attachment` path). The plain path (no `isCrypto`) is covered by
// the existing ReadingPane tests; here we pin the crypto branch only.
//
// Mirrors KeyManager.test.tsx: relative-path `vi.mock`, real zustand stores
// seeded via `setState` (none needed here — AttachmentList is prop-driven),
// `fireEvent` for clicks, `waitFor` for async download.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { AttachmentList } from '../../../src/components/email/AttachmentList';
import type { ImapAttachment } from '../../../src/services/db/cryptoReceive';

// Mock the attachments service — both the plain wrappers (must NOT fire for
// the crypto branch) and the crypto wrappers (asserted on download).
vi.mock('../../../src/services/db/attachments', () => ({
  getAttachments: vi.fn().mockResolvedValue([]),
  fetchAttachment: vi.fn(),
  fetchInlineImages: vi.fn().mockResolvedValue([]),
  fetchCryptoAttachment: vi.fn().mockResolvedValue({
    filePath: '/cache/decrypted.pdf',
    filename: 'doc.pdf',
    mimeType: 'application/pdf',
    size: 1234,
  }),
  fetchCryptoInlineImages: vi.fn().mockResolvedValue([]),
  referencedCids: vi.fn().mockReturnValue(new Set<string>()),
}));

// Mock the Tauri dialog plugin — `save()` returns a deterministic dest path.
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn().mockResolvedValue('/downloads/doc.pdf'),
}));

// Mock Tauri core invoke so we can assert `copy_cached_attachment` is called.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

function makeAtt(overrides: Partial<ImapAttachment> = {}): ImapAttachment {
  return {
    part_id: '2',
    filename: 'doc.pdf',
    mime_type: 'application/pdf',
    size: 1234,
    content_id: null,
    is_inline: false,
    ...overrides,
  };
}

const THREE_ATTS: ImapAttachment[] = [
  makeAtt({ part_id: '2', filename: 'doc.pdf', content_id: null }),
  makeAtt({ part_id: '3', filename: 'image.png', content_id: null }),
  makeAtt({ part_id: '4', filename: 'sheet.xlsx', content_id: null }),
];

describe('AttachmentList — crypto branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one chip per decryptedAttachments entry when isCrypto', async () => {
    await render(
      <AttachmentList
        accountId="acct"
        messageId="msg-1"
        bodyHtml=""
        isCrypto
        decryptedAttachments={THREE_ATTS}
      />,
    );
    expect(await screen.findByText('doc.pdf')).toBeInTheDocument();
    expect(screen.getByText('image.png')).toBeInTheDocument();
    expect(screen.getByText('sheet.xlsx')).toBeInTheDocument();
  });

  it('does NOT call getAttachments when isCrypto && decryptedAttachments.length', async () => {
    const { getAttachments } = await import('../../../src/services/db/attachments');
    render(
      <AttachmentList
        accountId="acct"
        messageId="msg-1"
        bodyHtml=""
        isCrypto
        decryptedAttachments={THREE_ATTS}
      />,
    );
    await waitFor(() => {
      expect(getAttachments).not.toHaveBeenCalled();
    });
  });

  it('download — calls fetchCryptoAttachment + copy_cached_attachment (NOT fetchAttachment)', async () => {
    const { fetchCryptoAttachment, fetchAttachment } =
      await import('../../../src/services/db/attachments');
    render(
      <AttachmentList
        accountId="acct"
        messageId="msg-1"
        bodyHtml=""
        isCrypto
        decryptedAttachments={THREE_ATTS}
      />,
    );
    const chip = await screen.findByText('doc.pdf');
    // Click the chip's button (chip text is inside the button).
    fireEvent.click(chip.closest('button')!);
    await waitFor(() => {
      expect(fetchCryptoAttachment).toHaveBeenCalledWith('acct', 'msg-1', 'doc.pdf', null);
    });
    // copy_cached_attachment is invoked with srcPath=filePath, destPath=save().
    expect(invoke).toHaveBeenCalledWith('copy_cached_attachment', {
      srcPath: '/cache/decrypted.pdf',
      destPath: '/downloads/doc.pdf',
    });
    // The plain fetchAttachment path must NOT fire for crypto downloads.
    expect(fetchAttachment).not.toHaveBeenCalled();
  });

  it('hides inline attachments whose content_id is referenced in bodyHtml', async () => {
    // referencedCids is mocked to return empty by default; override per-test.
    const { referencedCids } = await import('../../../src/services/db/attachments');
    vi.mocked(referencedCids).mockReturnValue(new Set(['inline-1']));
    const atts: ImapAttachment[] = [
      makeAtt({ part_id: '2', filename: 'visible.pdf', content_id: null }),
      makeAtt({
        part_id: '3',
        filename: 'hidden.png',
        content_id: 'inline-1',
        is_inline: true,
      }),
    ];
    render(
      <AttachmentList
        accountId="acct"
        messageId="msg-1"
        bodyHtml="<img src='cid:inline-1' />"
        isCrypto
        decryptedAttachments={atts}
      />,
    );
    expect(await screen.findByText('visible.pdf')).toBeInTheDocument();
    expect(screen.queryByText('hidden.png')).not.toBeInTheDocument();
  });
});

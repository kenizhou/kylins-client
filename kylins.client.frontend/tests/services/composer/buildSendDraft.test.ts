// Unit tests for `buildSendDraft` — the DraftInput → SendDraft converter that
// runs at send time on the frontend.
//
// The Tauri fs + path APIs are mocked so each staged file lands in a virtual
// in-memory map keyed by destination path. This lets us assert:
//  - HTML body is prepared (juice inline + signature unwrap) and a plain-text
//    alternative is produced.
//  - Inline `data:` URLs are rewritten to `cid:` and an `AttachmentRef` with
//    matching `cid` is emitted (no base64 in the SendDraft).
//  - Importance / read-receipt / prevent-copy flags become `extraHeaders`
//    tuples.
//  - Regular attachments are staged to disk and emitted as `AttachmentRef`
//    with `filePath` (no base64 in the SendDraft).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildSendDraft } from '../../../src/services/composer/buildSendDraft';
import type { DraftInput } from '../../../src/services/composer/drafts';

// --- Mocks ---------------------------------------------------------------
//
// `appDataDir`/`join` are stable strings; `mkdir` is a no-op; `writeFile`
// captures bytes into a map so the test can inspect what got staged.

const STAGED: Map<string, Uint8Array> = new Map();

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/appdata',
  join: async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: async () => undefined,
  writeFile: async (path: string, data: Uint8Array) => {
    STAGED.set(path, data);
  },
  copyFile: async () => undefined,
  exists: async () => false,
  remove: async () => undefined,
}));

beforeEach(() => STAGED.clear());

// --- Helpers -------------------------------------------------------------

function baseInput(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    accountId: 'acc-1',
    to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Hello',
    bodyHtml: '<p>Hi <signature>—Alice</signature></p>',
    fromEmail: 'alice@example.com',
    ...overrides,
  };
}

// --- Tests ---------------------------------------------------------------

describe('composer/buildSendDraft', () => {
  it('produces htmlBody + textBody and unwraps <signature>', async () => {
    const draft = await buildSendDraft(baseInput(), 'draft-1', 'fallback@example.com');
    expect(draft.htmlBody).toContain('<p>Hi');
    // The non-standard <signature> wrapper is stripped; content preserved.
    expect(draft.htmlBody).not.toContain('<signature>');
    expect(draft.htmlBody).toContain('—Alice');
    expect(draft.textBody).toMatch(/Hi.*—Alice/s);
  });

  it('strips the display name when it equals the email', async () => {
    const draft = await buildSendDraft(
      baseInput({ to: [{ name: 'bob@example.com', email: 'bob@example.com' }] }),
      'draft-1',
      'fallback@example.com',
    );
    expect(draft.to[0]).toEqual({ email: 'bob@example.com' });
    expect(draft.to[0].name).toBeUndefined();
  });

  it('keeps the display name when distinct from the email', async () => {
    const draft = await buildSendDraft(baseInput(), 'draft-1', 'fallback@example.com');
    expect(draft.to[0]).toEqual({ name: 'Bob', email: 'bob@example.com' });
  });

  it('extracts inline data: URLs into cid refs staged on disk', async () => {
    const pngBase64 = 'iVBORw0KGgo=';
    const bodyHtml = `<p><img src="data:image/png;base64,${pngBase64}" alt="logo"/></p>`;
    const draft = await buildSendDraft(baseInput({ bodyHtml }), 'draft-inline', 'me@x.com');

    // The body no longer carries the base64 data URL.
    expect(draft.htmlBody).not.toContain(pngBase64);
    expect(draft.htmlBody).toMatch(/src="cid:inline_/);
    // The inline image is staged to disk and referenced by cid.
    expect(draft.inlineImages).toBeDefined();
    expect(draft.inlineImages).toHaveLength(1);
    const img = draft.inlineImages![0]!;
    expect(img.cid).toMatch(/^inline_/);
    expect(img.mimeType).toBe('image/png');
    expect(img.filePath).toContain('outbox-attachments/draft-inline/');
    expect(img.filePath).toMatch(/\.png$/);
    // The decoded bytes were written to disk.
    expect(STAGED.get(img.filePath)).toBeDefined();
    // No base64 leaked into the SendDraft.
    expect(JSON.stringify(draft)).not.toContain(pngBase64);
  });

  it('maps importance/read-receipt/prevent-copy to extraHeaders tuples', async () => {
    const draft = await buildSendDraft(
      baseInput({
        importance: 'high',
        requestReadReceipt: true,
        requestDeliveryReceipt: true,
        preventCopy: true,
      }),
      'draft-hdrs',
      'fallback@example.com',
    );
    expect(draft.extraHeaders).toBeDefined();
    const headers = draft.extraHeaders!;
    // Tuple-array shape: [[name, value], ...].
    expect(Array.isArray(headers)).toBe(true);
    for (const row of headers) expect(Array.isArray(row)).toBe(true);
    expect(headers).toEqual(
      expect.arrayContaining([
        ['X-Priority', '1'],
        ['Importance', 'high'],
        ['Disposition-Notification-To', 'alice@example.com'],
        ['Return-Receipt-To', 'alice@example.com'],
        ['X-Classification-Prevent-Copy', 'true'],
      ]),
    );
  });

  it('omits extraHeaders/inlineImages/attachments when nothing applies', async () => {
    const draft = await buildSendDraft(baseInput(), 'draft-1', 'fallback@example.com');
    expect(draft.extraHeaders).toBeUndefined();
    expect(draft.inlineImages).toBeUndefined();
    expect(draft.attachments).toBeUndefined();
  });

  it('passes regular attachment filePath through unchanged (no decode, no base64 in IPC)', async () => {
    // T7b: the composer stages files at pick time and only the filePath
    // reaches buildSendDraft. The converter must pass it through verbatim —
    // never decode base64, never re-stage — so a 200 MB attachment stays a
    // path reference all the way to the backend MIME builder.
    const filePath = '/appdata/outbox-attachments/draft-att/a.txt';
    const draft = await buildSendDraft(
      baseInput({
        attachments: [{ filename: 'a.txt', mimeType: 'text/plain', filePath, size: 1 }],
      }),
      'draft-att',
      'fallback@example.com',
    );
    expect(draft.attachments).toBeDefined();
    expect(draft.attachments).toHaveLength(1);
    const att = draft.attachments![0]!;
    expect(att.filename).toBe('a.txt');
    expect(att.mimeType).toBe('text/plain');
    // The filePath is passed through verbatim — never re-staged.
    expect(att.filePath).toBe(filePath);
    expect(att.cid).toBeUndefined();
    // Nothing was written by buildSendDraft for a path-backed attachment.
    expect(STAGED.size).toBe(0);
    // No base64 leaked into the IPC payload.
    expect(JSON.stringify(draft)).not.toMatch(/content|YQ==/);
  });

  it('backfills legacy base64 attachments via stageAttachmentBytes (one-time migration)', async () => {
    // Pre-T7b draft rows may still carry base64 `content` with no `filePath`.
    // buildSendDraft detects this and stages the bytes at send time so old
    // drafts still send correctly. The composer itself never emits this shape.
    const draft = await buildSendDraft(
      baseInput({
        attachments: [
          // 'a' base64-decoded is one byte (0x61).
          { filename: 'a.txt', mimeType: 'text/plain', content: 'YQ==', size: 1 },
        ],
      }),
      'draft-legacy',
      'fallback@example.com',
    );
    expect(draft.attachments).toBeDefined();
    expect(draft.attachments).toHaveLength(1);
    const att = draft.attachments![0]!;
    expect(att.filename).toBe('a.txt');
    expect(att.filePath).toContain('outbox-attachments/draft-legacy/a.txt');
    // The byte was actually written by the backfill path.
    const bytes = STAGED.get(att.filePath)!;
    expect(bytes).toBeDefined();
    expect(bytes.length).toBe(1);
    expect(bytes[0]).toBe(0x61);
    // No base64 leaked into the IPC payload.
    expect(JSON.stringify(draft)).not.toContain('YQ==');
  });

  it('sets inReplyTo when the input carries it; leaves references undefined', async () => {
    const draft = await buildSendDraft(
      baseInput({ inReplyToMessageId: '<orig@example.com>' }),
      'draft-re',
      'fallback@example.com',
    );
    expect(draft.inReplyTo).toBe('<orig@example.com>');
    expect(draft.references).toBeUndefined();
  });

  it('falls back to fallbackFrom when fromEmail is null', async () => {
    const draft = await buildSendDraft(
      baseInput({ fromEmail: null }),
      'draft-1',
      'fallback@example.com',
    );
    expect(draft.from).toEqual({ email: 'fallback@example.com' });
  });

  it('populates cc/bcc/replyTo only when present', async () => {
    const draft = await buildSendDraft(
      baseInput({
        cc: [{ name: 'carol', email: 'carol@example.com' }],
        bcc: [{ name: 'dan@example.com', email: 'dan@example.com' }],
        replyTo: [{ name: 'alice@example.com', email: 'alice@example.com' }],
      }),
      'draft-1',
      'fallback@example.com',
    );
    expect(draft.cc).toEqual([{ name: 'carol', email: 'carol@example.com' }]);
    expect(draft.bcc).toEqual([{ email: 'dan@example.com' }]);
    expect(draft.replyTo).toEqual({ email: 'alice@example.com' });
  });
});

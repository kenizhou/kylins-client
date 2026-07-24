// Tests for the shared draft-session mapper — this is where the window
// composer's silent field loss lived (its private autosave mapper dropped
// classification, crypto flags, importance, receipts, deliverAt, preventCopy,
// and replyTo on every save). Regression-pin the FULL field set.

import { describe, it, expect } from 'vitest';
import {
  draftSessionToDraftInput,
  type DraftSessionFields,
} from '../../../src/features/composer/draftSession';

const fullFields = (over: Partial<DraftSessionFields> = {}): DraftSessionFields => ({
  to: [{ name: 'Alice', email: 'alice@x.com' }],
  cc: [{ name: 'Bob', email: 'bob@x.com' }],
  bcc: [{ name: 'Carol', email: 'carol@x.com' }],
  replyTo: [{ name: 'RT', email: 'replyto@x.com' }],
  subject: 'Quarterly plan',
  bodyHtml: '<p>body</p>',
  fromEmail: 'me@x.com',
  threadId: 't1',
  inReplyToMessageId: '<m@x>',
  signatureId: 'sig-1',
  attachments: [
    { filename: 'a.pdf', mimeType: 'application/pdf', filePath: '/outbox/a.pdf', size: 10 },
  ],
  classificationId: 'confidential',
  isEncrypted: true,
  isSigned: true,
  importance: 'high',
  requestReadReceipt: true,
  requestDeliveryReceipt: true,
  deliverAt: 1_900_000_000,
  preventCopy: true,
  ...over,
});

describe('draftSessionToDraftInput', () => {
  it('maps the complete field set (no silent drops)', () => {
    const input = draftSessionToDraftInput(fullFields(), 'acc-1');
    expect(input).toEqual({
      accountId: 'acc-1',
      to: [{ name: 'Alice', email: 'alice@x.com' }],
      cc: [{ name: 'Bob', email: 'bob@x.com' }],
      bcc: [{ name: 'Carol', email: 'carol@x.com' }],
      replyTo: [{ name: 'RT', email: 'replyto@x.com' }],
      subject: 'Quarterly plan',
      bodyHtml: '<p>body</p>',
      fromEmail: 'me@x.com',
      threadId: 't1',
      inReplyToMessageId: '<m@x>',
      signatureId: 'sig-1',
      attachments: [
        { filename: 'a.pdf', mimeType: 'application/pdf', filePath: '/outbox/a.pdf', size: 10 },
      ],
      classificationId: 'confidential',
      isEncrypted: true,
      isSigned: true,
      importance: 'high',
      requestReadReceipt: true,
      requestDeliveryReceipt: true,
      deliverAt: 1_900_000_000,
      preventCopy: true,
    });
  });

  it('normalizes a null body to an empty string and strips attachment extras', () => {
    const input = draftSessionToDraftInput(
      fullFields({
        bodyHtml: null,
        attachments: [
          {
            filename: 'b.txt',
            mimeType: 'text/plain',
            filePath: '/outbox/b.txt',
            size: 1,
            // UI-only extras must not reach the persisted row.
            ...({ id: 'chip-1', origin: 'picked' } as object),
          },
        ],
      }),
      'acc-1',
    );
    expect(input.bodyHtml).toBe('');
    expect(input.attachments?.[0]).toEqual({
      filename: 'b.txt',
      mimeType: 'text/plain',
      filePath: '/outbox/b.txt',
      size: 1,
    });
  });
});

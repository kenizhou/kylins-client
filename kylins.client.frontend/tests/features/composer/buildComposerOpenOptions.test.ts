import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildComposerOpenOptions } from '../../../src/features/composer/buildComposerOpenOptions';
import type { MailMessage } from '../../../src/features/view/viewStore';
import type { Account } from '../../../src/types';
import { wireDefaultDbResults } from '../../../src/test/mockInvoke';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

const { mockReadFile } = vi.hoisted(() => ({ mockReadFile: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: mockReadFile }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

const account: Account = {
  id: 'acc-1',
  email: 'me@example.com',
  displayName: 'Me',
  provider: 'imap',
  isActive: true,
  isDefault: true,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'm-local',
    subject: 'Hello',
    from: { name: 'Bob', address: 'bob@example.com' },
    to: [{ name: 'Me', address: 'me@example.com' }],
    cc: [{ name: 'Carol', address: 'carol@example.com' }],
    replyTo: [],
    date: new Date('2026-07-05T10:00:00Z').toISOString(),
    preview: 'preview',
    html: '<p>Original body</p>',
    text: 'Original body',
    threadId: 't1',
    messageId: '<mid-1@example.com>',
    classificationId: 'unclassified',
    isEncrypted: false,
    isSigned: false,
    ...overrides,
  };
}

describe('buildComposerOpenOptions', () => {
  it('reply: uses Reply-To header when present', async () => {
    const message = makeMessage({ replyTo: [{ name: 'Reply', address: 'reply@example.com' }] });
    const opts = await buildComposerOpenOptions({ account, message, mode: 'reply' });
    expect(opts.to).toEqual([{ name: 'Reply', email: 'reply@example.com' }]);
    expect(opts.subject).toBe('Re: Hello');
    expect(opts.bodyHtml).toContain('gmail_quote');
    expect(opts.inReplyToMessageId).toBe('<mid-1@example.com>');
    expect(opts.originalMessageId).toBeNull();
    expect(opts.includeOriginalAttachments).toBe(false);
  });

  it('reply: falls back to sender when no Reply-To', async () => {
    const message = makeMessage();
    const opts = await buildComposerOpenOptions({ account, message, mode: 'reply' });
    expect(opts.to).toEqual([{ name: 'Bob', email: 'bob@example.com' }]);
    expect(opts.cc).toBeUndefined();
  });

  it('reply-all: excludes own addresses', async () => {
    const message = makeMessage();
    const opts = await buildComposerOpenOptions({ account, message, mode: 'replyAll' });
    expect(opts.to).toEqual([{ name: 'Bob', email: 'bob@example.com' }]);
    expect(opts.cc).toEqual([{ name: 'Carol', email: 'carol@example.com' }]);
  });

  it('reply with attachments: seeds original attachments', async () => {
    const message = makeMessage();
    const opts = await buildComposerOpenOptions({
      account,
      message,
      mode: 'reply',
      includeOriginalAttachments: true,
    });
    expect(opts.originalMessageId).toBe('<mid-1@example.com>');
    expect(opts.includeOriginalAttachments).toBe(true);
  });

  it('forward: prefixes subject, quotes body, seeds attachments, replaces cid refs', async () => {
    // cachedImageToDataUrl reads the cached file; mock readFile to return
    // known bytes ([72, 73] = "HI" → base64 "SEk=").
    mockReadFile.mockResolvedValue(new Uint8Array([72, 73]));
    mockInvoke.mockImplementation(async (cmd: string, _args?: Record<string, unknown>) => {
      if (cmd === 'db_get_aliases_for_account') return [];
      if (cmd === 'sync_fetch_inline_images') {
        return [{ contentId: 'img-1', filePath: '/cache/img-1.png', mimeType: 'image/png', size: 2 }];
      }
      return wireDefaultDbResults.length ? undefined : undefined;
    });
    const message = makeMessage({
      html: '<p>See <img src="cid:img-1" /></p>',
    });
    const opts = await buildComposerOpenOptions({ account, message, mode: 'forward' });
    expect(opts.subject).toBe('Fwd: Hello');
    expect(opts.bodyHtml).toContain('gmail_quote');
    expect(opts.bodyHtml).toContain('data:image/png;base64,SEk=');
    expect(opts.originalMessageId).toBe('<mid-1@example.com>');
    expect(opts.includeOriginalAttachments).toBe(true);
    expect(opts.forwardAsAttachment).toBeUndefined();
  });

  it('forward as attachment: no quote, attaches original metadata', async () => {
    const message = makeMessage();
    const opts = await buildComposerOpenOptions({
      account,
      message,
      mode: 'forward',
      forwardAsAttachment: true,
    });
    expect(opts.bodyHtml).toBe('');
    expect(opts.forwardAsAttachment).toBe(true);
    expect(opts.includeOriginalAttachments).toBe(false);
    expect(opts.originalMessageSubject).toBe('Hello');
    expect(opts.originalMessageHtml).toBe('<p>Original body</p>');
    expect(opts.originalMessageText).toBe('Original body');
  });

  it('smart From resolves to the alias the message was addressed to', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_aliases_for_account') {
        return [
          {
            id: 'alias-1',
            account_id: 'acc-1',
            email: 'alias@example.com',
            display_name: 'Alias Name',
            reply_to_address: null,
            signature_id: null,
            is_primary: 0,
            is_default: 0,
            treat_as_alias: 1,
            verification_status: 'accepted',
            created_at: 1,
          },
        ];
      }
      return undefined;
    });
    const message = makeMessage({
      to: [{ name: 'Alias Name', address: 'alias@example.com' }],
    });
    const opts = await buildComposerOpenOptions({ account, message, mode: 'reply' });
    expect(opts.fromEmail).toBe('alias@example.com');
  });
});

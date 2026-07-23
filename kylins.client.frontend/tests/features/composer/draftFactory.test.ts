// Direct tests for the draftFactory seed builder — quote-style threading,
// skipBody (forward-as-attachment), forward CID baking, and smart-From.
// (Recipient/alias behavior is covered end-to-end in
// tests/stores/inlineComposerStore.test.ts.)

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

const { mockReadFile } = vi.hoisted(() => ({ mockReadFile: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: mockReadFile }));

const { mockFetchInlineImages } = vi.hoisted(() => ({ mockFetchInlineImages: vi.fn() }));
vi.mock('../../../src/services/db/attachments', () => ({
  getAttachments: vi.fn(async () => []),
  fetchAttachment: vi.fn(),
  fetchInlineImages: mockFetchInlineImages,
  cachedImageToDataUrl: vi.fn(async () => 'data:image/png;base64,SEk='),
}));

import { buildDraftSeed } from '../../../src/features/composer/draftFactory';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';
import type { MailMessage } from '../../../src/features/view/viewStore';

const account = { id: 'acc-1', email: 'me@example.com', displayName: 'Me' };

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
    classificationId: null,
    isEncrypted: false,
    isSigned: false,
    ...overrides,
  };
}

describe('buildDraftSeed', () => {
  beforeEach(() => {
    usePreferencesStore.setState({ quoteStyle: 'outlook' });
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_aliases_for_account') return [];
      return undefined;
    });
    mockFetchInlineImages.mockReset().mockResolvedValue([]);
  });

  it('defaults to the outlook quote style from the preferences store', async () => {
    const seed = await buildDraftSeed({ account, message: makeMessage(), intent: 'reply' });
    expect(seed.bodyHtml).toContain('<b>From:</b>');
    expect(seed.bodyHtml).toContain('data-quote="original"');
    expect(seed.bodyHtml).not.toContain('gmail_quote');
  });

  it('reads the gmail quote style from the preferences store', async () => {
    usePreferencesStore.setState({ quoteStyle: 'gmail' });
    const seed = await buildDraftSeed({ account, message: makeMessage(), intent: 'reply' });
    expect(seed.bodyHtml).toContain('gmail_quote');
    expect(seed.bodyHtml).toContain('wrote:');
  });

  it('an explicit quoteStyle param overrides the preference', async () => {
    const seed = await buildDraftSeed({
      account,
      message: makeMessage(),
      intent: 'reply',
      quoteStyle: 'gmail',
    });
    expect(seed.bodyHtml).toContain('gmail_quote');
  });

  it('skipBody returns an empty body and never fetches inline images', async () => {
    const seed = await buildDraftSeed({
      account,
      message: makeMessage(),
      intent: 'forward',
      skipBody: true,
    });
    expect(seed.bodyHtml).toBe('');
    expect(mockFetchInlineImages).not.toHaveBeenCalled();
  });

  it('forward bakes the CID map into bodyHtml and drops In-Reply-To', async () => {
    mockFetchInlineImages.mockResolvedValue([
      { contentId: 'img-1', filePath: '/cache/img-1.png', mimeType: 'image/png', size: 2 },
    ]);
    const seed = await buildDraftSeed({
      account,
      message: makeMessage({ html: '<p>See <img src="cid:img-1" /></p>' }),
      intent: 'forward',
    });
    expect(seed.bodyHtml).toContain('data:image/png;base64,SEk=');
    expect(seed.bodyHtml).toContain('Forwarded message');
    expect(seed.inReplyToMessageId).toBeNull();
    expect(seed.includeOriginalAttachments).toBe(true);
    expect(seed.subject).toBe('Fwd: Hello');
  });

  it('smart-From resolves to the alias the message was addressed to', async () => {
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
    const seed = await buildDraftSeed({
      account,
      message: makeMessage({ to: [{ name: 'Alias Name', address: 'alias@example.com' }] }),
      intent: 'reply',
    });
    expect(seed.fromEmail).toBe('alias@example.com');
    expect(seed.selfEmails).toEqual(['me@example.com', 'alias@example.com']);
  });
});

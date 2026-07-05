// Task 5 clean-cut: drafts.ts now routes through `invoke('db_*')` instead of
// getDb(). Mock invoke and assert the wrapper serializes recipients/attachments
// to JSON and forwards the right command + payload shape. The saveDraft
// upsert-vs-update branch (existingId present + row exists) is still exercised.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createDraft,
  updateDraft,
  saveDraft,
  deleteDraft,
  getDraft,
  type DraftInput,
} from '../../../src/services/composer/drafts';
import { wireDefaultDbResults } from '../../../src/test/mockInvoke';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

const baseInput: DraftInput = {
  accountId: 'acc-1',
  to: [{ name: 'alice@example.com', email: 'alice@example.com' }],
  cc: [{ name: 'bob@example.com', email: 'bob@example.com' }],
  bcc: [],
  subject: 'Hello',
  bodyHtml: '<p>Hi</p>',
  fromEmail: 'me@example.com',
  threadId: 'thread-1',
  inReplyToMessageId: '<orig@example.com>',
  signatureId: 'sig-1',
  // T7b: attachments are path-backed. No base64 `content` on the regular path.
  attachments: [
    {
      filename: 'a.txt',
      mimeType: 'text/plain',
      filePath: '/appdata/outbox-attachments/draft-1/a.txt',
      size: 1,
    },
  ],
};

describe('composer/drafts', () => {
  it('createDraft forwards a serialized payload and returns the new id', async () => {
    mockInvoke.mockResolvedValueOnce('draft-1');
    const id = await createDraft(baseInput);
    expect(id).toBe('draft-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_create_draft', {
      input: expect.objectContaining({
        accountId: 'acc-1',
        // Recipients are JSON-encoded RFC address strings.
        to: JSON.stringify(['alice@example.com']),
        cc: JSON.stringify(['bob@example.com']),
        bcc: null, // empty bcc → null (matches historical inputToColumns)
        attachments: JSON.stringify(baseInput.attachments),
      }),
    });
  });

  it('createDraft nulls out empty cc/attachments', async () => {
    mockInvoke.mockResolvedValueOnce('draft-2');
    await createDraft({ ...baseInput, cc: undefined, attachments: undefined });
    const payload = mockInvoke.mock.calls[0]![1] as { input: Record<string, unknown> };
    expect(payload.input.cc).toBeNull();
    expect(payload.input.attachments).toBeNull();
  });

  it('updateDraft forwards id + serialized payload', async () => {
    await updateDraft('draft-1', baseInput);
    expect(mockInvoke).toHaveBeenCalledWith('db_update_draft', {
      id: 'draft-1',
      input: expect.objectContaining({
        accountId: 'acc-1',
        to: JSON.stringify(['alice@example.com']),
      }),
    });
  });

  it('saveDraft updates when the existing id is present and the row exists', async () => {
    // getDraft returns a row → saveDraft calls updateDraft.
    mockInvoke.mockResolvedValueOnce({ id: 'draft-1', subject: 'Hello' }); // db_get_draft
    const id = await saveDraft(baseInput, 'draft-1');
    expect(id).toBe('draft-1');
    // Only one invoke call (the update); no create.
    expect(mockInvoke).toHaveBeenCalledTimes(2); // get_draft + update_draft
    expect(mockInvoke.mock.calls[1]![0]).toBe('db_update_draft');
  });

  it('saveDraft creates when the existing id is absent (row not found)', async () => {
    mockInvoke.mockResolvedValueOnce(null); // db_get_draft returns null
    mockInvoke.mockResolvedValueOnce('draft-new'); // db_create_draft
    const id = await saveDraft(baseInput, 'draft-missing');
    expect(id).toBe('draft-new');
    expect(mockInvoke.mock.calls[1]![0]).toBe('db_create_draft');
  });

  it('getDraft returns the row from db_get_draft', async () => {
    mockInvoke.mockResolvedValueOnce({ id: 'draft-1', subject: 'Hello' });
    const draft = await getDraft('draft-1');
    expect(draft).not.toBeNull();
    expect(draft!.id).toBe('draft-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_draft', { id: 'draft-1' });
  });

  it('deleteDraft forwards to db_delete_draft', async () => {
    await deleteDraft('draft-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_delete_draft', { id: 'draft-1' });
  });
});

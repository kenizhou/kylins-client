// Task 5 cutover: messageBodies.ts now routes through `invoke('db_*')`. Tests
// assert the wrapper forwards the right command + args and passes the Rust
// return value through. Rust returns the body row already shaped as the
// camelCase MessageBody interface.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getMessageBody, setMessageBody, evictBody } from '../../../src/services/db/messageBodies';
import { wireDefaultDbResults } from '../../../src/test/mockInvoke';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

describe('getMessageBody', () => {
  it('invokes db_get_message_body with (accountId, messageId)', async () => {
    mockInvoke.mockResolvedValueOnce({
      accountId: 'a1',
      messageId: 'm1',
      bodyHtml: '<p>h</p>',
      fetchedAt: 5,
    });
    const body = await getMessageBody('a1', 'm1');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_message_body', {
      accountId: 'a1',
      messageId: 'm1',
    });
    expect(body?.bodyHtml).toBe('<p>h</p>');
    expect(body?.fetchedAt).toBe(5);
  });

  it('returns null when absent', async () => {
    mockInvoke.mockResolvedValueOnce(null);
    expect(await getMessageBody('a1', 'm1')).toBeNull();
  });
});

describe('setMessageBody', () => {
  it('invokes db_set_message_body with (accountId, messageId, bodyHtml)', async () => {
    await setMessageBody('a1', 'm1', '<p>h</p>');
    expect(mockInvoke).toHaveBeenCalledWith('db_set_message_body', {
      accountId: 'a1',
      messageId: 'm1',
      bodyHtml: '<p>h</p>',
    });
  });
});

describe('evictBody', () => {
  it('invokes db_evict_body with (accountId, messageId)', async () => {
    await evictBody('a1', 'm1');
    expect(mockInvoke).toHaveBeenCalledWith('db_evict_body', {
      accountId: 'a1',
      messageId: 'm1',
    });
  });
});

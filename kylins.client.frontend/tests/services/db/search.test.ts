// Task 5 clean-cut: search.ts now routes through `invoke('db_search_messages')`
// instead of getDb(). Mock invoke and assert the wrapper forwards the right
// command + args and passes the Rust return value through unchanged.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { searchMessages } from '../../../src/services/db/search';
import { wireDefaultDbResults } from '../../../src/test/mockInvoke';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

describe('searchMessages', () => {
  it('returns [] for an empty query without invoking', async () => {
    // Empty-query guard is TS-side (matches the historical early return); it
    // must short-circuit before invoke.
    expect(await searchMessages('a1', '   ')).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('forwards to db_search_messages with accountId, query, limit', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        id: 'm1',
        threadId: 't1',
        subject: 'S',
        fromName: 'Bob',
        fromAddress: 'b@x.com',
        date: 100,
        preview: 'a <mark>match</mark> here',
        rank: -1,
      },
    ]);
    const results = await searchMessages('a1', 'match');
    expect(mockInvoke).toHaveBeenCalledWith('db_search_messages', {
      accountId: 'a1',
      query: 'match',
      limit: 50,
    });
    expect(results[0]!.preview).toContain('<mark>');
  });

  it('passes a custom limit through', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await searchMessages('a1', 'match', 10);
    expect(mockInvoke).toHaveBeenCalledWith('db_search_messages', {
      accountId: 'a1',
      query: 'match',
      limit: 10,
    });
  });
});

// Wrapper test for `services/db/messages.ts`. Mirrors the cutover pattern in
// `messageBodies.test.ts`: hoisted `vi.mock` replaces `invoke`, then each
// test asserts the wrapper forwards the right command + args and passes the
// Rust return value through untouched.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getUncachedBodyMessageIds } from '../../../src/services/db/messages';
import { wireDefaultDbResults } from '../../../src/test/mockInvoke';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

describe('getUncachedBodyMessageIds', () => {
  it('invokes db_get_uncached_body_message_ids with (accountId, messageIds)', async () => {
    mockInvoke.mockResolvedValueOnce(['m2', 'm3']);
    const out = await getUncachedBodyMessageIds('a1', ['m1', 'm2', 'm3']);
    expect(mockInvoke).toHaveBeenCalledWith('db_get_uncached_body_message_ids', {
      accountId: 'a1',
      messageIds: ['m1', 'm2', 'm3'],
    });
    expect(out).toEqual(['m2', 'm3']);
  });

  it('returns an empty array when Rust returns one (all cached / all missing)', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    const out = await getUncachedBodyMessageIds('a1', ['m1']);
    expect(out).toEqual([]);
  });

  it('forwards an empty input list verbatim (no client-side short-circuit)', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await getUncachedBodyMessageIds('a1', []);
    // The Rust side short-circuits empty input; the wrapper must still forward
    // the call so the contract is uniform.
    expect(mockInvoke).toHaveBeenCalledWith('db_get_uncached_body_message_ids', {
      accountId: 'a1',
      messageIds: [],
    });
  });
});

// Task 5 cutover: OfflineQueue methods now route through `invoke('db_*')`.
// The backoff SQL lives Rust-side (db::queue::mark_failed) and is unit-tested
// there with a real sqlite DB; these frontend tests assert the wrapper forwards
// the right command + args and reshapes the return value (params JSON-parsed
// back into a record on dequeue).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OfflineQueue } from '../../../src/services/queue/offlineQueue';
import { wireDefaultDbResults } from '../../../src/test/mockInvoke';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

describe('OfflineQueue', () => {
  it('enqueues an operation via db_enqueue_op with JSON-stringified params', async () => {
    const queue = new OfflineQueue();
    await queue.enqueue({
      accountId: 'acc-1',
      operationType: 'archive',
      resourceId: 'thread-1',
      params: { foo: 'bar' },
    });
    expect(mockInvoke).toHaveBeenCalledWith('db_enqueue_op', {
      accountId: 'acc-1',
      operationType: 'archive',
      resourceId: 'thread-1',
      params: '{"foo":"bar"}',
    });
  });

  it('dequeuePending invokes db_dequeue_pending with limit and parses params JSON', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        id: 'op-1',
        accountId: 'acc-1',
        operationType: 'archive',
        resourceId: 'thread-1',
        params: '{"foo":"bar"}',
      },
    ]);
    const queue = new OfflineQueue();
    const ops = await queue.dequeuePending(25);
    expect(mockInvoke).toHaveBeenCalledWith('db_dequeue_pending', { limit: 25 });
    expect(ops).toHaveLength(1);
    expect(ops[0]!.id).toBe('op-1');
    expect(ops[0]!.params).toEqual({ foo: 'bar' });
  });

  it('dequeuePending defaults limit to 50 when omitted', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    const queue = new OfflineQueue();
    await queue.dequeuePending();
    expect(mockInvoke).toHaveBeenCalledWith('db_dequeue_pending', { limit: 50 });
  });

  it('markCompleted invokes db_mark_op_completed with id', async () => {
    const queue = new OfflineQueue();
    await queue.markCompleted('op-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_mark_op_completed', { id: 'op-1' });
  });

  it('markFailed invokes db_mark_op_failed with (id, error)', async () => {
    const queue = new OfflineQueue();
    await queue.markFailed('op-1', 'network down');
    expect(mockInvoke).toHaveBeenCalledWith('db_mark_op_failed', {
      id: 'op-1',
      error: 'network down',
    });
  });
});

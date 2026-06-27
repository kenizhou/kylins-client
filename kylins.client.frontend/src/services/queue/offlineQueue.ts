// Task 5 (Option C) cutover: this module no longer touches plugin-sql. Each
// method delegates to a Rust `db_*` command (see
// `kylins.client.backend/src/db/commands.rs` + `db/queue.rs`). The SQL is
// reproduced verbatim Rust-side, including the load-bearing pre-increment
// backoff semantics of `mark_failed` (see the Rust module docstring).

import { invoke } from '@tauri-apps/api/core';

export interface PendingOperation {
  id?: string;
  accountId: string;
  operationType: string;
  resourceId: string;
  params: Record<string, unknown>;
}

/** Raw shape of a pending_operations row as returned by Rust (camelCase). */
interface PendingOperationRow {
  id: string;
  accountId: string;
  operationType: string;
  resourceId: string;
  /** Serialized JSON; parsed back into the `params` record below. */
  params: string;
}

export class OfflineQueue {
  async enqueue(op: PendingOperation): Promise<void> {
    // Rust generates the id server-side (uuid v4) when none is supplied; the
    // TS `op.id` field is now informational only and is not forwarded.
    await invoke<void>('db_enqueue_op', {
      accountId: op.accountId,
      operationType: op.operationType,
      resourceId: op.resourceId,
      params: JSON.stringify(op.params),
    });
  }

  async dequeuePending(limit = 50): Promise<PendingOperation[]> {
    const rows = await invoke<PendingOperationRow[]>('db_dequeue_pending', { limit });
    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      operationType: r.operationType,
      resourceId: r.resourceId,
      params: JSON.parse(r.params),
    }));
  }

  async markCompleted(id: string): Promise<void> {
    await invoke<void>('db_mark_op_completed', { id });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await invoke<void>('db_mark_op_failed', { id, error });
  }
}

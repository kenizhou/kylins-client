import { getDb } from '../db/connection';

export interface PendingOperation {
  id?: string;
  accountId: string;
  operationType: string;
  resourceId: string;
  params: Record<string, unknown>;
}

export class OfflineQueue {
  async enqueue(op: PendingOperation): Promise<void> {
    const db = await getDb();
    const id = op.id ?? crypto.randomUUID();
    await db.execute(
      `INSERT INTO pending_operations
       (id, account_id, operation_type, resource_id, params, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', unixepoch())`,
      [id, op.accountId, op.operationType, op.resourceId, JSON.stringify(op.params)],
    );
  }

  async dequeuePending(limit = 50): Promise<PendingOperation[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      `SELECT * FROM pending_operations
       WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= unixepoch())
       ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      operationType: r.operation_type,
      resourceId: r.resource_id,
      params: JSON.parse(r.params),
    }));
  }

  async markCompleted(id: string): Promise<void> {
    const db = await getDb();
    await db.execute('DELETE FROM pending_operations WHERE id = $1', [id]);
  }

  async markFailed(id: string, error: string): Promise<void> {
    const db = await getDb();
    await db.execute(
      `UPDATE pending_operations
       SET retry_count = retry_count + 1,
           next_retry_at = unixepoch() + (60 * (1 << retry_count)),
           error_message = $2,
           status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE 'pending' END
       WHERE id = $1`,
      [id, error],
    );
  }
}

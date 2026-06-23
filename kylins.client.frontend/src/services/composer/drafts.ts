// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Local-first draft persistence over the `local_drafts` table (migration v17).
// velo stores drafts server-side via the provider (Gmail API); Kylins persists
// the editable draft locally first and reserves `remote_draft_id` for future
// server-side draft sync. Raw MIME is built only at send time (see send.ts).

import { getDb, buildDynamicUpdate, selectFirstBy } from '@/services/db/connection';
import { getCurrentUnixTimestamp } from '@/utils/timestamp';

/**
 * Serializable attachment shape stored in `local_drafts.attachments` as JSON.
 * The live composer attachment (`ComposerAttachment`) also carries a `File`
 * handle which is not JSON-serializable, so it is dropped at the boundary.
 */
export interface StoredAttachment {
  filename: string;
  mimeType: string;
  content: string; // base64
  size: number;
}

/** Editable draft fields, matching the composer store shape. */
export interface DraftInput {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  fromEmail?: string | null;
  threadId?: string | null;
  inReplyToMessageId?: string | null;
  signatureId?: string | null;
  attachments?: StoredAttachment[];
}

/** Raw `local_drafts` row. Array/attachment columns are JSON-encoded strings. */
export interface DbDraft {
  id: string;
  account_id: string;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  subject: string | null;
  body_html: string | null;
  reply_to_message_id: string | null;
  thread_id: string | null;
  from_email: string | null;
  signature_id: string | null;
  remote_draft_id: string | null;
  attachments: string | null;
  created_at: number;
  updated_at: number;
  sync_status: string;
}

/** Map a DraftInput to [column, value] tuples for UPDATE SET clauses. */
function inputToColumns(input: DraftInput): [string, unknown][] {
  return [
    ['to_addresses', JSON.stringify(input.to ?? [])],
    ['cc_addresses', input.cc && input.cc.length > 0 ? JSON.stringify(input.cc) : null],
    ['bcc_addresses', input.bcc && input.bcc.length > 0 ? JSON.stringify(input.bcc) : null],
    ['subject', input.subject ?? ''],
    ['body_html', input.bodyHtml ?? ''],
    ['from_email', input.fromEmail ?? null],
    ['thread_id', input.threadId ?? null],
    ['reply_to_message_id', input.inReplyToMessageId ?? null],
    ['signature_id', input.signatureId ?? null],
    [
      'attachments',
      input.attachments && input.attachments.length > 0 ? JSON.stringify(input.attachments) : null,
    ],
  ];
}

export async function createDraft(input: DraftInput): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  // Reuse inputToColumns — single source of truth for the DraftInput→column map.
  const cols: [string, unknown][] = [['account_id', input.accountId], ...inputToColumns(input)];
  const colNames = ['id', ...cols.map(([c]) => c)].join(', ');
  const placeholders = cols.map((_, i) => `$${i + 2}`).join(', '); // $1 = id
  const params: unknown[] = [id, ...cols.map(([, v]) => v)];
  await db.execute(
    `INSERT INTO local_drafts (${colNames}, sync_status) VALUES ($1, ${placeholders}, 'pending')`,
    params,
  );
  return id;
}

export async function updateDraft(id: string, input: DraftInput): Promise<void> {
  const db = await getDb();
  const fields: [string, unknown][] = [
    ...inputToColumns(input),
    ['updated_at', getCurrentUnixTimestamp()],
  ];
  const query = buildDynamicUpdate('local_drafts', 'id', id, fields);
  if (query) {
    await db.execute(query.sql, query.params);
  }
}

/**
 * Create or update a draft. If `existingId` refers to an existing row, update
 * it in place; otherwise insert a new row. Returns the persisted draft id.
 */
export async function saveDraft(input: DraftInput, existingId?: string | null): Promise<string> {
  if (existingId) {
    const existing = await getDraft(existingId);
    if (existing) {
      await updateDraft(existingId, input);
      return existingId;
    }
  }
  return createDraft(input);
}

export async function deleteDraft(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM local_drafts WHERE id = $1', [id]);
}

export async function getDraft(id: string): Promise<DbDraft | null> {
  return selectFirstBy<DbDraft>('SELECT * FROM local_drafts WHERE id = $1', [id]);
}

export async function listDraftsForAccount(accountId: string): Promise<DbDraft[]> {
  const db = await getDb();
  return db.select<DbDraft[]>(
    'SELECT * FROM local_drafts WHERE account_id = $1 ORDER BY updated_at DESC',
    [accountId],
  );
}

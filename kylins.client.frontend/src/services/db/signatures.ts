// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.

import { getDb, buildDynamicUpdate, boolToInt } from './connection';

export type SignatureContext = 'all' | 'new' | 'reply' | 'forward';

export interface DbSignature {
  id: string;
  account_id: string;
  name: string;
  body_html: string;
  is_default: number;
  sort_order: number;
  context: SignatureContext;
}

export const SIGNATURE_CONTEXTS: SignatureContext[] = ['all', 'new', 'reply', 'forward'];

export async function getSignaturesForAccount(accountId: string): Promise<DbSignature[]> {
  const db = await getDb();
  return db.select<DbSignature[]>(
    'SELECT * FROM signatures WHERE account_id = $1 ORDER BY sort_order, created_at',
    [accountId],
  );
}

export async function getDefaultSignature(
  accountId: string,
  context?: SignatureContext,
): Promise<DbSignature | null> {
  const requestedContext = context ?? 'all';
  const db = await getDb();
  const rows = await db.select<DbSignature[]>(
    `SELECT * FROM signatures
     WHERE account_id = $1 AND is_default = 1
       AND (context = $2 OR context = 'all')
     ORDER BY CASE WHEN context = $2 THEN 0 ELSE 1 END
     LIMIT 1`,
    [accountId, requestedContext],
  );
  return rows[0] ?? null;
}

export async function insertSignature(sig: {
  accountId: string;
  name: string;
  bodyHtml: string;
  isDefault: boolean;
  context?: SignatureContext;
}): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const context = sig.context ?? 'all';

  if (sig.isDefault) {
    await db.execute(
      'UPDATE signatures SET is_default = 0 WHERE account_id = $1 AND context = $2',
      [sig.accountId, context],
    );
  }

  await db.execute(
    'INSERT INTO signatures (id, account_id, name, body_html, is_default, context) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, sig.accountId, sig.name, sig.bodyHtml, boolToInt(sig.isDefault), context],
  );
  return id;
}

export async function updateSignature(
  id: string,
  updates: { name?: string; bodyHtml?: string; isDefault?: boolean; context?: SignatureContext },
): Promise<void> {
  const db = await getDb();

  if (updates.isDefault || updates.context !== undefined) {
    // Determine the account and the effective context for default scoping.
    const rows = await db.select<{ account_id: string; context: SignatureContext }[]>(
      'SELECT account_id, context FROM signatures WHERE id = $1',
      [id],
    );
    if (rows[0]) {
      const context = updates.context ?? rows[0].context;
      await db.execute(
        'UPDATE signatures SET is_default = 0 WHERE account_id = $1 AND context = $2',
        [rows[0].account_id, context],
      );
    }
  }

  const fields: [string, unknown][] = [];
  if (updates.name !== undefined) fields.push(['name', updates.name]);
  if (updates.bodyHtml !== undefined) fields.push(['body_html', updates.bodyHtml]);
  if (updates.isDefault !== undefined) fields.push(['is_default', boolToInt(updates.isDefault)]);
  if (updates.context !== undefined) fields.push(['context', updates.context]);

  const query = buildDynamicUpdate('signatures', 'id', id, fields);
  if (query) {
    await db.execute(query.sql, query.params);
  }
}

export async function deleteSignature(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM signatures WHERE id = $1', [id]);
}

export function isSignatureContext(value: string): value is SignatureContext {
  return SIGNATURE_CONTEXTS.includes(value as SignatureContext);
}

export function signatureContextForComposerMode(mode: 'new' | 'reply' | 'replyAll' | 'forward'): SignatureContext {
  switch (mode) {
    case 'new':
      return 'new';
    case 'reply':
    case 'replyAll':
      return 'reply';
    case 'forward':
      return 'forward';
    default:
      return 'all';
  }
}

export const CONTEXT_LABELS: Record<SignatureContext, string> = {
  all: 'All',
  new: 'New',
  reply: 'Reply',
  forward: 'Forward',
};

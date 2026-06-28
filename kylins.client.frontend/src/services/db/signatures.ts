// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Task 5 (Option C) clean-cut cutover: every function delegates to a Rust
// `db_*` Tauri command (see `kylins.client.backend/src/db/signatures.rs`). Rust
// owns the `signatures` table and returns rows matching the TS `DbSignature`
// shape (snake_case keys, matching the historical interface). The pure TS
// helpers (`isSignatureContext`, `signatureContextForComposerMode`, the
// `SIGNATURE_CONTEXTS` / `CONTEXT_LABELS` constants) stay here — they have no
// SQL and are imported by the composer/preferences UI.

import { invoke } from '@tauri-apps/api/core';

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
  return invoke<DbSignature[]>('db_get_signatures_for_account', { accountId });
}

export async function getDefaultSignature(
  accountId: string,
  context?: SignatureContext,
): Promise<DbSignature | null> {
  return invoke<DbSignature | null>('db_get_default_signature', {
    accountId,
    context: context ?? null,
  });
}

export async function insertSignature(sig: {
  accountId: string;
  name: string;
  bodyHtml: string;
  isDefault: boolean;
  context?: SignatureContext;
}): Promise<string> {
  return invoke<string>('db_insert_signature', {
    input: {
      accountId: sig.accountId,
      name: sig.name,
      bodyHtml: sig.bodyHtml,
      isDefault: sig.isDefault,
      context: sig.context ?? null,
    },
  });
}

export async function updateSignature(
  id: string,
  updates: { name?: string; bodyHtml?: string; isDefault?: boolean; context?: SignatureContext },
): Promise<void> {
  // Rust distinguishes "field absent" from "field present" via Option; we only
  // forward keys that are actually set on the TS side (matching the historical
  // buildDynamicUpdate behavior).
  const payload: Record<string, unknown> = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.bodyHtml !== undefined) payload.bodyHtml = updates.bodyHtml;
  if (updates.isDefault !== undefined) payload.isDefault = updates.isDefault;
  if (updates.context !== undefined) payload.context = updates.context;
  await invoke<void>('db_update_signature', { id, updates: payload });
}

export async function deleteSignature(id: string): Promise<void> {
  await invoke<void>('db_delete_signature', { id });
}

export function isSignatureContext(value: string): value is SignatureContext {
  return SIGNATURE_CONTEXTS.includes(value as SignatureContext);
}

export function signatureContextForComposerMode(
  mode: 'new' | 'reply' | 'replyAll' | 'forward',
): SignatureContext {
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

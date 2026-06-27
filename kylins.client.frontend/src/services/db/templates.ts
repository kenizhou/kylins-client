// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Task 5 (Option C) clean-cut cutover: every function delegates to a Rust
// `db_*` Tauri command (see `kylins.client.backend/src/db/templates.rs`).

import { invoke } from '@tauri-apps/api/core';

export interface DbTemplate {
  id: string;
  account_id: string | null;
  name: string;
  subject: string | null;
  body_html: string;
  shortcut: string | null;
  sort_order: number;
  created_at: number;
}

/**
 * Get all templates for an account (includes global templates where account_id IS NULL).
 */
export async function getTemplatesForAccount(accountId: string): Promise<DbTemplate[]> {
  return invoke<DbTemplate[]>('db_get_templates_for_account', { accountId });
}

export async function insertTemplate(tmpl: {
  accountId: string | null;
  name: string;
  subject: string | null;
  bodyHtml: string;
  shortcut: string | null;
}): Promise<string> {
  return invoke<string>('db_insert_template', { tmpl });
}

export async function updateTemplate(
  id: string,
  updates: { name?: string; subject?: string | null; bodyHtml?: string; shortcut?: string | null },
): Promise<void> {
  // Only forward keys that are actually set (matches historical buildDynamicUpdate).
  const payload: Record<string, unknown> = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.subject !== undefined) payload.subject = updates.subject;
  if (updates.bodyHtml !== undefined) payload.bodyHtml = updates.bodyHtml;
  if (updates.shortcut !== undefined) payload.shortcut = updates.shortcut;
  await invoke<void>('db_update_template', { id, updates: payload });
}

export async function deleteTemplate(id: string): Promise<void> {
  await invoke<void>('db_delete_template', { id });
}

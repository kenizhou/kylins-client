// Composer-scoped send orchestration for Kylins Client.
//
// Sends are routed through the Rust sync engine via the `sync_apply_mutation`
// Tauri command. The engine applies locally (a no-op for Send — there is no
// message row yet) and enqueues a single `send:{uuid}` pending row that the
// replay worker transmits via `MailSource::send` (SMTP for IMAP-style accounts,
// EAS SendMail for Exchange) with exponential backoff. The invoke resolving
// means "queued for send"; the UI treats that as success.
//
// Send-flow hardening (T7+T7b): the IPC payload is `{ type: 'send', draft }`
// where `draft: SendDraft` is a structured object. The backend builds the
// RFC5322 MIME bytes from it (Stalwart `mail-builder`) — no base64 crosses
// IPC for attachments/inline images; they are file paths under
// `<appData>/outbox-attachments/{stagingDraftId}/`. See `buildSendDraft`.

import { invoke } from '@tauri-apps/api/core';
import type { DraftInput } from './drafts';
import { buildSendDraft } from './buildSendDraft';
import { newDraftId } from './attachments';
import { useAccountStore } from '@/stores/accountStore';
import { upsertContact } from '@/services/db/contacts';
import { getSettingBool } from '@/services/settings';
import { SETTING_KEYS } from '@/services/settingsKeys';

export interface SendResult {
  success: boolean;
  message: string;
}

/** Dispatched on a successful send so the UI can refresh the Sent folder. */
export const SEND_COMPLETE_EVENT = 'mail:send-complete';

/**
 * Send a draft. Builds a structured `SendDraft` (file-backed attachments +
 * inline images + extra headers), then enqueues it through the sync engine
 * via `sync_apply_mutation` (`{ type: 'send', draft }`). The engine owns the
 * actual transport + retry; this function treats the invoke resolve as
 * "queued/sent" and dispatches {@link SEND_COMPLETE_EVENT}.
 *
 * T7b: the caller is responsible for deleting the persisted `local_drafts`
 * row on success (the composer owns the draft-row lifecycle and the row id
 * is distinct from `stagingDraftId`). On invoke failure, this function
 * returns a structured `success: false` result — the engine does NOT
 * auto-retry a failed enqueue, so the user can retry explicitly.
 *
 * `stagingDraftId` is used as the on-disk outbox folder name AND
 * `SendDraft.draftId` (the T8 backend cleanup target). When omitted, a fresh
 * `newDraftId()` is generated so attachment files still land under a stable
 * per-send directory. The composer should always pass its
 * `state.stagingDraftId` so pick-time staging and send-time `SendDraft.draftId`
 * agree.
 */
export async function sendEmail(
  accountId: string,
  input: DraftInput,
  stagingDraftId?: string | null,
): Promise<SendResult> {
  const account = useAccountStore.getState().accounts.find((a) => a.id === accountId);
  if (!account) {
    return { success: false, message: `No account found for id ${accountId}` };
  }

  const sendDraftId = stagingDraftId ?? newDraftId();
  const draft = await buildSendDraft(input, sendDraftId, account.email);

  try {
    await invoke('sync_apply_mutation', {
      accountId,
      op: { type: 'send', draft },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message };
  }

  // Record every outgoing recipient in the contacts DB immediately so they
  // appear in autocomplete before the Sent folder syncs back.
  const autoExtract = await getSettingBool(SETTING_KEYS.autoExtractContactsFromMail);
  if (autoExtract !== false) {
    const allRecipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];
    for (const recipient of allRecipients) {
      if (!recipient.email) continue;
      const displayName = recipient.name !== recipient.email ? recipient.name : null;
      upsertContact(recipient.email, displayName).catch(() => {
        // Best-effort; do not block the send flow on contact write failures.
      });
    }
  }

  window.dispatchEvent(new Event(SEND_COMPLETE_EVENT));
  return { success: true, message: 'Queued for send' };
}

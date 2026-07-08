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
import { emit } from '@tauri-apps/api/event';
import type { DraftInput } from './drafts';
import { buildSendDraft } from './buildSendDraft';
import { newDraftId } from './attachments';
import { useAccountStore } from '@/stores/accountStore';
import { useUIStore } from '@/stores/uiStore';
import { upsertContact } from '@/services/db/contacts';
import { getSettingBool } from '@/services/settings';
import { SETTING_KEYS } from '@/services/settingsKeys';

export interface SendResult {
  success: boolean;
  message: string;
}

/**
 * Dispatched as a `CustomEvent` on a successful send so the UI can refresh
 * the Sent folder. The `detail` carries `{ accountId }` so a listener can
 * nudge that account's sync. See `useSyncEvents` for the subscriber.
 */
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
  console.log('[send-fe] sendEmail ENTER accountId=', accountId);
  const account = useAccountStore.getState().accounts.find((a) => a.id === accountId);
  if (!account) {
    console.error('[send-fe] sendEmail ABORT no account for accountId=', accountId);
    return { success: false, message: `No account found for id ${accountId}` };
  }
  console.log('[send-fe] sendEmail account resolved email=', account.email);

  const setProgress = useUIStore.getState().setSendProgress;
  setProgress({ active: true, message: 'Sending…' });

  const sendDraftId = stagingDraftId ?? newDraftId();
  console.log('[send-fe] sendEmail buildSendDraft start sendDraftId=', sendDraftId);
  let draft;
  try {
    draft = await buildSendDraft(
      input,
      sendDraftId,
      account.email,
      account.displayName ?? undefined,
    );
  } catch (err) {
    // Preserve original behavior: buildSendDraft failures reject the whole
    // sendEmail promise (the composer's handleSend catch surfaces a toast).
    // We only log here; no structured-failure conversion.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[send-fe] sendEmail buildSendDraft THREW (re-throwing):', message);
    setProgress({ active: false });
    throw err;
  }
  console.log(
    '[send-fe] sendEmail buildSendDraft OK draft keys=',
    Object.keys(draft),
    'attachments=',
    draft.attachments?.length ?? 0,
  );

  // Only log the payload shape (keys), never the whole draft — it can carry
  // file paths + large bodies we don't want on the console.
  const payload = { accountId, op: { type: 'send', draft } };
  console.log(
    '[send-fe] sendEmail invoke sync_apply_mutation payload keys=',
    Object.keys(payload),
    'op.type=',
    (payload.op as { type: string }).type,
  );
  try {
    await invoke('sync_apply_mutation', payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setProgress({ active: false });
    // Surface failure via console for debugging; the caller (composer) owns
    // the user-facing toast so we don't double-toast on this path.
    console.error('[send-fe] sendEmail invoke REJECTED:', message);
    return { success: false, message };
  }
  console.log('[send-fe] sendEmail invoke RESOLVED (queued)');

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

  // Leave sendProgress ACTIVE — the invoke resolving only means "queued", not
  // "sent". The SMTP/EAS transport fires asynchronously in the backend replay
  // worker; the `sync:send-result` Tauri event (emitted from send_op after
  // src.send) clears the spinner + surfaces the Sent/Failed toast. Pre-send
  // failures (buildSendDraft throw / invoke reject, handled above) still clear
  // sendProgress, since nothing is in flight in those cases.
  // Carry the accountId so listeners can nudge that account's sync (the
  // appended Sent copy appears without waiting for the next poll round).
  // Emit a TAURI app-level event (not a window-scoped CustomEvent) so the
  // listener in useSyncEvents — which lives in the MAIN window — hears it
  // even when the send originated from the compose popout (which closes
  // immediately on success). Best-effort fire-and-forget; the next poll round
  // still picks up the Sent copy if this fails.
  console.log('[send-fe] sendEmail emitting SEND_COMPLETE_EVENT accountId=', accountId);
  void emit(SEND_COMPLETE_EVENT, { accountId }).catch(() => {});
  console.log('[send-fe] sendEmail RETURN success (queued for send)');
  return { success: true, message: 'Queued for send' };
}

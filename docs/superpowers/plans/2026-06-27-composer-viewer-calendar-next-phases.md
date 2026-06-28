# Plan: Next Phases for Composer / Viewer / Calendar

**Date:** 2026-06-27  
**Status:** Draft — pending approval  
**Scope:** Close the highest-value gaps in Kylins Client's composer, email reading pane, and calendar after the foundation work already completed in Phases 0–6.

---

## Context

The frontend has a rich composer foundation (TipTap editor, send/draft/auto-save, reply/forward quoting, signatures, templates, schedule send) and a working calendar data core (ical.js seam, recurrence expansion, month/week/day/agenda views, EAS calendar TS wrapper). However, the **reading pane is still a single-message renderer** without attachments, thread view, or sender context, and **calendar sync is blocked on Rust stubs and a schema mismatch**. The Rust DB backend already owns the sync-critical tables, so these frontend improvements must consume the `db_*` command layer rather than `@tauri-apps/plugin-sql`.

This plan focuses on three milestones that deliver the most user value before tackling larger greenfield work such as Graph/Gmail calendar sync or advanced drag-and-drop scheduling.

---

## Goals

1. Make the reading pane fully usable: attachments, conversation threading, contact sidebar, and image allowlist.
2. Unblock calendar sync: fix the `calendar_events` schema, implement EAS calendar `eas_sync` return data, and add the `eas_meeting_response` Rust command.
3. Close the most glaring composer gaps: forward re-attach, plain-text mode, send-and-archive, and offline queue processing.

## Non-goals

- Native Graph/Google Calendar sync providers (greenfield; defer until EAS calendar works end-to-end).
- Time-grid overlap packing and drag/resize in calendar week/day views (UX polish; can follow Phase 2).
- Full calendar search UI using `events_fts` (schema exists but no query layer yet).
- AI-powered composer features.

---

## Key Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Attachment source** | Read from the existing `attachments` DB table directly, not from `MailMessage.attachments` | `MailMessage.attachments` is not populated by providers yet; the `attachments` table already exists and is populated by IMAP sync. |
| **Thread view** | Show conversation cards oldest→newest inside `ReadingPane`, not a separate window | Matches Outlook behavior and reuses existing `getMessagesForThread` data. |
| **Per-message zoom** | Local state in `ReadingPane` / `MessageItem`, not global `uiStore` | Allows different zoom per message and avoids surprising global changes. |
| **Calendar schema fix** | Make `calendar_events.google_event_id` nullable; add `UNIQUE(account_id, uid)` | EAS/CalDAV/local events have no Google event ID; `uid` is the portable key. |
| **EAS calendar sync** | Extend existing `eas_sync` command to return parsed calendar items; reuse `easCalendarProvider.ts` | Avoids adding a new command; the TS wrapper is already written. |
| **RSVP in viewer** | `RsvpCard` component rendered by `ReadingPane` when a `text/calendar` invite is detected; uses `rsvpTask.ts` + `send.ts` to send the iMIP reply | Keeps invite handling next to the message being read. |
| **Offline queue** | Frontend worker polling `pending_operations` via `navigator.onLine` + `setInterval` | Simplest desktop approach; Rust-side timer can be added later. |

---

## Current State to Build On

### Already complete

- `EmailRenderer.tsx` sandboxed iframe renderer with sanitization, remote-image blocking, tracker stripping, phishing gating.
- `ReadingPane.tsx` single-message layout with reply/forward/archive/delete toolbar and `InlineReply`.
- `services/db/threads.ts` and `services/db/messageBodies.ts` delegating to Rust `db_*` commands.
- `services/calendar/icalHelper.ts`, `recurrenceExpander.ts`, `calendarStore.ts`, `services/db/calendarEvents.ts`.
- `services/calendar/easCalendarProvider.ts` and `rsvpTask.ts` (TS layers correct, runtime-blocked on Rust).
- `services/composer/send.ts`, `emailBuilder.ts`, `drafts.ts`, `draftAutoSave.ts`, `composerStore.ts`.
- Rust `db_get_folder_by_role`, `db_get_messages_for_thread`, `db_get_message_body` commands.

### Known blockers

- `MailMessage.attachments` is not populated by providers.
- `eas_sync` returns empty; `eas_meeting_response` command is not registered in Rust.
- `calendar_events.google_event_id` is `NOT NULL`, forcing non-Google providers to insert fake values.
- `ReadingPane` hardcodes `senderAllowlisted={false}`.

---

## Phase 1 — Reading Pane MVP

**Goal:** Transform the reading pane from a single-message renderer into a functional email viewer.

### 1.1 Attachment list

**New files:**
- `kylins.client.frontend/src/features/viewer/AttachmentList.tsx`
- `kylins.client.frontend/src/services/db/attachments.ts`

**Changes:**
- `attachments.ts`: query `attachments` table by `message_id` through a new `db_get_attachments_for_message` Rust command (or reuse existing query layer if available).
- `AttachmentList.tsx`: render filename, mime type, size; click downloads via `imap_fetch_attachment` / `eas_item_operations` and opens via Tauri opener.
- `ReadingPane.tsx`: render `AttachmentList` when attachments exist.

### 1.2 Thread / conversation view

**New files:**
- `kylins.client.frontend/src/features/viewer/ThreadView.tsx`
- `kylins.client.frontend/src/features/viewer/MessageItem.tsx`

**Changes:**
- `ReadingPane.tsx`: when `viewStore.conversationView` is true, render `ThreadView` with all messages from `getMessagesForThread`.
- `MessageItem.tsx`: collapsible message card with sender, recipients, date, actions (reply/forward), and `EmailRenderer`.
- Keep single-message mode as default for users who disable conversation view.

### 1.3 Contact sidebar

**New file:**
- `kylins.client.frontend/src/features/viewer/ContactSidebar.tsx`

**Changes:**
- `ReadingPane.tsx`: add toggle to show sender contact card.
- `ContactSidebar.tsx`: show sender avatar/initials, email, and recent threads from the same sender (query `services/db/threads.ts` by sender email).

### 1.4 Image allowlist wiring

**Changes:**
- `ReadingPane.tsx`: check `imageAllowlist.isAllowlisted(accountId, senderEmail)` and pass the real result to `EmailRenderer` instead of `false`.
- Add "Always show images from this sender" action.

### 1.5 Inline reply pop-out button

**Changes:**
- `InlineReply.tsx`: add a pop-out button in the inline composer toolbar that calls the existing `handlePopOut` function.

### 1.6 Per-message zoom

**Changes:**
- Move zoom state from `uiStore.readerZoom` to local state in `ReadingPane` / `MessageItem`.
- `StatusBar.tsx` controls zoom for the active reading pane only.

### 1.7 Tests

- `tests/features/viewer/AttachmentList.test.tsx`
- `tests/features/viewer/ThreadView.test.tsx`
- `tests/features/viewer/ContactSidebar.test.tsx`
- `ReadingPane` integration test mocking `db_*` commands.

---

## Phase 2 — Calendar Sync Unblock

**Goal:** Fix schema, implement EAS calendar sync return data, and wire RSVP in the mail viewer.

### 2.1 Schema migration

**File:** `kylins.client.backend/migrations/20260627000002_calendar_schema_fix.sql`

```sql
-- Make google_event_id nullable so EAS/CalDAV/local events don't need fake values.
ALTER TABLE calendar_events ALTER COLUMN google_event_id DROP NOT NULL;

-- Enforce uniqueness on the portable uid per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_account_uid
  ON calendar_events(account_id, uid);

-- Backfill any existing rows that have null uid (shouldn't happen, but safe).
UPDATE calendar_events SET uid = COALESCE(uid, id) WHERE uid IS NULL;
```

### 2.2 Rust EAS calendar sync

**Files:**
- `kylins.client.backend/src/eas/service.rs`
- `kylins.client.backend/src/eas/types.rs`
- `kylins.client.backend/src/eas/commands.rs`

**Changes:**
- Extend `parse_application_data` / `parse_sync_response` to extract calendar fields: `Subject`, `StartTime`, `EndTime`, `UID`, `Location`, `TimeZone`, `Recurrence`, `DtStamp`, `OrganizerEmail`, `Attendees`.
- Return a `SyncResult` containing calendar items that `easCalendarProvider.ts` can convert to `ParsedEvent` rows and persist via `calendarEvents.ts`.

### 2.3 Rust `eas_meeting_response` command

**Files:**
- `kylins.client.backend/src/eas/commands.rs` — add WBXML `MeetingResponse` request builder and response parser (code page 8 / Calendar).
- `kylins.client.backend/src/eas/service.rs` — register `eas_meeting_response` Tauri command.
- `kylins.client.backend/src/eas/client.rs` — add `meeting_response()` method.
- `kylins.client.backend/src/eas/types.rs` — add `MeetingResponseRequest` / `MeetingResponseResult`.

### 2.4 RSVP card in viewer

**New file:**
- `kylins.client.frontend/src/features/viewer/RsvpCard.tsx`

**Changes:**
- `ReadingPane.tsx`: detect `text/calendar` attachment or `METHOD:REQUEST` ICS; render `RsvpCard` with Accept / Tentative / Decline + comment.
- `RsvpCard.tsx`: call `rsvpTask.buildRsvpReply` to generate the reply ICS, then `send.ts` to send it as a MIME attachment.
- For EAS accounts, also call `eas_meeting_response` to update the server-side meeting status.

### 2.5 Multi-account calendar aggregation

**Changes:**
- `calendarStore.ts`: change `loadOccurrences` to accept an array of account IDs (or load all accounts) and merge occurrences.
- `CalendarPage.tsx`: pass all enabled calendar accounts.

### 2.6 Tests

- Rust: `tests/eas_calendar_sync.rs`, `tests/eas_meeting_response.rs` with mocked WBXML fixtures.
- Frontend: `tests/features/viewer/RsvpCard.test.tsx`, `tests/stores/calendarStore.test.ts`.

---

## Phase 3 — Composer Polish + Offline Queue

**Goal:** Close the most common composer gaps and make send reliable offline.

### 3.1 Forward re-attach original files

**Changes:**
- `InlineReply.tsx` forward path: after preparing the quoted body, query `attachments.ts` for the source `message_id` and pre-populate the composer attachment list.
- Update `prepareBodyForQuoting.ts` to stop stripping CID images when original attachments are re-attached.

### 3.2 Plain-text compose mode

**Changes:**
- `composerStore.ts`: add `isPlainText: boolean` and `bodyText: string`.
- `Composer.tsx` / `InlineReply.tsx`: render a plain `<textarea>` when `isPlainText` is true; toolbar hidden or reduced.
- `EditorToolbar.tsx`: add plaintext toggle button.
- `emailBuilder.ts`: when `isPlainText`, generate a single `text/plain` MIME part instead of multipart/alternative.

### 3.3 Send-and-archive

**Changes:**
- `Composer.tsx`: add "Send & Archive" action.
- `send.ts`: after successful send, enqueue an `archive` pending operation for the thread.

### 3.4 Offline queue processor

**Changes:**
- `offlineQueue.ts`: add `startQueueProcessor(intervalMs)` and `stopQueueProcessor()`.
- Worker polls `dequeuePending` when `navigator.onLine` is true, executes each operation via provider calls, and marks completed/failed.
- Wire start/stop in `App.tsx` startup sequence.

### 3.5 Sent folder resolution + sent sound

**Changes:**
- `send.ts`: use `db_get_folder_by_role(accountId, 'sent')` to find the correct Sent folder instead of hardcoded `'Sent'`.
- Add a short bundled sound asset and play it after successful send (respect `messageSentSound` preference).

### 3.6 Tests

- `tests/services/composer/send.test.ts` for send-and-archive and plaintext.
- `tests/services/queue/offlineQueue.test.ts` for queue processor.

---

## Critical Files to Create / Modify

### Frontend

| Path | Purpose |
|---|---|
| `src/features/viewer/AttachmentList.tsx` | Attachment chips + download/open |
| `src/features/viewer/ThreadView.tsx` | Conversation cards container |
| `src/features/viewer/MessageItem.tsx` | Single collapsible message card |
| `src/features/viewer/ContactSidebar.tsx` | Sender contact card + recent threads |
| `src/features/viewer/RsvpCard.tsx` | Accept/Tentative/Decline invite actions |
| `src/services/db/attachments.ts` | Query `attachments` table |
| `src/components/email/ReadingPane.tsx` | Wire attachment list, thread view, sidebar, RSVP, allowlist |
| `src/features/composer/InlineReply.tsx` | Pop-out button, forward re-attach |
| `src/services/composer/send.ts` | Send-and-archive, plaintext path, Sent folder resolution |
| `src/services/composer/emailBuilder.ts` | Plaintext MIME part |
| `src/stores/composerStore.ts` | `isPlainText`, `bodyText` |
| `src/services/queue/offlineQueue.ts` | Queue processor worker |
| `src/stores/calendarStore.ts` | Multi-account aggregation |
| `src/services/calendar/easCalendarProvider.ts` | Persist real `eas_sync` results |

### Backend

| Path | Purpose |
|---|---|
| `src/eas/service.rs` | `eas_sync` calendar parsing; register `eas_meeting_response` |
| `src/eas/types.rs` | Calendar item DTOs; `MeetingResponseRequest/Result` |
| `src/eas/commands.rs` | WBXML calendar parse/build helpers |
| `src/eas/client.rs` | `meeting_response()` method |
| `migrations/20260627000002_calendar_schema_fix.sql` | Nullable `google_event_id`, unique `uid` |

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| EAS calendar field parsing is complex | Start with narrow field map (Subject, StartTime, EndTime, UID, Location, TimeZone, Recurrence); expand incrementally. |
| `calendar_events` migration on live DB | Migration is idempotent; backfill `uid` with `id` only where null. |
| Attachment download differs for IMAP vs EAS | Abstract behind `downloadAttachment(accountId, messageId, attachmentId)` that branches by provider. |
| Plain-text mode duplicates state | Keep `bodyText` as source of truth when `isPlainText` is true; derive HTML only when needed. |
| Offline queue processor races | Serialize operations per account; mark failed with exponential backoff. |

---

## Verification Steps

### Phase 1

1. Open a thread with attachments — attachment chips render with filename/size; click downloads and opens.
2. Select a thread with 3+ messages — conversation view shows oldest→newest cards.
3. Toggle contact sidebar — sender info and recent threads appear.
4. Click "Always show images" — remote images load for that sender on future messages.
5. Inline reply toolbar shows pop-out button.

### Phase 2

1. `cargo test` passes for new EAS calendar sync and meeting response tests.
2. Migration applies cleanly to an existing DB; `google_event_id` becomes nullable.
3. EAS calendar sync populates `calendar_events` with real events.
4. Open an invite email — `RsvpCard` renders; Accept sends iMIP reply and updates EAS meeting status.
5. Week view shows events from multiple accounts.

### Phase 3

1. Forward a message with attachments — composer pre-populates attachment chips.
2. Toggle plain-text mode — composer shows textarea and sends `text/plain` only.
3. Send-and-archive — message sends and archive operation is queued/applied.
4. Go offline, send — operation is queued; restore network, queue drains automatically.
5. Sent message lands in correct Sent folder (localized names work).

---

## Suggested Rollout Order

1. **Phase 1 — Reading Pane MVP** (highest user value; unblocks forward re-attach).
2. **Phase 2 — Calendar Sync Unblock** (unblocks EAS calendar end-to-end and invite workflow).
3. **Phase 3 — Composer Polish + Offline Queue** (closes everyday friction).
4. **Follow-up:** time-grid overlap packing, drag/resize, Google/CalDAV calendar providers, calendar search.

---

## Open Questions

1. Should Phase 1 also implement **find-in-message** (Ctrl+F inside `EmailRenderer`), or defer it?  
   **Recommendation:** Defer; it requires iframe search coordination and is lower value than attachments/thread view.

2. Should the **offline queue processor** run in the frontend or Rust backend?  
   **Recommendation:** Frontend worker first (simplest), with a Rust-side timer as a future improvement.

3. For EAS calendar sync, should we support **recurring exceptions** in the first pass, or only simple single/series-master events?  
   **Recommendation:** Single + series-master with RRULE first; exceptions in a follow-up.

4. Should **send-and-archive** immediately move the thread locally, or wait for the archive pending operation to sync?  
   **Recommendation:** Optimistically move locally and enqueue archive sync; matches Kylins' offline-first pattern.

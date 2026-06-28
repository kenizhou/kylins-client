# Design: Improve Kylins Client Composer / Viewer / Calendar from Reference Codebases

**Date:** 2026-06-27  
**Scope:** Composer, email viewer/reading pane, and calendar subsystems  
**References studied:** Velo, inbox-zero, Mailspring, Thunderbird  
**Baseline plans:** `docs/composer-viewer-calendar-state-report.md`, `docs/superpowers/plans/2026-06-27-composer-viewer-calendar-next-phases.md`, `docs/superpowers/plans/2026-06-27-inbox-zero-graph-gmail-provider-migration.md`

---

## Context

Kylins Client already has a strong architectural foundation and two recent, detailed implementation plans for closing composer/viewer/calendar gaps. The goal here is to **validate those plans against four mature reference codebases** and produce a cohesive design that (a) confirms the right architectural choices, (b) identifies concrete files/patterns to borrow, and (c) fills any gaps the existing plans missed.

The governing principle from project memory remains in force: **Velo is the architecture owner; Mailspring is the feature donor.** Where both implement a feature, keep Velo's pattern and port Mailspring's missing capabilities into it. Thunderbird is a requirements/spec reference (XPCOM/libical code is not portable to Tauri/React). inbox-zero provides the strongest web-era email-security patterns, but its image-proxy/signed-URL model is designed for a web app and is overkill for a desktop client that can simply block remote content.

## Zen Optimization Notes

After the initial plan was written, zen analysis was used to stress-test assumptions. Key refinements applied:

- **Provider factory is required now, not later.** Kylins already has IMAP and EAS frontend providers and is adding Gmail/Graph. `send.ts` already contains a TODO to replace inline `new ImapProvider/EasProvider` with a factory. The recommendation to defer the factory was rejected as inconsistent with existing code and plans.
- **Sync engine integrates with the Graph/Gmail migration plan.** The existing migration plan already defines `MailSource` trait, cursor model, and provider adapters. The sync engine should reuse that design rather than invent a parallel queue.
- **Accessibility is a first-class requirement.** Message headers, attachments, and actions must live outside the iframe so they are keyboard/screen-reader accessible; the iframe contains only the sanitized body.
- **Plain-text compose mode is small, high-value polish.** TipTap v3 supports plaintext serialization; it should be included rather than deferred.
- **Recurrence expansion needs bounded caching.** A simple LRU per calendar + range key prevents re-expanding large series on every view change.

---

## Reference Learnings (What Matters for Kylins)

### Velo (closest stack match — Tauri 2 / React 19 / TipTap v3 / Zustand)
- **Composer:** TipTap state is intentionally isolated from Zustand; only `onUpdate` writes `bodyHtml` back. Debounced draft auto-save, pure-TS `emailBuilder.ts`, inline reply, template shortcuts, undo send.
- **Viewer:** Sandboxed iframe `allow-same-origin` (no scripts), synchronous `doc.write` in `useLayoutEffect`, ResizeObserver auto-height, remote-image blocking with per-sender allowlist, CID inline-image resolution, phishing heuristics.
- **Calendar:** Custom React views (Month/Week/Day), event pre-bucketing with `useMemo`, Google Calendar + CalDAV providers, `icalHelper.ts` seam, multi-calendar visibility toggles.
- **Patterns:** Provider abstraction, optimistic UI + offline queue, SQLite-first local store.

### inbox-zero (Next.js / React / TipTap)
- **Security gold standard:** Strict iframe CSP meta tag, signed image proxy, remote-asset URL rewriting (`rewrite-html.ts`), anti-phishing safe-link disclosure (`render-safe-links.ts`).
- **AI integration:** Deep provider-agnostic AI hooks for draft generation and rule actions.
- **Provider abstraction:** Clean `EmailProvider` interface unifying Gmail/Outlook APIs.
- **Desktop relevance:** CSP injection is directly applicable; image proxy is not (overkill).

### Mailspring (Electron / React / Flux / Slate)
- **Composer:** Custom Slate editor with rich plugin system; `conversion.tsx` for HTML↔Slate serialization; grammar check, templates, markdown shortcuts.
- **Viewer:** `EventedIFrame` re-bubbles mouse/keyboard events; `message-item-body.tsx` handles CID replacement and clipped-message detection.
- **Calendar:** `CalendarDataSource` uses `ical-expander` with occurrence caching/range queries; delta-based recurring-event shifts; inline recurrence exceptions; drag/resize math.
- **Pattern:** Internal-packages plugin architecture, Reflux stores, RxJS DB queries.

### Thunderbird (XUL/XPCOM/libical)
- **Feature completeness:** Full RFC 5545/5546 recurrence, iTIP scheduling, S/MIME/OpenPGP, deep accessibility, comprehensive compose edge cases.
- **Takeaway:** Use as a checklist of what a mature client must handle, not as code to port.

---

## Design Decisions

| Area | Decision | Rationale |
|------|----------|-----------|
| **Architecture owner** | Velo | Already matches Kylins stack (Tauri 2, React 19, TipTap v3, Zustand, SQLite-first). |
| **Feature donor** | Mailspring for data-layer features (recurrence, RSVP, ical.js seam, overlap packing, drag math); inbox-zero for CSP/safe-link hardening. | Keeps code portable (Apache-2.0 / MIT patterns) and aligned with Velo structure. |
| **Calendar views** | Enhance existing custom React views; FullCalendar is a fallback only. | Project decision already made; current views are integrated and themable. Mailspring's overlap-packing + drag math can be ported in. |
| **Viewer iframe** | Keep Velo pattern: `sandbox="allow-same-origin"` + `doc.write` + ResizeObserver + DOMPurify. Add strict CSP meta and safe-link disclosure from inbox-zero. | `allow-same-origin` enables future find-in-thread/context-menu without needing Mailspring's full EventedIFrame. CSP is defense-in-depth. |
| **Remote images** | Block by default + per-sender allowlist; no image proxy. | Desktop threat model doesn't need proxy complexity; blocking prevents tracking entirely. |
| **Composer editor** | Keep TipTap v3; borrow Velo's `emailBuilder`, draft-auto-save, and inline-reply patterns. Add plain-text toggle using TipTap's plaintext serialization. | Already implemented; avoid Slate migration. Plain-text is a small, high-value gap from the state report. |
| **Provider resolution** | Create `providerFactory.ts` now. Returns `ImapProvider`/`EasProvider` today; `GmailApiProvider`/`GraphProvider` when those land. | `send.ts` already duplicates provider instantiation; Graph/Gmail migration plan also calls for a factory. |
| **Sync engine** | Rust backend owns sync-critical tables; concrete provider implementations (`ImapSource`, `EasSource`, future `GmailApiSource`/`GraphSource`) implement the shared `MailSource` trait from the Graph/Gmail migration plan. | Aligns with current DB cutover and existing migration plan. Avoid inventing a parallel queue. |
| **Calendar data layer** | Keep `icalHelper.ts` as the seam; back it with `ical.js` + `ical-expander` (already done); port Mailspring occurrence-caching + range-query patterns. | This is exactly the seam already built. |

---

## Recommended Roadmap

The roadmap below **builds on top of** `docs/superpowers/plans/2026-06-27-composer-viewer-calendar-next-phases.md`. It reorders for risk and keeps the same three phases, but adds reference-backed detail.

### Phase 1 — Reading Pane MVP + Viewer Hardening (Highest User Value)

**Goal:** Transform the reading pane from a single-message renderer into a functional email viewer.

1. **Attachment list + download**
   - Create `src/features/viewer/AttachmentList.tsx`.
   - Create `src/services/db/attachments.ts` to query the existing `attachments` table.
   - Wire download through a new `downloadAttachment(accountId, messageId, attachmentId)` helper that branches by provider (IMAP `imap_fetch_attachment`, EAS `eas_item_operations`).
   - Modify `ReadingPane.tsx` to render the list.

2. **Thread / conversation view**
   - Create `src/features/viewer/ThreadView.tsx` and `src/features/viewer/MessageItem.tsx`.
   - Use `getMessagesForThread` from `src/services/db/threads.ts`.
   - Render oldest→newest collapsible cards; keep single-message mode available.
   - Modify `ReadingPane.tsx` to switch modes via `viewStore.conversationView`.

3. **CID inline-image resolution**
   - Create `src/services/email/resolveCidMap.ts`.
   - Parse raw message/cached body to build `Map<content-id, data: URL>`.
   - Modify `ReadingPane.tsx` to pass a real `cidMap` into `EmailRenderer`.

4. **Archive / Delete handlers**
   - Modify `ReadingPane.tsx` to wire the no-op Archive/Delete buttons.
   - Use `db_get_folder_by_role(accountId, 'archive'|'trash'|'sent')` for folder resolution.
   - Route through a future provider-agnostic action dispatcher (see Cross-Cutting section).

5. **Security + accessibility hardening**
   - Modify `src/services/email/sanitizeForViewer.ts` to inject a CSP meta tag:
     `default-src 'none'; img-src cid: data: https:; style-src 'unsafe-inline';`.
   - Enhance `LinkConfirmDialog.tsx` with inbox-zero-style destination disclosure when displayed text URL ≠ href URL.
   - Ensure `ReadingPane.tsx` keeps all chrome (header, attachments, actions) outside the iframe so it is keyboard/screen-reader accessible; the iframe contains only the sanitized body.

6. **Contact sidebar + image allowlist (existing plan items)**
   - Port Velo's `ContactSidebar.tsx` pattern.
   - Wire `imageAllowlist.isAllowlisted(accountId, senderEmail)` instead of hardcoded `false`.

7. **Plain-text compose mode**
   - Add `isPlainText` + `bodyText` to `src/stores/composerStore.ts`.
   - Modify `Composer.tsx` / `InlineReply.tsx` to render a `<textarea>` when plain-text is active; hide rich toolbar.
   - Modify `src/services/composer/emailBuilder.ts` to emit a single `text/plain` MIME part instead of multipart/alternative when plain-text.
   - Add toolbar toggle in `EditorToolbar.tsx`.

**Verification:**
- Open a thread with attachments → chips render, click downloads.
- Select a 3+ message thread → conversation cards render oldest→newest.
- Send an inline image to self → image renders in viewer.
- Archive/Delete moves message to correct folder.
- Remote images blocked; "Always show from this sender" persists.

---

### Phase 2 — Sync Engine + Provider Factory (Foundational)

**Goal:** Make the app actually retrieve and sync mail. This is prerequisite to making Phase 1 features feel real.

1. **Provider factory (frontend)**
   - Create `src/services/mail/providerFactory.ts` with `getProvider(account): MailProvider`.
   - Returns `ImapProvider` or `EasProvider` based on `account.provider`.
   - Modify `src/services/composer/send.ts` to use the factory and `db_get_folder_by_role` for Sent folder resolution.

2. **Rust mail sync engine**
   - Reuse the `MailSource` trait and cursor model from `docs/superpowers/plans/2026-06-27-inbox-zero-graph-gmail-provider-migration.md`.
   - Implement concrete `ImapSource` first (`kylins.client.backend/src/sync/mail/imap.rs`).
   - Create `kylins.client.backend/src/sync/mail/engine.rs` — `MailSyncEngine` that drives any `MailSource` per-folder with delta sync (UIDVALIDITY + new UIDs for IMAP).
   - Create `kylins.client.backend/src/sync/mail/scheduler.rs` — Tokio background poll every 5 minutes, respecting offline state.
   - Add `sync_account(account_id, force_full)` Tauri command in `commands.rs`.
   - When Gmail/Graph adapters land, they plug into the same engine (`GmailApiSource`, `GraphSource`).

3. **Offline queue processor**
   - Extend `src/services/queue/offlineQueue.ts` with `startQueueProcessor` / `stopQueueProcessor`.
   - Poll every 30s when online; retry send operations via provider factory; exponential backoff on failure.
   - Wire start/stop into `App.tsx` startup.

4. **Frontend sync integration**
   - Modify `src/stores/accountStore.ts` to trigger initial sync after account creation and on app startup.
   - Modify `StatusBar.tsx`, `FolderPane.tsx`, `MessageList.tsx` to reflect sync progress and refresh data.

**Verification:**
- Add IMAP account → folders and messages populate.
- Send email to self → appears in Inbox after sync.
- Disconnect network → send is queued; reconnect → queue drains.
- Archive/delete actions sync back to server.

---

### Phase 3 — Calendar Hardening + Event Editing

**Goal:** Make the calendar a functional scheduling tool.

1. **Schema fix**
   - Migration: make `calendar_events.google_event_id` nullable; add `UNIQUE(account_id, uid)`.

2. **Recurrence hardening (Mailspring patterns)**
   - Create `src/services/calendar/occurrenceCache.ts` with an LRU + TTL range cache keyed by `uid + rangeStart + rangeEnd`.
   - Modify `src/stores/calendarStore.ts` to check the cache before calling `expandStoredEvents`, and to support multi-account aggregation.
   - Ensure `recurrence_start`/`recurrence_end` index exists.

3. **Event detail / edit / recurring-actions UI**
   - Create `src/components/calendar/EventDetailModal.tsx`.
   - Create `src/components/calendar/EventEditModal.tsx`.
   - Create `src/components/calendar/RecurringActionsDialog.tsx` for "this occurrence / all / following".
   - Wire `IcalHelper.createRecurrenceException` for "this occurrence" edits.

4. **RSVP card in viewer**
   - Create `src/features/viewer/RsvpCard.tsx`.
   - Detect `text/calendar` attachment with `METHOD:REQUEST` in `ReadingPane.tsx`.
   - Use `src/services/calendar/rsvpTask.ts` to build RFC 5546 REPLY and send via `send.ts`.

5. **CalDAV sync foundation**
   - Create Rust CalDAV client (`kylins.client.backend/src/sync/calendar/caldav.rs`).
   - Add commands: `caldav_list_calendars`, `caldav_sync_events`, `caldav_create_event`, etc.
   - Sync via `calendar-query` time-range, upsert to `calendar_events` with `etag`.

6. **Deferred to follow-up**
   - Time-grid overlap packing, drag/resize, VALARM notifications, free/busy, Google Calendar provider, full VTIMEZONE blocks, attendee UI.

**Verification:**
- Create weekly recurring event → appears on all weeks.
- Edit one occurrence → exception created, other occurrences unchanged.
- Open invite email → RSVP card renders; Accept sends iMIP reply.
- CalDAV account syncs events from a test server (Nextcloud / Google CalDAV).

---

## Cross-Cutting: Provider-Agnostic Action Dispatch

Both Phase 2 mail sync and the Graph/Gmail migration plan need a unified way to perform actions (mark read, star, archive, move, send) across IMAP/EAS/Gmail/Graph.

- **Rust:** Define `MailAction` enum in `kylins.client.backend/src/mail/actions.rs` and add `apply_action` to the `MailSource` trait.
- **Frontend:** Create `src/services/mail/actions.ts` dispatcher that resolves provider via `providerFactory` and invokes the appropriate Rust command.
- This replaces ad-hoc `ImapProvider`/`EasProvider` instantiation in `send.ts`, `ReadingPane.tsx`, and the future queue processor.

---

## Critical Files to Create / Modify

### Frontend

| Path | Action | Purpose |
|------|--------|---------|
| `src/features/viewer/AttachmentList.tsx` | Create | Attachment chips + download |
| `src/features/viewer/ThreadView.tsx` | Create | Conversation cards container |
| `src/features/viewer/MessageItem.tsx` | Create | Collapsible single message card |
| `src/features/viewer/ContactSidebar.tsx` | Create | Sender contact + recent threads |
| `src/features/viewer/RsvpCard.tsx` | Create | Meeting invite actions |
| `src/services/db/attachments.ts` | Create | Query `attachments` table |
| `src/services/email/resolveCidMap.ts` | Create | Build content-id → data URL map |
| `src/services/mail/providerFactory.ts` | Create | Resolve provider by account type |
| `src/services/mail/actions.ts` | Create | Provider-agnostic action dispatcher |
| `src/services/queue/queueProcessor.ts` | Create | Drain `pending_operations` |
| `src/services/calendar/occurrenceCache.ts` | Create | LRU + TTL range cache for occurrences |
| `src/components/calendar/EventDetailModal.tsx` | Create | View event details |
| `src/components/calendar/EventEditModal.tsx` | Create | Edit event + recurrence choice |
| `src/components/calendar/RecurringActionsDialog.tsx` | Create | this/all/following choice |
| `src/components/layout/ReadingPane.tsx` | Modify | Wire attachments, thread view, archive/delete, CID map, RSVP, allowlist, accessibility |
| `src/services/composer/send.ts` | Modify | Use provider factory + Sent folder resolver |
| `src/services/composer/emailBuilder.ts` | Modify | Plain-text MIME part path |
| `src/stores/composerStore.ts` | Modify | `isPlainText`, `bodyText` |
| `src/components/composer/Composer.tsx` | Modify | Plain-text textarea path |
| `src/components/email/InlineReply.tsx` | Modify | Plain-text textarea path |
| `src/components/composer/EditorToolbar.tsx` | Modify | Plain-text toggle |
| `src/services/email/sanitizeForViewer.ts` | Modify | Inject CSP meta tag |
| `src/stores/calendarStore.ts` | Modify | Multi-account aggregation + cache |
| `src/services/db/calendarEvents.ts` | Modify | Range query + delete |
| `src/App.tsx` | Modify | Start/stop offline queue processor |

### Backend

| Path | Action | Purpose |
|------|--------|---------|
| `kylins.client.backend/src/sync/mail/imap.rs` | Create | `ImapSource` implementing `MailSource` trait |
| `kylins.client.backend/src/sync/mail/engine.rs` | Create | `MailSyncEngine` driving any `MailSource` |
| `kylins.client.backend/src/sync/mail/scheduler.rs` | Create | Background sync poll |
| `kylins.client.backend/src/mail/actions.rs` | Create | `MailAction` enum |
| `kylins.client.backend/src/sync/calendar/caldav.rs` | Create | CalDAV client |
| `kylins.client.backend/src/sync/calendar/mod.rs` | Create | Calendar sync orchestrator |
| `kylins.client.backend/src/commands.rs` | Modify | Register `sync_account`, `caldav_*` |
| `kylins.client.backend/migrations/` | Add | Calendar schema fix, sync state tables |

---

## Verification Gates

Per project memory, run from `kylins.client.frontend/`:

```bash
npx tsc --noEmit && npx eslint . && npx prettier --check . && npx vitest run
```

### Phase 1
- Attachments render and download.
- Thread view shows conversation cards.
- Inline images from CID render.
- Archive/delete move messages.
- Remote images blocked by default; allowlist persists.
- Plain-text toggle switches composer to textarea and sends `text/plain` only.
- Message header/attachments/actions are keyboard navigable (outside iframe).

### Phase 2
- IMAP account syncs folders/messages.
- Send succeeds and lands in correct Sent folder.
- Offline send is queued and retried.
- Folder unread counts update after sync.

### Phase 3
- Recurring events expand correctly.
- Exception editing creates `RECURRENCE-ID` override.
- RSVP card sends iMIP reply.
- CalDAV account syncs events.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Rust sync engine complexity | Start with frontend-driven per-folder sync using existing `ImapProvider.syncFolderBatched`; extract to Rust background task once stable. |
| SQLite two-writer conflict (frontend plugin-sql + Rust sqlx) | Keep sync-critical tables Rust-only; frontend only reads via `db_*` commands. |
| Recurrence edge cases (DST, EXDATE, RDATE) | Store UTC + display TZ; add unit tests for DST boundaries; validate against Thunderbird fixtures. |
| Accessibility of iframe content | Keep all chrome outside iframe; provide skip-link into iframe; ensure focus is visible. |
| CalDAV auth diversity | Start with Basic auth; add Digest via `reqwest-digest`; OAuth deferred. |
| CSP meta breaks rare external stylesheets | Acceptable trade-off; allow `style-src 'unsafe-inline'`. |
| EAS Rust backend still stubbed | Phase 3 CalDAV gives working calendar sync while EAS Rust catches up. |

---

## What to Borrow from Each Reference (Concrete Source Files)

| Pattern | Source | Target in Kylins |
|---------|--------|------------------|
| `emailBuilder.ts` / MIME builder | Velo `src/utils/emailBuilder.ts` | Already ported; keep |
| Draft auto-save subscription pattern | Velo `src/services/composer/draftAutoSave.ts` | Already ported; keep |
| Inline reply quoting | Velo `src/components/email/InlineReply.tsx` | Already ported; polish |
| iframe `doc.write` + ResizeObserver | Velo `src/components/email/EmailRenderer.tsx` | Already in Kylins `EmailRenderer.tsx`; keep |
| `@import`-strip + URI allowlist | Mailspring sanitize logic | Already in `sanitizeForViewer.ts`; keep |
| Tracker blacklist + 1×1 strip | Mailspring `imageBlocker.ts` pattern | Already in `imageBlocker.ts`; keep |
| Recurrence expansion + exception handling | Mailspring `calendar-utils.ts` / `ics-event-helpers.ts` | Ported into `icalHelper.ts`; add caching layer |
| Occurrence caching / range queries | Mailspring `CalendarDataSource.ts` | New `occurrenceCache.ts` |
| Strict iframe CSP meta | inbox-zero `HtmlEmail.tsx` | Add to `sanitizeForViewer.ts` |
| Safe-link destination disclosure | inbox-zero `render-safe-links.ts` | Enhance `LinkConfirmDialog.tsx` |
| Provider abstraction interface | inbox-zero `utils/email/types.ts` | Model for `providerFactory.ts` + `MailSource` trait |

---

## Unimplemented Features & How to Build Them

This section answers the specific gaps around meetings, appointments, and recurrence. It is derived from the current state report and the reference implementations (Velo, Mailspring, Thunderbird).

### What Is Not Implemented

From `docs/composer-viewer-calendar-state-report.md`:

**Composer:** forward re-attach original files, plain-text compose mode, emoji picker, font-size control, image resize, grammar check, send-and-archive, sent sound, provider factory, correct Sent folder resolution, offline queue processor, Smart From in modal, Reply-To UI field, inline reply attachments.

**Viewer:** attachment list UI, thread/conversation view, contact sidebar, unsubscribe action, raw message modal, calendar RSVP card, image allowlist wiring, pop-out button in inline reply, find-in-message.

**Calendar:** time-grid overlap packing, drag/resize events, RSVP card + recurring-actions dialog, VALARM notifications, `google_event_id` schema fix, Google/CalDAV providers, EAS `MeetingResponse` Rust command, event detail/edit modal, calendar list + colors, multi-account aggregation, full VTIMEZONE blocks, event FTS search, tasks.

### How to Create / Send a Meeting Request

A meeting request is an email with a `text/calendar` attachment whose `METHOD` is `REQUEST`.

#### Data model
- Reuse `src/services/calendar/icalHelper.ts` (`IcalHelper.generateICS`) with `method: 'REQUEST'`.
- Input fields: `summary` (title), `start`, `end`, `timezone`, `location`, `description`, `organizer` (the sender), `attendees[]` with `partstat: 'NEEDS-ACTION'` and `rsvp: true`.
- Generate a stable `uid` (UUID) so replies can match later.

#### UI entry points
1. **Composer:** add a "New meeting" / "Schedule meeting" button in `Composer.tsx` that opens a meeting-specific side panel (`MeetingRequestPanel.tsx`) with title, location, start/end, timezone, attendee chips, optional recurrence.
2. **Calendar:** clicking an empty slot in Week/Day view opens `EventCreateModal.tsx` with a "Make this a meeting" toggle that adds attendee input.

#### Send path
- Build the ICS string via `IcalHelper.generateICS`.
- In `src/utils/emailBuilder.ts`, add a multipart structure:
  - `multipart/alternative`
    - `text/plain` (human-readable invitation summary)
    - `text/html` (formatted invitation)
    - `text/calendar; method=REQUEST; charset=utf-8` (the ICS)
- For **IMAP/SMTP** and **Gmail API raw send**, send this MIME directly.
- For **Microsoft Graph**, send structured JSON and attach the ICS as a `fileAttachment` with `contentType: 'text/calendar; method=REQUEST'`.
- For **EAS**, wrap the MIME in `SendMail` (`SaveToSent: true`). EAS servers typically parse the `text/calendar` part and create the meeting.
- Save a copy to the local `calendar_events` table with `method: 'REQUEST'` and the same UID so the sender sees it on their calendar.

#### Server-side state
- On send, upsert the event locally with `status: 'CONFIRMED'` and organizer = self.
- Track attendees in a new `event_attendees` table (or JSON column): `event_id`, `email`, `name`, `partstat`, `role`, `rsvp`.

### How to Create an Appointment (Non-Meeting Event)

An appointment is a calendar event with no attendees (or only the user) and no `METHOD` (or `METHOD: PUBLISH`).

#### UI
- `EventCreateModal.tsx` already exists. Add fields for title, location, all-day toggle, start/end, timezone, description, and calendar selection.
- If the attendee list is empty, it is an appointment.

#### Save path
- Generate ICS via `IcalHelper.generateICS` with no `method` and no `attendees`.
- Insert into `calendar_events` table with `ical_data` containing the ICS.
- For **CalDAV**, `PUT` the ICS to the server calendar URL; store returned `etag`.
- For **Google Calendar**, `events.insert` via REST (future provider).
- For **Graph**, `POST /me/events` with structured JSON or `POST /me/calendars/{id}/events` (future provider).
- For **EAS**, once `eas_sync` returns data, use `Sync` command to push the VEVENT (future Rust work).

### How to Implement Recurring Events

#### Create recurrence
- In `EventCreateModal.tsx`, add a recurrence picker: "Does not repeat", "Daily", "Weekly" (pick days), "Monthly" (day of month / nth weekday), "Yearly", "Custom".
- Convert the selection to an RRULE string, e.g.:
  - Weekly Mon/Wed/Fri: `FREQ=WEEKLY;BYDAY=MO,WE,FR`
  - Monthly 2nd Tuesday: `FREQ=MONTHLY;BYSETPOS=2;BYDAY=TU`
  - Until N occurrences or end date: add `COUNT=N` or `UNTIL=YYYYMMDDTHHMMSSZ`
- Store the RRULE in `calendar_events.recurrence_rule` and the raw ICS in `ical_data`.

#### Display recurrence
- `calendarStore.loadOccurrences` already calls `expandStoredEvents`, which uses `IcalHelper.expandOccurrences` backed by `ical-expander`.
- Add the LRU cache from Phase 3 to avoid re-expansion.
- In views, render each `Occurrence` as an `EventCard`. For multi-day events, span across day cells (future enhancement).

#### Edit recurrence
- On clicking a recurring event, show `RecurringActionsDialog.tsx` with three choices:
  1. **This occurrence** — create a `RECURRENCE-ID` exception via `IcalHelper.createRecurrenceException`. Store the exception as a separate `calendar_events` row with `uid` matching the master and a non-null `recurrence_id`. When expanding, `ical-expander` merges exceptions automatically if the master ICS includes both master + exception VEVENTs.
  2. **All occurrences** — update the master row's RRULE/times and regenerate the master ICS.
  3. **This and following** — Mailspring's delta-based approach: shift the master `DTSTART` by the delta, set `UNTIL` before the edited occurrence, and create a new master series starting at the edited occurrence. This preserves prior history.

#### Exception storage strategy
- Keep it simple first: store the master ICS in one row. When "this occurrence" is edited, generate a new VEVENT with `RECURRENCE-ID` and append it to the same ICS string (or store as a separate row with `is_exception = true` and the same `uid`).
- The `expandStoredEvents` function should pass all rows for the same UID to `IcalHelper.expandOccurrences` so overrides are honored.

#### EXDATE / RDATE
- For "Delete this occurrence" without modifying the series, generate an `EXDATE` in the master ICS.
- For "Add occurrence" (rare), use `RDATE`.
- `ical-expander` handles both if present in the ICS.

### How to Handle Incoming Meeting Requests (RSVP)

- In `ReadingPane.tsx`, detect a `text/calendar` attachment or inline ICS with `METHOD:REQUEST`.
- Parse it via `IcalHelper.parseEvents`.
- Render `RsvpCard.tsx` showing title, time, organizer, attendees, Accept/Tentative/Decline buttons + optional comment.
- On response:
  1. Build a reply ICS via `src/services/calendar/rsvpTask.ts` (`buildRsvpReply`) with `METHOD:REPLY`, the user's attendee row set to `partstat`, and only the user's attendee (RFC 5546 strips others).
  2. Send the reply as an email with `text/calendar; method=REPLY` attachment.
  3. For EAS accounts, also call the `eas_meeting_response` Rust command (WBXML `MeetingResponse`) so the server knows the response.
  4. Update local `event_attendees.partstat` for the user.

### Files to Create / Modify for These Features

| Feature | Files |
|---------|-------|
| Meeting request composer panel | `src/components/composer/MeetingRequestPanel.tsx` (create) |
| Meeting request send path | `src/utils/emailBuilder.ts` (modify), `src/services/composer/send.ts` (modify) |
| Event create/edit modal enhancements | `src/components/calendar/EventCreateModal.tsx`, `EventEditModal.tsx` (modify) |
| Recurrence picker | `src/components/calendar/RecurrencePicker.tsx` (create) |
| Recurring-actions dialog | `src/components/calendar/RecurringActionsDialog.tsx` (create) |
| RSVP card | `src/features/viewer/RsvpCard.tsx` (create) |
| RSVP send | `src/services/calendar/rsvpTask.ts` (modify), `src/services/composer/send.ts` (modify) |
| Attendee storage | `kylins.client.backend/migrations/` (add `event_attendees` table) |
| EAS meeting response | `kylins.client.backend/src/eas/commands.rs`, `service.rs`, `types.rs` (modify) |

---

## Conclusion

The existing 2026-06-27 plans are well-aligned with what the reference codebases teach us. The zen-optimized, highest-leverage next steps are:

1. **Ship Reading Pane MVP** (attachments, thread view, archive/delete, CID resolution, CSP, safe-links, accessibility) — highest immediate user value.
2. **Build the sync engine + provider factory** (reusing the Graph/Gmail migration's `MailSource` trait) — without live sync, the reading pane remains a demo.
3. **Harden the calendar** (schema fix, recurrence LRU caching, event edit/detail, RSVP, CalDAV) — turn the existing views into a real scheduler.
4. **Add composer polish** (plain-text mode, send-and-archive, forward re-attach) — close everyday friction with small changes.

Defer: FullCalendar swap, image proxy, S/MIME/OpenPGP, advanced recurrence edge cases, AI composer features.

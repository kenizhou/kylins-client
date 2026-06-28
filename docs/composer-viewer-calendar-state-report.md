# Composer / Viewer / Calendar — Current State Report

**Date:** 2026-06-27  
**Scope:** Snapshot of what is implemented and what remains in Kylins Client's composer, email viewer/reading pane, and calendar subsystems.

---

## Composer

### Done

| Feature | Notes | Key files |
|---|---|---|
| Modal composer | Full compose surface (To/Cc/Bcc, subject, rich text, attachments, send/schedule/discard, pop-out) | `src/components/composer/Composer.tsx` |
| Inline reply/forward | Reading-pane inline composer with pop-out to modal | `src/components/email/InlineReply.tsx` |
| TipTap v3 editor | StarterKit + Image + Table + TextStyle + Color + Highlight + FontFamily + Link + Placeholder | `src/features/composer/editorExtensions.ts` |
| Toolbar | Bold/italic/underline, headings, lists, quote, code, highlight, color, font family, link, image, undo/redo | `src/components/composer/EditorToolbar.tsx` |
| Addressing | Tokenizing recipient chips with contact autocomplete, paste parsing, invalid highlighting, context menus | `src/features/composer/RecipientField.tsx` |
| Smart From / reply participants | `fromResolution.ts`, `recipientsForReply.ts`, `subjectPrefix.ts` | `src/features/composer/` |
| Quoting & signatures | `prepareBodyForQuoting.ts`, `signaturePlacement.ts` | `src/features/composer/` |
| Send pipeline | SMTP/EAS routing, MIME builder with CID inline images, offline queue on failure | `src/services/composer/send.ts`, `emailBuilder.ts` |
| Draft auto-save | 3-second debounce on body/subject/recipients/attachments | `src/services/composer/drafts.ts`, `draftAutoSave.ts` |
| Undo send | Configurable delay window | `src/components/composer/UndoSendToast.tsx` |
| Schedule send | Presets + custom datetime picker | `src/components/composer/ScheduleSendDialog.tsx` |
| Templates | Insert template body, shortcut expansion | `src/components/composer/TemplatePicker.tsx` |
| Signatures | Per-account signature picker | `src/components/composer/SignatureSelector.tsx` |
| Classification | Public/internal/restricted/confidential levels | `src/components/composer/ClassificationSelector.tsx` |

### Pending

| Feature | Blocker / Note | Key files to touch |
|---|---|---|
| Forward re-attach original files | `MailMessage.attachments` not populated; use `attachments` DB table | `src/features/composer/prepareBodyForQuoting.ts`, `InlineReply.tsx`, `src/services/db/attachments.ts` |
| Plain-text compose mode | Preference exists but editor always produces HTML | `src/stores/composerStore.ts`, `Composer.tsx`, `emailBuilder.ts` |
| Emoji picker | None installed | `EditorToolbar.tsx`, `editorExtensions.ts` |
| Font-size control | No `FontSize` extension | `EditorToolbar.tsx`, `editorExtensions.ts` |
| Image resize | Images inserted but not resizable | `editorExtensions.ts` |
| Grammar check | Preference exists, not wired | `src/stores/preferencesStore.ts`, `GeneralPreferences.tsx` |
| Send-and-archive | Needs viewer archive capability | `Composer.tsx`, `send.ts` |
| Sent sound | TODO placeholder | `Composer.tsx` |
| Provider factory | `send.ts` creates providers directly | `send.ts` |
| Correct Sent folder resolution | Hardcoded `'Sent'` | `send.ts` |
| Offline queue processor | Queue enqueues but never drains | `src/services/queue/offlineQueue.ts`, `send.ts` |
| Smart From in modal | Only used in inline reply | `Composer.tsx`, `fromResolution.ts` |
| Reply-To UI field | In store but no UI | `Composer.tsx`, `composerStore.ts` |
| Inline reply attachments | No attachment picker | `InlineReply.tsx` |
| Juice inline performance | Runs on main thread | `src/services/composer/juiceInline.ts` |

---

## Viewer / Reading Pane

### Done

| Feature | Notes | Key files |
|---|---|---|
| Sandboxed HTML renderer | `EmailRenderer.tsx` with `allow-same-origin`, no scripts, auto-height, theme styling | `src/components/email/EmailRenderer.tsx` |
| Sanitization | DOMPurify wrapper keeping `<style>` but stripping `@import`/dangerous schemes | `src/services/email/sanitizeForViewer.ts` |
| Remote image blocking | Blocks `http(s)` images, preserves `data:`/`cid:` | `src/utils/imageBlocker.ts` |
| Tracker stripping | Known tracker domain list + 1x1 pixel neutralization | `src/services/email/trackerBlacklist.ts`, `imageBlocker.ts` |
| Phishing detection | Scoring engine + suspicious link gating | `src/utils/phishingDetector.ts`, `EmailRenderer.tsx` |
| Link confirm dialog | Shows real URL before opening | `src/components/email/LinkConfirmDialog.tsx` |
| Inline reply/forward | Inside reading pane | `src/components/email/InlineReply.tsx` |
| Reading pane layout | Right/bottom/off via `react-resizable-panels` | `src/components/layout/ReadingPaneLayout.tsx` |
| Reading pane header/actions | Subject, classification, sender, Reply/Reply All/Forward/Archive/Delete/More | `src/components/layout/ReadingPane.tsx` |
| Global reader zoom | `uiStore.readerZoom` + StatusBar controls | `src/stores/uiStore.ts`, `StatusBar.tsx`, `EmailRenderer.tsx` |
| Thread data layer | `getThreads`, `getMessagesForThread`, `markThreadRead` via Rust commands | `src/services/db/threads.ts` |
| Message body cache | Lazy fetch/store/evict via Rust | `src/services/db/messageBodies.ts` |

### Pending

| Feature | Blocker / Note | Key files to touch |
|---|---|---|
| Attachment list UI | `attachments` table exists but not rendered | `ReadingPane.tsx`, new `AttachmentList.tsx`, `src/services/db/attachments.ts` |
| Thread/conversation view | `conversationView` flag exists, no component | `ReadingPane.tsx`, new `ThreadView.tsx`/`MessageItem.tsx` |
| Contact sidebar | No component | `ReadingPane.tsx`, new `ContactSidebar.tsx` |
| Unsubscribe action | `list_unsubscribe` columns exist, no UI | `ReadingPane.tsx`, new `services/email/unsubscribe.ts` |
| Raw message modal | Not implemented | `ReadingPane.tsx`, new `RawMessageModal.tsx` |
| Per-message zoom | Currently global | `uiStore.ts`, `ReadingPane.tsx`, `EmailRenderer.tsx` |
| Calendar RSVP in viewer | `rsvpTask.ts` exists, MIME wiring deferred | `ReadingPane.tsx`, new `RsvpCard.tsx`, `send.ts` |
| Image allowlist check | `imageAllowlist.ts` ready, `ReadingPane` hardcodes `false` | `ReadingPane.tsx`, `imageAllowlist.ts` |
| Pop-out button in InlineReply | `handlePopOut` exists, no UI button | `InlineReply.tsx` |
| Find-in-message | Shortcut TODO | `useKeyboardShortcuts.ts`, `EmailRenderer.tsx` |

---

## Calendar

### Done

| Feature | Notes | Key files |
|---|---|---|
| ICS parse/generate | `ical.js` + RFC 5545/5546, RRULE, EXDATE, attendees, organizer | `src/services/calendar/icalHelper.ts` |
| Recurrence expansion | `ical-expander` bridge to DB rows | `src/services/calendar/recurrenceExpander.ts` |
| Calendar store | Zustand, current date, view, occurrences | `src/stores/calendarStore.ts` |
| DB CRUD + range query | `recurrence_start`/`recurrence_end` indexed range | `src/services/db/calendarEvents.ts` |
| Views | Month / Week / Day / Agenda | `src/components/calendar/*View.tsx` |
| Event create modal | Title, location, all-day, datetime, description | `src/components/calendar/EventCreateModal.tsx` |
| Toolbar / EventCard | Navigation and shared occurrence chip | `CalendarToolbar.tsx`, `EventCard.tsx` |
| EAS calendar provider (TS) | Wraps `eas_sync` with `class: 'Calendar'` | `src/services/calendar/easCalendarProvider.ts` |
| RSVP REPLY builder | RFC 5546 single-attendee REPLY | `src/services/calendar/rsvpTask.ts` |
| Migrations | v5, v19, v28 cover `calendar_events`, `calendars`, `events_fts` | `src/services/db/migrations.ts` |

### Pending

| Feature | Blocker / Note | Key files to touch |
|---|---|---|
| Time-grid overlap packing | Week/Day are simple lists | `WeekView.tsx`, `DayView.tsx` |
| Drag/resize events | Not implemented | `WeekView.tsx`, `DayView.tsx`, `EventCard.tsx` |
| RSVP card in mail viewer | No UI integration | `ReadingPane.tsx`, new `RsvpCard.tsx` |
| Recurring-actions dialog | Edit this/all/following | new `recurringActions.ts`, `RecurringActionsDialog.tsx` |
| VALARM notifications | No notification plugin integration | `tauri-plugin-notification` |
| Schema fix: `google_event_id` NOT NULL | Blocks EAS/CalDAV dedup | `migrations.ts`, `calendarEvents.ts` |
| Google/CalDAV providers | Not present | new `googleCalendarProvider.ts`, `caldavProvider.ts`, `providerFactory.ts` |
| EAS `MeetingResponse` Rust command | TS calls it, Rust missing | `kylins.client.backend/src/eas/service.rs`, `types.rs`, `commands.rs` |
| Event detail/edit modal | Create only today | new `EventDetailModal.tsx`/`EventEditPopover.tsx` |
| Calendar list + colors | `calendars` table exists, no UI | new `CalendarList.tsx`, `calendarHelpers.ts` |
| Multi-account aggregation | `loadOccurrences` takes single account | `calendarStore.ts` |
| Full VTIMEZONE block | Bare TZID only | `icalHelper.ts` |
| Event search (FTS) | `events_fts` schema ready, no query/UI | `calendarEvents.ts`, search UI |

---

## Cross-Cutting Blockers

1. **`MailMessage.attachments` is not populated by providers.** The `attachments` DB table is the reliable source for viewer and forward re-attach.
2. **EAS Rust backend returns empty for `eas_sync` and lacks `eas_meeting_response`.** Calendar sync and RSVP are runtime-blocked until Rust catches up.
3. **`calendar_events.google_event_id` is `NOT NULL`.** Must become nullable with a `UNIQUE(account_id, uid)` constraint for non-Google providers.
4. **No shared provider factory.** `send.ts` instantiates IMAP/EAS directly; calendar has no factory.
5. **Offline queue is write-only.** No processor drains `pending_operations`.

---

## Recommended Next Plan

A phased implementation plan has been saved alongside this report:

- `docs/superpowers/plans/2026-06-27-composer-viewer-calendar-next-phases.md`

It proposes three milestones:

1. **Reading Pane MVP** — attachments, thread view, contact sidebar, image allowlist, per-message zoom.
2. **Calendar Sync Unblock** — schema fix, EAS calendar sync return data, `eas_meeting_response`, RSVP card, multi-account aggregation.
3. **Composer Polish + Offline Queue** — forward re-attach, plain-text mode, send-and-archive, queue processor, correct Sent folder.

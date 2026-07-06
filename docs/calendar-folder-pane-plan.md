# Calendar Folder Pane Enhancement Plan

**Date:** 2026-07-06  
**Branch:** `a11y-contrast-touch-targets`  
**Goal:** Add an Outlook-style folder pane for navigating and filtering calendars, informed by Mailspring and Thunderbird Desktop.

## Background

Kylins Client already has a skeleton calendar module:

- Rust backend: `calendar_events` table and CRUD IPC commands in `kylins.client.backend/src/db/calendar_events.rs`.
- Frontend: `CalendarPage`, `MonthView`/`WeekView`/`DayView`/`AgendaView`, `CalendarToolbar`, `EventCreateModal`.
- Store: `calendarStore.ts` with `currentDate`, `view`, and `loadOccurrences`.
- ICS/recurrence: `icalHelper.ts` + `recurrenceExpander.ts` backed by `ical.js` / `ical-expander`.
- Layout: `AppShell.tsx` switches apps via `useUIStore.activeApp`; calendar currently renders without a folder pane.
- The baseline migration already defines a `calendars` table, but no Rust module or frontend service uses it yet.

This plan fills that gap.

## Reference findings

### Mailspring (`app/internal_packages/main-calendar/`)

- Stores raw ICS as the source of truth plus indexed `recurrenceStart`/`recurrenceEnd` columns.
- Per-account **calendar source list** with visibility toggles, colors, and a mini-month.
- Recurrence expansion is client-side with `ical-expander`.

### Thunderbird Desktop (`calendar/`)

- `calICalendar` provider abstraction; `calICalendarManager` singleton registry.
- `calICompositeCalendar` aggregates selected calendars per window.
- Calendar list pane (`calendar-management.js`) uses checkboxes, color swatches, and context menus.
- Providers registered statically (`components.conf`) or dynamically (`registerCalendarProvider`).

We will adopt the Thunderbird-style "composite" pattern (aggregate visible calendars) while keeping the Mailspring-style ICS storage we already have.

## Scope and assumptions

Because clarification questions went unanswered, the following defaults are used:

- **Calendar list pane only** in this slice. A mini-month date picker can be added later as a plugin in `calendar:pane:footer`.
- **Local/default calendars only** to populate the pane. CalDAV/Google/EAS calendar discovery is out of scope, though the schema already supports them via the `provider` column.
- **Independent calendar pane toggle** so the calendar pane does not share visibility/state with the mail folder pane.

## Implementation

### 1. Backend — calendars module and migration

Create `kylins.client.backend/src/db/calendars.rs`:

- `Calendar` DTO matching the existing `calendars` table.
- `UpsertCalendarInput` for create/update.
- Functions: `list_all`, `list_for_account`, `get_by_id`, `insert`, `update`, `delete`, `set_visible`, `set_primary`, `seed_default_for_account`.
- `insert` generates `id` and `remote_id`, defaults `provider='local'`, picks a deterministic color, and sets `is_visible=true`.
- `set_primary` clears `is_primary` on the account's other calendars first.
- `seed_default_for_account` inserts a primary local calendar if the account has none.

Register it in `kylins.client.backend/src/db/mod.rs` (`pub mod calendars;`).

Create migration `kylins.client.backend/migrations/20260706000001_calendar_defaults.sql`:

- Seed a primary local calendar for every account that has none.
- Backfill `calendar_events.calendar_id` for rows where it is null, pointing them at the account's primary calendar.

Modify `kylins.client.backend/src/db/accounts.rs` to call `calendars::seed_default_for_account(pool, &id).await` after creating a new account.

### 2. Backend — IPC commands

Add to `kylins.client.backend/src/db/commands.rs`:

- `db_get_all_calendars`
- `db_get_calendars_for_account`
- `db_get_calendar_by_id`
- `db_create_calendar`
- `db_update_calendar`
- `db_delete_calendar`
- `db_set_calendar_visible`
- `db_set_primary_calendar`

Register them in `kylins.client.backend/src/lib.rs`.

### 3. Backend — query events by selected calendars

Add `calendar_events::list_in_range_for_calendars(pool, calendar_ids, range_start, range_end)` in `kylins.client.backend/src/db/calendar_events.rs` using a dynamic `IN (...)` query.

Add IPC command `db_get_calendar_events_in_range_for_calendars` and register it.

### 4. Frontend services

Create `kylins.client.frontend/src/services/db/calendars.ts` with a `DbCalendar` interface and wrappers for all new commands.

Modify `kylins.client.frontend/src/services/db/calendarEvents.ts` to add `getCalendarEventsInRangeForCalendars(calendarIds, rangeStart, rangeEnd)`.

### 5. Frontend store

Modify `kylins.client.frontend/src/stores/calendarStore.ts`:

- Add `calendars`, `visibleCalendarIds: Set<string>`, and `loadingCalendars`.
- `loadCalendars()` fetches all calendars and initializes `visibleCalendarIds` from `is_visible`.
- `loadOccurrences(rangeStart, rangeEnd)` uses `visibleCalendarIds`, calls `getCalendarEventsInRangeForCalendars`, and expands via `recurrenceExpander`.
- Add `toggleCalendarVisibility`, `createCalendar`, `updateCalendar`, `deleteCalendar`, `setPrimaryCalendar` that mutate the backend and reload the list.

### 6. Recurrence / ICS — attach calendar metadata

Modify `kylins.client.frontend/src/services/calendar/icalHelper.ts`:

- Extend `Occurrence` with `eventId`, `calendarId`, `color`.

Modify `kylins.client.frontend/src/services/calendar/recurrenceExpander.ts`:

- Extend `StoredVEvent` with `id`, `calendarId`, `color`.
- Map metadata onto each expanded occurrence.

### 7. View state — independent calendar pane toggle

Modify the view state layer:

- `src/features/view/types.ts`: add `calendarPaneVisible: boolean` and `calendarPaneSize: number`.
- `src/features/view/defaults.ts`: add defaults (`true` and `22`).
- `src/features/view/viewStore.ts` and `src/features/view/viewSettings.ts` / `hooks/useViewSettings.ts`: add setters and persistence.

### 8. Layout — resizable calendar pane

Create `kylins.client.frontend/src/components/layout/FolderPaneDrawer.tsx` by extracting the `FolderPaneDrawer` component from `ReadingPaneLayout.tsx`.

Modify `ReadingPaneLayout.tsx` to import the shared drawer.

Create `kylins.client.frontend/src/features/view/components/CalendarLayout.tsx`:

- Two-panel `react-resizable-panels` layout (folder pane + calendar content).
- Supports compact-width drawer.
- Reads/writes `calendarPaneVisible` and `calendarPaneSize`.

Modify `kylins.client.frontend/src/components/layout/AppShell.tsx`:

- When `activeApp === 'calendar'`, render `<CalendarLayout folderPane={<CalendarPane />}><CalendarPage /></CalendarLayout>`.

### 9. Calendar folder pane UI

Create `kylins.client.frontend/src/components/calendar/CalendarPane.tsx`:

- Header: title "Calendars", "New calendar" button for the active account, and `InjectedComponentSet role="calendar:pane:header"`.
- Body: scrollable account groups using `Disclosure`; each row has a visibility checkbox, color swatch, calendar name, and "Default" badge.
- Context menu: Rename, Change color, Set as default, Delete.
- Footer: `InjectedComponentSet role="calendar:pane:footer"`.
- Empty state when no calendars exist.

### 10. Calendar toolbar and page

Modify `CalendarToolbar.tsx`:

- Add a calendar-pane toggle button.
- Add `InjectedComponentSet role="calendar:toolbar:actions"`.

Modify `CalendarPage.tsx`:

- Call `loadCalendars()` on mount.
- Update reload effect to depend on `currentDate`, `view`, and the visible-calendar set.

### 11. Event creation

Modify `EventCreateModal.tsx`:

- Add a calendar selector listing visible calendars for the active account, defaulting to the primary.
- Pass `calendarId` to `insertCalendarEvent`.
- Disable saving if no calendar exists.

### 12. View coloring

Modify `EventCard.tsx` and any chips in `MonthView`/`WeekView`/`DayView`/`AgendaView` to use `occurrence.color` for the accent, falling back to `--primary`.

### 13. Plugin slots

Introduce three new roles:

- `calendar:pane:header`
- `calendar:pane:footer`
- `calendar:toolbar:actions`

Render them via `InjectedComponentSet` in the appropriate components.

## Verification

- **Backend:** `cargo test -p kylins-client-backend` covering calendars CRUD, primary/visibility logic, event query filtered by calendar IDs, and migration idempotency/backfill.
- **Frontend:** `npm run test` with new tests for `recurrenceExpander` metadata propagation and `calendarStore` multi-calendar aggregation.
- **Manual:** run `cargo tauri dev` from `kylins.client.backend/` and verify:
  1. Opening Calendar shows a default local calendar in the pane.
  2. Created events render with the calendar color.
  3. A second calendar can be created and its events shown/hidden independently.
  4. Primary-calendar changes affect the default target for new events.
  5. Rename, color change, and delete work via context menu.
  6. Pane size and visibility persist across reloads.
  7. Compact width collapses the pane into a drawer.

## Critical files

- `kylins.client.backend/src/db/calendars.rs` (new)
- `kylins.client.backend/src/db/calendar_events.rs`
- `kylins.client.backend/src/db/commands.rs`
- `kylins.client.backend/src/db/accounts.rs`
- `kylins.client.backend/src/db/mod.rs`
- `kylins.client.backend/src/lib.rs`
- `kylins.client.backend/migrations/20260706000001_calendar_defaults.sql` (new)
- `kylins.client.frontend/src/services/db/calendars.ts` (new)
- `kylins.client.frontend/src/services/db/calendarEvents.ts`
- `kylins.client.frontend/src/services/calendar/icalHelper.ts`
- `kylins.client.frontend/src/services/calendar/recurrenceExpander.ts`
- `kylins.client.frontend/src/stores/calendarStore.ts`
- `kylins.client.frontend/src/features/view/types.ts`
- `kylins.client.frontend/src/features/view/defaults.ts`
- `kylins.client.frontend/src/features/view/viewStore.ts`
- `kylins.client.frontend/src/features/view/viewSettings.ts`
- `kylins.client.frontend/src/features/view/hooks/useViewSettings.ts`
- `kylins.client.frontend/src/features/view/components/CalendarLayout.tsx` (new)
- `kylins.client.frontend/src/features/view/components/ReadingPaneLayout.tsx`
- `kylins.client.frontend/src/components/layout/FolderPaneDrawer.tsx` (new, extracted)
- `kylins.client.frontend/src/components/layout/AppShell.tsx`
- `kylins.client.frontend/src/components/calendar/CalendarPane.tsx` (new)
- `kylins.client.frontend/src/components/calendar/CalendarToolbar.tsx`
- `kylins.client.frontend/src/components/calendar/CalendarPage.tsx`
- `kylins.client.frontend/src/components/calendar/EventCreateModal.tsx`
- `kylins.client.frontend/src/components/calendar/EventCard.tsx`

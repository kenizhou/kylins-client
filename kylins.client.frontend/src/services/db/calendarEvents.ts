// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// CRUD over the `calendar_events` table. The table is Google-shaped but carries
// `ical_data` / `uid` / `etag` (migrations) so it can store any provider's VEVENT
// verbatim; `recurrence_start`/`recurrence_end` (migration v28) allow fast range
// queries without expanding ICS. Rows are parsed by the calendar layer via
// `icalHelper` for display.
//
// Task 5 (Option C) clean-cut cutover: every function delegates to a Rust
// `db_*` Tauri command (see `kylins.client.backend/src/db/calendar_events.rs`).
// Rust returns raw snake_case `DbCalendarEvent` rows (matching the historical
// TS interface).

import { invoke } from '@tauri-apps/api/core';

export interface DbCalendarEvent {
  id: string;
  account_id: string;
  google_event_id: string | null;
  calendar_id: string | null;
  remote_event_id: string | null;
  uid: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  start_time: number;
  end_time: number;
  is_all_day: number;
  status: string | null;
  organizer_email: string | null;
  attendees_json: string | null;
  ical_data: string | null;
  etag: string | null;
  recurrence_start: number | null;
  recurrence_end: number | null;
  updated_at: number;
}

export async function getCalendarEventsForAccount(accountId: string): Promise<DbCalendarEvent[]> {
  return invoke<DbCalendarEvent[]>('db_get_calendar_events_for_account', { accountId });
}

/**
 * Events possibly visible in a range. A row is included if its single occurrence
 * overlaps the range OR its `recurrence_start`/`recurrence_end` window overlaps
 * (recurring series). The caller expands recurrence via `icalHelper`.
 */
export async function getCalendarEventsInRange(
  accountId: string,
  rangeStart: number,
  rangeEnd: number,
): Promise<DbCalendarEvent[]> {
  return invoke<DbCalendarEvent[]>('db_get_calendar_events_in_range', {
    accountId,
    rangeStart,
    rangeEnd,
  });
}

export async function getCalendarEventsInRangeForCalendars(
  calendarIds: string[],
  rangeStart: number,
  rangeEnd: number,
): Promise<DbCalendarEvent[]> {
  return invoke<DbCalendarEvent[]>('db_get_calendar_events_in_range_for_calendars', {
    calendarIds,
    rangeStart,
    rangeEnd,
  });
}

export async function getCalendarEventById(id: string): Promise<DbCalendarEvent | null> {
  return invoke<DbCalendarEvent | null>('db_get_calendar_event_by_id', { id });
}

export interface UpsertCalendarEventInput {
  id?: string;
  accountId: string;
  googleEventId?: string | null;
  calendarId?: string | null;
  remoteEventId?: string | null;
  uid?: string | null;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  startTime: number;
  endTime: number;
  isAllDay: boolean;
  status?: string | null;
  organizerEmail?: string | null;
  attendeesJson?: string | null;
  icalData?: string | null;
  etag?: string | null;
  recurrenceStart?: number | null;
  recurrenceEnd?: number | null;
}

/** Insert a new calendar event, returning its id. */
export async function insertCalendarEvent(input: UpsertCalendarEventInput): Promise<string> {
  return invoke<string>('db_insert_calendar_event', { input });
}

/** Update mutable fields of a calendar event. */
export async function updateCalendarEvent(
  id: string,
  updates: Partial<Omit<UpsertCalendarEventInput, 'id' | 'accountId'>>,
): Promise<void> {
  await invoke<void>('db_update_calendar_event', { id, updates });
}

export async function deleteCalendarEvent(id: string): Promise<void> {
  await invoke<void>('db_delete_calendar_event', { id });
}

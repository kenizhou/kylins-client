// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// CRUD over the `calendar_events` table. The table is Google-shaped but carries
// `ical_data` / `uid` / `etag` (migrations) so it can store any provider's VEVENT
// verbatim; `recurrence_start`/`recurrence_end` (migration v28) allow fast range
// queries without expanding ICS. Rows are parsed by the calendar layer via
// `icalHelper` for display.

import { getDb, buildDynamicUpdate, selectFirstBy, boolToInt } from '@/services/db/connection';

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
  const db = await getDb();
  return db.select<DbCalendarEvent[]>('SELECT * FROM calendar_events WHERE account_id = $1', [
    accountId,
  ]);
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
  const db = await getDb();
  return db.select<DbCalendarEvent[]>(
    `SELECT * FROM calendar_events
     WHERE account_id = $1 AND (
       (start_time <= $3 AND end_time >= $2)
       OR (recurrence_start IS NOT NULL AND recurrence_end IS NOT NULL
           AND recurrence_start <= $3 AND recurrence_end >= $2)
     )
     ORDER BY start_time ASC`,
    [accountId, rangeStart, rangeEnd],
  );
}

export async function getCalendarEventById(id: string): Promise<DbCalendarEvent | null> {
  return selectFirstBy<DbCalendarEvent>('SELECT * FROM calendar_events WHERE id = $1', [id]);
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
  const db = await getDb();
  const id = input.id ?? crypto.randomUUID();
  await db.execute(
    `INSERT INTO calendar_events
     (id, account_id, google_event_id, calendar_id, remote_event_id, uid, summary,
      description, location, start_time, end_time, is_all_day, status, organizer_email,
      attendees_json, ical_data, etag, recurrence_start, recurrence_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      id,
      input.accountId,
      // google_event_id is NOT NULL (Google-shaped schema). Provider-agnostic
      // events (CalDAV/EAS/local) carry no Google id; fall back to uid/id. The
      // proper fix (nullable column + UNIQUE(account_id, uid)) is migration work
      // landed with EAS calendar sync — see plan §6/Phase 5.
      input.googleEventId ?? input.uid ?? id,
      input.calendarId ?? null,
      input.remoteEventId ?? null,
      input.uid ?? null,
      input.summary ?? null,
      input.description ?? null,
      input.location ?? null,
      input.startTime,
      input.endTime,
      boolToInt(input.isAllDay),
      input.status ?? null,
      input.organizerEmail ?? null,
      input.attendeesJson ?? null,
      input.icalData ?? null,
      input.etag ?? null,
      input.recurrenceStart ?? null,
      input.recurrenceEnd ?? null,
    ],
  );
  return id;
}

/** Update mutable fields of a calendar event. */
export async function updateCalendarEvent(
  id: string,
  updates: Partial<Omit<UpsertCalendarEventInput, 'id' | 'accountId'>>,
): Promise<void> {
  const db = await getDb();
  const fields: [string, unknown][] = [];
  const map: Record<string, unknown> = {
    summary: updates.summary,
    description: updates.description,
    location: updates.location,
    start_time: updates.startTime,
    end_time: updates.endTime,
    is_all_day: updates.isAllDay === undefined ? undefined : boolToInt(updates.isAllDay),
    status: updates.status,
    organizer_email: updates.organizerEmail,
    attendees_json: updates.attendeesJson,
    ical_data: updates.icalData,
    etag: updates.etag,
    recurrence_start: updates.recurrenceStart,
    recurrence_end: updates.recurrenceEnd,
    calendar_id: updates.calendarId,
    remote_event_id: updates.remoteEventId,
    uid: updates.uid,
  };
  for (const [col, val] of Object.entries(map)) {
    if (val !== undefined) fields.push([col, val]);
  }
  const query = buildDynamicUpdate('calendar_events', 'id', id, fields);
  if (query) await db.execute(query.sql, query.params);
}

export async function deleteCalendarEvent(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM calendar_events WHERE id = $1', [id]);
}

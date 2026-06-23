// SEAM — iCalendar (RFC 5545 / 5546) handling contract.
//
// All calendar code in Kylins calls these functions; nothing imports ical.js
// directly. This keeps the parser/serializer swappable.
//
// Phase 3 implementation: backed by ical.js + ical-expander (ported in spirit
// from Mailspring's calendar-utils.ts + ics-event-helpers.ts), giving full
// RRULE recurrence expansion, EXDATE/RDATE, METHOD (REQUEST/REPLY/CANCEL),
// attendees/organizer, and RFC 5546 single-attendee REPLY construction — none
// of which a hand-rolled parser handles correctly.
//
// See docs/superpowers/plans/2026-06-23-frontend-components-composer-viewer-calendar.md §6.1.

import ICAL from 'ical.js';
import type {
  Time as IcalTime,
  Property as IcalProperty,
  Component as IcalComponent,
  Recur as IcalRecur,
} from 'ical.js';
import IcalExpander from 'ical-expander';

export type IcsMethod =
  | 'PUBLISH'
  | 'REQUEST'
  | 'REPLY'
  | 'ADD'
  | 'CANCEL'
  | 'REFRESH'
  | 'COUNTER'
  | 'DECLINECOUNTER';

export type PartStat = 'NEEDS-ACTION' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'DELEGATED';

export interface ParsedAttendee {
  email: string;
  name?: string;
  partstat?: PartStat;
  role?: string;
  rsvp?: boolean;
}

export interface ParsedOrganizer {
  email: string;
  name?: string;
}

export interface ParsedEvent {
  uid: string;
  summary?: string;
  description?: string;
  location?: string;
  start: Date;
  end?: Date;
  allDay: boolean;
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  organizer?: ParsedOrganizer;
  attendees: ParsedAttendee[];
  /** Raw RRULE string, e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=2". */
  recurrenceRule?: string;
  /** Excluded dates from the recurrence series. */
  exdates?: Date[];
  /** tzid for start/end (undefined ⇒ floating or UTC `Z`). */
  timezone?: string;
  /** iMIP method — distinguishes invites (REQUEST) from replies (REPLY), etc. */
  method?: IcsMethod;
  /** Revision sequence number. */
  sequence?: number;
}

export interface Occurrence {
  uid: string;
  /** Set when this is a specific instance of a recurring series. */
  recurrenceId?: Date;
  start: Date;
  end?: Date;
  allDay: boolean;
  /** True if this occurrence is an overridden exception. */
  isException?: boolean;
}

export interface DateRange {
  start: Date;
  end: Date;
}

/** Input shape for ICS generation. */
export interface GenerateIcsInput {
  uid: string;
  summary?: string;
  description?: string;
  location?: string;
  start: Date;
  end?: Date;
  allDay?: boolean;
  status?: ParsedEvent['status'];
  organizer?: ParsedOrganizer;
  attendees?: ParsedAttendee[];
  recurrenceRule?: string;
  timezone?: string;
  method?: IcsMethod;
  sequence?: number;
}

/** Coerce an ical.js value (ICAL.Time or string) to a JS Date, or null. */
function toJsDate(value: unknown): Date | null {
  if (value && typeof (value as { toJSDate?: unknown }).toJSDate === 'function') {
    return (value as IcalTime).toJSDate();
  }
  return null;
}

/** Extract a bare email from a mailto: property value. */
function personEmail(prop: IcalProperty): string {
  const raw = prop.getFirstValue();
  return typeof raw === 'string' ? raw.replace(/^mailto:/i, '') : '';
}

function parseAttendee(prop: IcalProperty): ParsedAttendee {
  const partstat = prop.getParameter('partstat') as PartStat | undefined;
  const role = prop.getParameter('role') ?? undefined;
  const rsvpRaw = prop.getParameter('rsvp');
  return {
    email: personEmail(prop),
    name: prop.getParameter('cn') ?? undefined,
    partstat,
    role,
    rsvp: rsvpRaw === undefined ? undefined : rsvpRaw.toUpperCase() === 'TRUE',
  };
}

function parseOrganizer(prop: IcalProperty): ParsedOrganizer {
  return { email: personEmail(prop), name: prop.getParameter('cn') ?? undefined };
}

function toGenInput(ev: ParsedEvent): GenerateIcsInput {
  return {
    uid: ev.uid,
    summary: ev.summary,
    description: ev.description,
    location: ev.location,
    start: ev.start,
    end: ev.end,
    allDay: ev.allDay,
    status: ev.status,
    organizer: ev.organizer,
    attendees: ev.attendees,
    recurrenceRule: ev.recurrenceRule,
    timezone: ev.timezone,
    method: ev.method,
    sequence: ev.sequence,
  };
}

export const IcalHelper = {
  /** Parse one or more VEVENTs (and the VCALENDAR METHOD) from an ICS string. */
  parseEvents(ics: string): ParsedEvent[] {
    let jcal: unknown;
    try {
      jcal = ICAL.parse(ics);
    } catch {
      return [];
    }
    const root = new ICAL.Component(jcal as unknown[]);
    const method = root.getFirstPropertyValue('method') as IcsMethod | null;
    const vevents = root.getAllSubcomponents('vevent');
    if (!vevents || vevents.length === 0) return [];

    return vevents.map((ve) => {
      const ev = new ICAL.Event(ve);
      const orgProp = ve.getFirstProperty('organizer');
      const organizer = orgProp ? parseOrganizer(orgProp) : undefined;
      const attendees = ve.getAllProperties('attendee').map(parseAttendee);
      const exdates = ve
        .getAllProperties('exdate')
        .map((p) => toJsDate(p.getFirstValue()))
        .filter((d): d is Date => d !== null);
      const status = ve.getFirstPropertyValue('status') as ParsedEvent['status'] | undefined;
      const sequenceRaw = ve.getFirstPropertyValue('sequence');
      const sequence = typeof sequenceRaw === 'number' ? sequenceRaw : undefined;
      const tzid = ve.getFirstProperty('dtstart')?.getParameter('tzid');
      // ICAL.Event has no `rrule` accessor — read it from the component.
      const rruleRaw = ve.getFirstPropertyValue('rrule') as IcalRecur | null;

      return {
        uid: ev.uid,
        summary: ev.summary || undefined,
        description: ev.description || undefined,
        location: ev.location || undefined,
        start: ev.startDate ? ev.startDate.toJSDate() : new Date(NaN),
        end: ev.endDate ? ev.endDate.toJSDate() : undefined,
        allDay: ev.startDate?.isDate ?? false,
        status: status ?? undefined,
        organizer,
        attendees,
        recurrenceRule: rruleRaw ? rruleRaw.toString() : undefined,
        exdates,
        timezone: tzid ?? undefined,
        method: method ?? undefined,
        sequence,
      };
    });
  },

  /** Serialize an event to a VCALENDAR/VEVENT ICS string (RFC 5545). */
  generateICS(input: GenerateIcsInput): string {
    const root = new ICAL.Component('vcalendar');
    root.updatePropertyWithValue('prodid', '-//Kylins Client//Calendar//EN');
    root.updatePropertyWithValue('version', '2.0');
    if (input.method) root.updatePropertyWithValue('method', input.method);

    const ve = new ICAL.Component('vevent');
    const event = new ICAL.Event(ve);
    event.uid = input.uid;
    if (input.summary) event.summary = input.summary;
    if (input.description) event.description = input.description;
    if (input.location) event.location = input.location;

    const allDay = input.allDay ?? false;
    event.startDate = ICAL.Time.fromJSDate(input.start, allDay);
    if (input.end) {
      event.endDate = ICAL.Time.fromJSDate(input.end, allDay);
    } else if (allDay) {
      const next = ICAL.Time.fromJSDate(input.start, true);
      next.adjust(1, 0, 0, 0);
      event.endDate = next;
    }
    if (input.recurrenceRule) {
      // `event.rrule =` does not persist (getter-only); write the property directly.
      ve.updatePropertyWithValue('rrule', ICAL.Recur.fromString(input.recurrenceRule));
    }
    if (input.status) ve.updatePropertyWithValue('status', input.status);
    if (input.sequence !== undefined) event.seq = input.sequence;
    // TODO (§6.1): emit a full VTIMEZONE block for fidelity; for now a bare TZID.
    if (input.timezone) {
      ve.getFirstProperty('dtstart')?.setParameter('tzid', input.timezone);
    }
    if (input.organizer) {
      const org = new ICAL.Property('organizer', ve);
      org.setValue(`mailto:${input.organizer.email}`);
      if (input.organizer.name) org.setParameter('cn', input.organizer.name);
      ve.addProperty(org);
    }
    for (const a of input.attendees ?? []) {
      const ap = new ICAL.Property('attendee', ve);
      ap.setValue(`mailto:${a.email}`);
      if (a.name) ap.setParameter('cn', a.name);
      if (a.partstat) ap.setParameter('partstat', a.partstat);
      if (a.role) ap.setParameter('role', a.role);
      if (a.rsvp !== undefined) ap.setParameter('rsvp', a.rsvp ? 'TRUE' : 'FALSE');
      ve.addProperty(ap);
    }
    root.addSubcomponent(ve);
    return root.toString();
  },

  /** Expand recurring events into concrete occurrences within a range. */
  expandOccurrences(events: ParsedEvent[], range: DateRange): Occurrence[] {
    const out: Occurrence[] = [];
    for (const ev of events) {
      const ics = this.generateICS(toGenInput(ev));
      let res: ReturnType<IcalExpander['between']>;
      try {
        const expander = new IcalExpander({ ics, maxIterations: 500 });
        res = expander.between(range.start, range.end);
      } catch {
        continue;
      }
      for (const e of res.events) {
        if (!e.startDate) continue;
        out.push({
          uid: ev.uid,
          start: e.startDate.toJSDate(),
          end: e.endDate ? e.endDate.toJSDate() : undefined,
          allDay: e.startDate.isDate,
        });
      }
      for (const o of res.occurrences) {
        out.push({
          uid: ev.uid,
          start: o.startDate.toJSDate(),
          end: o.endDate ? o.endDate.toJSDate() : undefined,
          allDay: o.startDate.isDate,
          recurrenceId: o.recurrenceId ? o.recurrenceId.toJSDate() : undefined,
          isException: o.recurrenceId !== null,
        });
      }
    }
    return out;
  },

  /** Build an inline RECURRENCE-ID exception on a recurring master (RFC 4791 §4.1). */
  createRecurrenceException(
    masterIcs: string,
    recurrenceId: Date,
    patchedEvent: GenerateIcsInput,
  ): string {
    let root: IcalComponent;
    try {
      root = new ICAL.Component(ICAL.parse(masterIcs) as unknown[]);
    } catch {
      return masterIcs;
    }

    const allDay = patchedEvent.allDay ?? false;
    const ve = new ICAL.Component('vevent');
    const event = new ICAL.Event(ve);
    event.uid = patchedEvent.uid;
    if (patchedEvent.summary) event.summary = patchedEvent.summary;
    if (patchedEvent.description) event.description = patchedEvent.description;
    if (patchedEvent.location) event.location = patchedEvent.location;
    event.startDate = ICAL.Time.fromJSDate(patchedEvent.start, allDay);
    if (patchedEvent.end) event.endDate = ICAL.Time.fromJSDate(patchedEvent.end, allDay);
    if (patchedEvent.status) ve.updatePropertyWithValue('status', patchedEvent.status);

    const ridProp = new ICAL.Property('recurrence-id', ve);
    ridProp.setValue(ICAL.Time.fromJSDate(recurrenceId, allDay));
    ve.addProperty(ridProp);

    root.addSubcomponent(ve);
    return root.toString();
  },
};

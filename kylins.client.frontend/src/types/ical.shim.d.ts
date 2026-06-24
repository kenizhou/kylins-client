// Local ambient types for ical.js. The package ships no TypeScript definitions
// and @types/ical.js could not be fetched in this environment, so we model the
// API surface used by services/calendar/icalHelper.ts here.
//
// ical.js exposes `ICAL.Event` (and friends) as BOTH a value (constructor) and a
// type (instance). The const+namespace merge below mirrors that, which is what
// ical-expander's bundled index.d.ts relies on (`ICAL.Event['getOccurrenceDetails']`).
//
// NOTE: if @types/ical.js is ever installed, delete this file to avoid a conflict.

declare module 'ical.js' {
  export class Time {
    isDate: boolean;
    timezone: string;
    toJSDate(): Date;
    compare(other: Time): number;
    adjust(days: number, hours: number, minutes: number, seconds: number): void;
  }

  export class Property {
    getFirstValue(): unknown;
    getValues(): unknown[];
    getParameter(name: string): string | undefined;
    setParameter(name: string, value: string): void;
    setValue(value: unknown): void;
  }

  export class Component {
    constructor(input: string | unknown[]);
    getFirstSubcomponent(name: string): Component | null;
    getAllSubcomponents(name: string): Component[];
    getFirstProperty(name: string): Property | null;
    getAllProperties(name: string): Property[];
    addProperty(prop: Property): void;
    getFirstPropertyValue(name: string): unknown;
    updatePropertyWithValue(name: string, value: unknown): void;
    addSubcomponent(comp: Component): void;
    toString(): string;
  }

  export interface OccurrenceDetails {
    startDate: Time;
    endDate: Time;
    recurrenceId: Time | null;
  }

  export class Event {
    constructor(comp: Component);
    uid: string;
    summary: string;
    description: string;
    location: string;
    seq: number;
    startDate: Time | null;
    endDate: Time | null;
    rrule: unknown;
    attendees: Property[];
    organizer: Property | null;
    isRecurring(): boolean;
    iterator(start: Time): { next(): Time | null };
    getOccurrenceDetails(time: Time): OccurrenceDetails;
  }

  export class Recur {
    static fromString(s: string): Recur;
    toString(): string;
  }

  const ICAL: {
    parse(ics: string): unknown;
    Component: typeof Component;
    Event: typeof Event;
    Time: typeof Time & { fromJSDate(date: Date, isDate?: boolean): Time };
    Property: typeof Property & { new (name: string, parent?: Component): Property };
    Recur: typeof Recur;
  };

  namespace ICAL {
    export { Time, Property, Component, Event, Recur, OccurrenceDetails };
  }

  export default ICAL;
}

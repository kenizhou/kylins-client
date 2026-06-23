// Recurrence expansion pipeline (Mailspring occurrencesForEvents pattern).
//
// Bridges stored calendar rows (each carrying `ical_data`) to concrete rendered
// occurrences within a visible range, via the icalHelper seam. Views consume the
// output: one master event may produce many occurrence chips.

import { IcalHelper, type Occurrence, type DateRange } from './icalHelper';

/** A stored row that carries the raw ICS for a VEVENT. */
export interface StoredVEvent {
  uid: string;
  icalData: string | null;
}

/**
 * Parse the ICS of each stored row and expand recurring series into concrete
 * occurrences within `range`. Rows without `ical_data` are skipped.
 */
export function expandStoredEvents(rows: StoredVEvent[], range: DateRange): Occurrence[] {
  const parsed = rows.flatMap((r) => (r.icalData ? IcalHelper.parseEvents(r.icalData) : []));
  return IcalHelper.expandOccurrences(parsed, range);
}

export { IcalHelper };

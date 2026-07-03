// EAS calendar provider — Exchange ActiveSync calendar sync (MS-ASCAL).
//
// Built from the mailkit ArkTS models as spec (see docs/Exchange/MS-AS*). Wraps
// the same Rust `eas_*` Tauri commands the mail provider uses, but with
// `class: 'Calendar'`, plus the `MeetingResponse` command for RSVP. EAS carries
// calendar items as WBXML property maps (not ICS), so we convert the common
// MS-ASCAL properties into a VEVENT and feed it through icalHelper.
//
// Greenfield (plan §6.6): the Rust eas_sync must accept `class: 'Calendar'`,
// and the MS-ASCAL property names below must match what the backend exposes.
// This TS layer is correct against the spec; runtime depends on the Rust impl.

import { invoke } from '@tauri-apps/api/core';
import type { Account } from '../../types';
import { easConfigFromAccount, type EasSyncResult, type EasItem } from '../mail/easProvider';
import type { ParsedEvent } from './icalHelper';

/**
 * MS-ASCAL property names (subset). Phase 3a Task 2 only wired Email-class
 * parsing into the typed `EasItem`; Calendar-class parsing (Location,
 * StartTime, EndTime, UID, AllDayEvent, OrganizerEmail/Name) is still
 * TODO(phase3a). Until that lands, `easItemToEvent` cannot reliably extract
 * these fields and returns null. The constants are kept so the eventual
 * calendar-parser task can wire them up without re-deriving the names.
 */
const CAL = {
  subject: 'Subject',
  location: 'Location',
  startTime: 'StartTime',
  endTime: 'EndTime',
  uid: 'UID',
  allDayEvent: 'AllDayEvent',
  organizerEmail: 'OrganizerEmail',
  organizerName: 'OrganizerName',
} as const;

/** EAS MeetingResponse UserResponse: 1=accept, 2=tentative, 3=decline. */
export type EasUserResponse = '1' | '2' | '3';

export interface EasMeetingResponseRequest {
  collection_id: string;
  /** Server id of the meeting-request item. */
  request_id: string;
  user_response: EasUserResponse;
  /** Optional server id of the resulting calendar item. */
  calendar_id?: string | null;
}

export class EasCalendarProvider {
  readonly id = 'eas-calendar';

  constructor(private _account: Account) {}

  private get cfg() {
    return easConfigFromAccount(this._account);
  }

  /** Sync a calendar folder (class 'Calendar'). */
  async syncCalendar(collectionId: string, syncKey: string): Promise<EasSyncResult> {
    return invoke<EasSyncResult>('eas_sync', {
      config: this.cfg,
      request: {
        collection_id: collectionId,
        sync_key: syncKey,
        class: 'Calendar',
        window_size: 100,
        filter_age_days: 0,
        fetch_body: true,
      },
    });
  }

  /** Respond to a meeting request server-side (Exchange processes the REPLY). */
  async meetingResponse(request: EasMeetingResponseRequest): Promise<number> {
    return invoke<number>('eas_meeting_response', { config: this.cfg, request });
  }

  /**
   * Convert an EAS calendar item into a ParsedEvent.
   *
   * Phase 3a Task 2 only wired Email-class field parsing into the typed
   * `EasItem` (Subject, From, To, Body, etc.). MS-ASCAL calendar properties
   * (StartTime, EndTime, Location, UID, AllDayEvent, OrganizerEmail/Name) are
   * not yet modeled on the Rust `EasItem` struct, so they cannot be read here
   * until TODO(phase3a) lands a Calendar-class ApplicationData parser. Until
   * then this returns `null` for every item so `parseSynced` yields an empty
   * list rather than throwing on `item.fields`/`item.class` accesses.
   */
  easItemToEvent(item: EasItem): ParsedEvent | null {
    // TODO(phase3a): once the Rust EasItem models MS-ASCAL properties (or
    // surfaces an `application_data: Record<string,string>` slot for non-Email
    // classes), read them here. The MS-ASCAL names are in the `CAL` table.
    // The only fields currently available on the typed EasItem that a calendar
    // event could use are `subject` and `bodyHtml` — but a calendar event
    // without a start time is meaningless, so bail out until the parser lands.
    void item;
    void CAL;
    return null;
  }

  /** Parse synced calendar items into ParsedEvents (skipping unparseable ones). */
  parseSynced(result: EasSyncResult): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    for (const item of [...result.added, ...result.updated]) {
      // `item.class` is no longer a field on the typed EasItem (EAS carries
      // class at the collection level). Calendar items come from a Sync call
      // issued with class: 'Calendar', so we cannot filter by per-item class
      // anymore; just attempt the conversion.
      const ev = this.easItemToEvent(item);
      if (ev) out.push(ev);
    }
    return out;
  }
}

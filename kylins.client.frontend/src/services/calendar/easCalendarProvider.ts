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

/** MS-ASCAL property names (subset) as returned in `EasItem.fields`. */
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
   * Convert an EAS calendar item (MS-ASCAL property map) into a VEVENT ICS, then
   * parse it. Returns null if the item lacks a start time.
   */
  easItemToEvent(item: EasItem): ParsedEvent | null {
    const f = item.fields;
    const start = f[CAL.startTime];
    const end = f[CAL.endTime];
    if (!start) return null;
    // Build the ParsedEvent directly from the MS-ASCAL field map — the EAS item
    // is already a flat property map, so a generate-then-parse ICS round-trip is
    // wasted work on the sync hot path.
    return {
      uid: f[CAL.uid] ?? item.server_id,
      summary: f[CAL.subject] || undefined,
      description: item.body ?? undefined,
      location: f[CAL.location] ?? undefined,
      start: new Date(start),
      end: end ? new Date(end) : undefined,
      allDay: f[CAL.allDayEvent] === '1',
      organizer: f[CAL.organizerEmail]
        ? { email: f[CAL.organizerEmail] as string, name: f[CAL.organizerName] ?? undefined }
        : undefined,
      attendees: [],
    };
  }

  /** Parse synced calendar items into ParsedEvents (skipping unparseable ones). */
  parseSynced(result: EasSyncResult): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    for (const item of [...result.added, ...result.updated]) {
      if (item.class !== 'Calendar') continue;
      const ev = this.easItemToEvent(item);
      if (ev) out.push(ev);
    }
    return out;
  }
}

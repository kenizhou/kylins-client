// Quick event-create modal. Builds a VEVENT via icalHelper and persists it
// (with its ical_data) to calendar_events; the calendar store re-expands.

import { useState } from 'react';
import { IcalHelper } from '@/services/calendar/icalHelper';
import { insertCalendarEvent } from '@/services/db/calendarEvents';
import { toUnixSeconds } from './range';

interface EventCreateModalProps {
  accountId: string;
  onClose: () => void;
  onCreated: () => void;
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function EventCreateModal({ accountId, onClose, onCreated }: EventCreateModalProps) {
  const now = new Date();
  const [summary, setSummary] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [start, setStart] = useState(toLocalInput(now));
  const [end, setEnd] = useState(toLocalInput(new Date(now.getTime() + 3600_000)));
  const [allDay, setAllDay] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!summary.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const startDate = new Date(start);
      const endDate = new Date(end);
      const uid = crypto.randomUUID();
      const ics = IcalHelper.generateICS({
        uid,
        summary,
        description: description || undefined,
        location: location || undefined,
        start: startDate,
        end: endDate,
        allDay,
      });
      await insertCalendarEvent({
        accountId,
        uid,
        summary,
        description: description || null,
        location: location || null,
        startTime: toUnixSeconds(startDate),
        endTime: toUnixSeconds(endDate),
        isAllDay: allDay,
        icalData: ics,
        recurrenceStart: toUnixSeconds(startDate),
        recurrenceEnd: allDay ? null : toUnixSeconds(endDate),
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-96 rounded-md border border-[var(--border)] bg-[var(--background)] p-4 shadow-xl"
      >
        <h3 className="mb-3 text-sm font-semibold text-[var(--foreground)]">New event</h3>
        <div className="space-y-2">
          <input
            type="text"
            placeholder="Title"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className="h-8 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
          />
          <input
            type="text"
            placeholder="Location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="h-8 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
          />
          <label className="flex items-center gap-2 text-xs text-[var(--muted-text)]">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            All day
          </label>
          <div className="flex gap-2">
            <label className="flex-1 text-xs text-[var(--muted-text)]">
              Starts
              <input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="mt-0.5 h-8 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
              />
            </label>
            <label className="flex-1 text-xs text-[var(--muted-text)]">
              Ends
              <input
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="mt-0.5 h-8 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
              />
            </label>
          </div>
          <textarea
            placeholder="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
          />
          {error && <div className="text-xs text-[var(--destructive)]">{error}</div>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="h-8 rounded px-3 text-sm text-[var(--foreground)] hover:bg-[var(--hover)]"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!summary.trim() || saving}
            className="h-8 rounded bg-[var(--primary)] px-3 text-sm text-[var(--primary-fg)] hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

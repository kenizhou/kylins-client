// Quick event-create modal. Builds a VEVENT via icalHelper and persists it
// (with its ical_data) to calendar_events; the calendar store re-expands.

import { useEffect, useRef, useState } from 'react';
import { IcalHelper } from '@/services/calendar/icalHelper';
import { insertCalendarEvent } from '@/services/db/calendarEvents';
import { toUnixSeconds } from './range';
import { CloseIcon } from '../icons';

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

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

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
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="event-modal-title"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--background)] p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 id="event-modal-title" className="text-base font-semibold text-[var(--foreground)]">
            New event
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <input
            type="text"
            placeholder="Title"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)] outline-none transition-colors focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--ring)]"
          />
          <input
            type="text"
            placeholder="Location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)] outline-none transition-colors focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--ring)]"
          />
          <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
            <span className="relative inline-flex h-4 w-7 items-center rounded-full bg-[var(--border)] transition-colors has-[:checked]:bg-[var(--primary)]">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
                className="peer sr-only"
              />
              <span className="ml-0.5 h-3 w-3 rounded-full bg-white transition-transform peer-checked:translate-x-3" />
            </span>
            All day
          </label>
          <div className="flex gap-3">
            <label className="flex-1 text-xs text-[var(--muted-text)]">
              Starts
              <input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none transition-colors focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--ring)]"
              />
            </label>
            <label className="flex-1 text-xs text-[var(--muted-text)]">
              Ends
              <input
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none transition-colors focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--ring)]"
              />
            </label>
          </div>
          <textarea
            placeholder="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none transition-colors focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--ring)]"
          />
          {error && (
            <div className="flex items-center gap-1.5 rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 px-3 py-2 text-xs text-[var(--destructive)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--destructive)]" />
              {error}
            </div>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="h-9 rounded-md px-4 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--hover)]"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!summary.trim() || saving}
            className="flex h-9 items-center gap-1.5 rounded-md bg-[var(--primary)] px-4 text-sm font-medium text-[var(--primary-fg)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && (
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            )}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

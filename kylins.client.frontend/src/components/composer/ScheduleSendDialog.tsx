// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Schedule-send dialog. velo delegates to a shared DateTimePickerDialog;
// Kylins inlines a lean version: three presets (tomorrow AM/PM, next Monday
// AM) plus a native datetime-local picker for a custom time. Timestamps are
// unix seconds (matching the `scheduled_emails.scheduled_at` column).

import { useEffect, useRef, useState } from 'react';
import { CloseIcon } from '../icons';

interface SchedulePreset {
  label: string;
  detail: string;
  timestamp: number;
}

interface ScheduleSendDialogProps {
  onSchedule: (timestamp: number) => void;
  onClose: () => void;
}

function getSchedulePresets(): SchedulePreset[] {
  const now = new Date();

  const at = (offsetDays: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offsetDays);
    d.setHours(hour, 0, 0, 0);
    return d;
  };

  const tomorrowMorning = at(1, 9);
  const tomorrowAfternoon = at(1, 13);

  // Next Monday morning (at least 1 day away).
  const monday = new Date(now);
  const daysUntilMonday = (1 - monday.getDay() + 7) % 7 || 7;
  monday.setDate(monday.getDate() + daysUntilMonday);
  monday.setHours(9, 0, 0, 0);

  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
    ` ${d.getHours() === 9 ? '9:00 AM' : '1:00 PM'}`;

  return [
    {
      label: 'Tomorrow morning',
      detail: fmt(tomorrowMorning),
      timestamp: Math.floor(tomorrowMorning.getTime() / 1000),
    },
    {
      label: 'Tomorrow afternoon',
      detail: fmt(tomorrowAfternoon),
      timestamp: Math.floor(tomorrowAfternoon.getTime() / 1000),
    },
    {
      label: 'Monday morning',
      detail: fmt(monday),
      timestamp: Math.floor(monday.getTime() / 1000),
    },
  ];
}

/** Format a datetime-local string (yyyy-mm-ddThh:mm) into unix seconds. */
function datetimeLocalToUnix(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function ScheduleSendDialog({ onSchedule, onClose }: ScheduleSendDialogProps) {
  const presets = getSchedulePresets();
  const [custom, setCustom] = useState('');
  const customTs = datetimeLocalToUnix(custom);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll(
          'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled')) as HTMLElement[];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey);
    // Focus the first preset button when the dialog opens.
    const firstButton = panelRef.current?.querySelector('button');
    firstButton?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="relative w-80 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 shadow-xl"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
          aria-label="Close"
        >
          <CloseIcon size={14} />
        </button>

        <h3 className="mb-3 pr-6 text-sm font-medium text-[var(--foreground)]">Schedule send</h3>

        <div className="space-y-1">
          {presets.map((p) => (
            <button
              key={p.label}
              onClick={() => onSchedule(p.timestamp)}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-[var(--hover)]"
            >
              <span className="text-[var(--foreground)]">{p.label}</span>
              <span className="text-xs text-[var(--muted-foreground)]">{p.detail}</span>
            </button>
          ))}
        </div>

        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <label className="mb-1 block text-xs text-[var(--muted-text)]">Pick a date & time</label>
          <input
            type="datetime-local"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="h-8 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
          />
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="h-8 rounded px-3 text-sm text-[var(--foreground)] hover:bg-[var(--hover)]"
          >
            Cancel
          </button>
          <button
            disabled={customTs === null}
            onClick={() => customTs !== null && onSchedule(customTs)}
            className="h-8 rounded bg-[var(--primary)] px-3 text-sm text-[var(--primary-fg)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Schedule
          </button>
        </div>
      </div>
    </div>
  );
}

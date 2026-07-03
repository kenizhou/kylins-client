// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Schedule-send dialog. velo delegates to a shared DateTimePickerDialog;
// Kylins inlines a lean version: three presets (tomorrow AM/PM, next Monday
// AM) plus a native datetime-local picker for a custom time. Timestamps are
// unix seconds (matching the `scheduled_emails.scheduled_at` column).

import { useState } from 'react';
import { CloseIcon } from '../icons';
import { Button, Dialog, Modal as RACModal, ModalOverlay } from 'react-aria-components';

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

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-black/30 p-4"
    >
      <RACModal className="relative w-80 rounded-lg border border-border bg-background p-4 shadow-xl outline-none">
        <Dialog aria-label="Schedule send" className="outline-none">
          <Button
            slot="close"
            className="absolute right-2 top-2 flex h-11 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            aria-label="Close"
          >
            <CloseIcon size={14} />
          </Button>

          <h3 className="mb-3 pr-6 text-sm font-medium text-foreground">Schedule send</h3>

          <div className="space-y-1">
            {presets.map((p) => (
              <Button
                key={p.label}
                onPress={() => onSchedule(p.timestamp)}
                className="flex min-h-11 w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>{p.label}</span>
                <span className="text-xs text-muted-foreground">{p.detail}</span>
              </Button>
            ))}
          </div>

          <div className="mt-3 border-t border-border pt-3">
            <label className="mb-1 block text-xs text-muted-text">Pick a date & time</label>
            <input
              type="datetime-local"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="h-11 w-full rounded border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button
              slot="close"
              className="h-11 rounded px-3 text-sm text-foreground transition-colors hover:bg-hover"
            >
              Cancel
            </Button>
            <Button
              isDisabled={customTs === null}
              onPress={() => customTs !== null && onSchedule(customTs)}
              className="h-11 rounded bg-primary px-3 text-sm text-primary-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Schedule
            </Button>
          </div>
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
}

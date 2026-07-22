// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Schedule-send dialog (Gmail-style): three presets (label + resolved date on
// the right) that highlight on selection and confirm via the Schedule button,
// plus a "Pick a date & time" row that hands off to the dedicated
// DateTimePickerDialog (this dialog closes first, Gmail-style). The chosen
// datetime is echoed under the picker row. Timestamps are unix seconds
// (matching the `scheduled_emails.scheduled_at` column).

import { useState } from 'react';
import { CloseIcon, CalendarIcon } from '../icons';
import { Button, Dialog, Modal as RACModal, ModalOverlay } from 'react-aria-components';

interface SchedulePreset {
  label: string;
  detail: string;
  timestamp: number;
}

interface ScheduleSendDialogProps {
  /** Confirm a selection. Returns an error message to show inline, or null on success. */
  onSchedule: (timestamp: number) => Promise<string | null>;
  /** "Pick a date & time" row — parent closes this dialog and opens the picker. */
  onPickCustom: () => void;
  onClose: () => void;
}

function fmtDateTime(d: Date): string {
  return (
    d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
    ` ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
  );
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

  return [
    {
      label: 'Tomorrow morning',
      detail: fmtDateTime(tomorrowMorning),
      timestamp: Math.floor(tomorrowMorning.getTime() / 1000),
    },
    {
      label: 'Tomorrow afternoon',
      detail: fmtDateTime(tomorrowAfternoon),
      timestamp: Math.floor(tomorrowAfternoon.getTime() / 1000),
    },
    {
      label: 'Monday morning',
      detail: fmtDateTime(monday),
      timestamp: Math.floor(monday.getTime() / 1000),
    },
  ];
}

export function ScheduleSendDialog({ onSchedule, onPickCustom, onClose }: ScheduleSendDialogProps) {
  const presets = getSchedulePresets();
  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const confirm = async () => {
    if (selectedTs === null || submitting) return;
    setSubmitting(true);
    setError(null);
    const err = await onSchedule(selectedTs);
    setSubmitting(false);
    if (err) setError(err);
  };

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-[var(--backdrop)] p-4"
    >
      <RACModal className="relative w-80 rounded-xl border border-[var(--border-subtle)] bg-background p-4 shadow-[var(--shadow-xl)] outline-none">
        <Dialog aria-label="Schedule send" className="outline-none">
          <Button
            slot="close"
            className="absolute right-2 top-2 flex h-11 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            aria-label="Close"
          >
            <CloseIcon size={14} />
          </Button>

          <h3 className="pr-6 text-sm font-medium text-foreground">Schedule send</h3>
          <p className="mb-3 text-xs text-muted-text">{timeZone}</p>

          <div className="space-y-1" role="listbox" aria-label="Presets">
            {presets.map((p) => {
              const selected = selectedTs === p.timestamp;
              return (
                <Button
                  key={p.label}
                  onPress={() => setSelectedTs(p.timestamp)}
                  aria-pressed={selected}
                  className={`flex min-h-11 w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    selected
                      ? 'bg-[var(--primary-muted)] text-[var(--primary)]'
                      : 'text-foreground hover:bg-hover'
                  }`}
                >
                  <span>{p.label}</span>
                  <span className="text-xs text-muted-foreground">{p.detail}</span>
                </Button>
              );
            })}
          </div>

          <div className="mt-3 border-t border-border pt-1">
            <Button
              onPress={onPickCustom}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CalendarIcon size={16} className="text-muted-foreground" />
              <span>Pick a date &amp; time</span>
            </Button>
          </div>

          {error && <p className="mt-2 text-xs text-[var(--destructive)]">{error}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <Button
              slot="close"
              className="h-11 rounded-lg px-3 text-sm text-foreground transition-colors hover:bg-hover"
            >
              Cancel
            </Button>
            <Button
              isDisabled={selectedTs === null || submitting}
              onPress={() => void confirm()}
              className="h-11 rounded-lg bg-primary px-3 text-sm text-primary-fg shadow-[var(--shadow-sm)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Scheduling…' : 'Schedule'}
            </Button>
          </div>
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
}

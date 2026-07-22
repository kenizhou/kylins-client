// Dedicated date & time picker dialog, modeled on Gmail's "選擇日期和時間"
// step of schedule-send: calendar on the left, date + time fields on the
// right, Cancel / confirm bottom-right. Opened from ScheduleSendDialog's
// "Pick a date & time" row (which closes itself first), so this dialog owns
// the whole custom-selection flow including the final confirm.
//
// Timestamps are unix seconds (matching `scheduled_emails.scheduled_at`).

import { useState } from 'react';
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  Dialog,
  Heading,
  ListBox,
  ListBoxItem,
  Modal as RACModal,
  ModalOverlay,
  Popover,
  Select,
  SelectValue,
} from 'react-aria-components';
import { today, getLocalTimeZone, type CalendarDate } from '@internationalized/date';
import { ArrowLeftIcon, ArrowRightIcon, CaretDownIcon } from '../icons';

interface DateTimePickerDialogProps {
  /** Confirm the selection. Returns an error message to show inline, or null on success. */
  onSchedule: (timestamp: number) => Promise<string | null>;
  onClose: () => void;
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  id: String(h),
  label: String(h).padStart(2, '0'),
}));
const MINUTE_OPTIONS = ['00', '15', '30', '45'].map((m) => ({ id: m, label: m }));

function FieldSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Select
      aria-label={label}
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      className="relative"
    >
      <Button className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
        <SelectValue />
        <CaretDownIcon size={10} className="opacity-70" />
      </Button>
      <Popover className="max-h-48 overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg">
        <ListBox items={options} className="outline-none" aria-label={label}>
          {(option) => (
            <ListBoxItem
              id={option.id}
              textValue={option.label}
              className="cursor-pointer px-3 py-1 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--hover)] data-[focus-visible]:bg-[var(--hover)] data-[selected]:bg-[var(--selected)]"
            >
              {option.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}

/** Current time rounded UP to the next quarter hour. */
function initialTime(): { hour: string; minute: string } {
  const now = new Date();
  const total = now.getHours() * 60 + now.getMinutes();
  const rounded = Math.ceil(total / 15) * 15;
  return {
    hour: String(Math.floor(rounded / 60) % 24),
    minute: String(rounded % 60).padStart(2, '0'),
  };
}

export function DateTimePickerDialog({ onSchedule, onClose }: DateTimePickerDialogProps) {
  const [date, setDate] = useState<CalendarDate>(() => today(getLocalTimeZone()));
  const [{ hour, minute }, setTime] = useState(initialTime);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const combined = (() => {
    const d = date.toDate(getLocalTimeZone());
    d.setHours(Number(hour), Number(minute), 0, 0);
    return d;
  })();
  // "Past" depends on wall-clock now, which is impure during render; the
  // dialog is short-lived and re-renders on every date/time change, so a
  // fresh read per render is the correct behavior here.
  // eslint-disable-next-line react-hooks/purity
  const isPast = combined.getTime() <= Date.now();

  const confirm = async () => {
    if (isPast || submitting) return;
    setSubmitting(true);
    setError(null);
    const err = await onSchedule(Math.floor(combined.getTime() / 1000));
    setSubmitting(false);
    if (err) setError(err);
  };

  const dateLabel = date
    .toDate(getLocalTimeZone())
    .toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-[var(--backdrop)] p-4"
    >
      <RACModal className="relative rounded-xl border border-[var(--border-subtle)] bg-background p-5 shadow-[var(--shadow-xl)] outline-none">
        <Dialog aria-label="Pick a date and time" className="outline-none">
          <h3 className="mb-4 text-base font-medium text-foreground">Pick a date &amp; time</h3>

          <div className="flex gap-5">
            {/* Left: month calendar */}
            <Calendar
              aria-label="Pick a date"
              value={date}
              minValue={today(getLocalTimeZone())}
              onChange={setDate}
            >
              <header className="mb-2 flex items-center justify-between px-1">
                <Heading className="text-sm font-medium text-[var(--foreground)]" />
                <div className="flex items-center gap-1">
                  <Button
                    slot="previous"
                    aria-label="Previous month"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  >
                    <ArrowLeftIcon size={14} />
                  </Button>
                  <Button
                    slot="next"
                    aria-label="Next month"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  >
                    <ArrowRightIcon size={14} />
                  </Button>
                </div>
              </header>
              <CalendarGrid className="border-separate border-spacing-0.5">
                {(d) => (
                  <CalendarCell
                    date={d}
                    className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-sm text-[var(--foreground)] outline-none transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-30 data-[outside-month]:text-[var(--muted-text)] data-[outside-month]:opacity-50 data-[hovered]:bg-[var(--hover)] data-[selected]:bg-[var(--primary)] data-[selected]:text-[var(--primary-fg)] data-[today]:ring-1 data-[today]:ring-[var(--primary)] data-[focus-visible]:ring-2 data-[focus-visible]:ring-[var(--ring)]"
                  />
                )}
              </CalendarGrid>
            </Calendar>

            {/* Right: date + time fields */}
            <div className="flex w-48 flex-col gap-3 pt-8">
              <div
                className="rounded-lg border border-[var(--border)] px-3 py-2.5 text-sm text-[var(--foreground)]"
                aria-label="Selected date"
              >
                {dateLabel}
              </div>
              <div className="flex items-center gap-1 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)]">
                <FieldSelect
                  label="Hour"
                  options={HOUR_OPTIONS}
                  value={hour}
                  onChange={(h) => setTime((t) => ({ ...t, hour: h }))}
                />
                <span className="text-[var(--muted-text)]">:</span>
                <FieldSelect
                  label="Minute"
                  options={MINUTE_OPTIONS}
                  value={minute}
                  onChange={(m) => setTime((t) => ({ ...t, minute: m }))}
                />
              </div>
              {isPast && (
                <p className="text-xs text-[var(--destructive)]">Pick a time in the future.</p>
              )}
              {error && <p className="text-xs text-[var(--destructive)]">{error}</p>}
            </div>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <Button
              slot="close"
              className="h-10 rounded-lg px-4 text-sm text-[var(--primary)] transition-colors hover:bg-[var(--primary-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Cancel
            </Button>
            <Button
              isDisabled={isPast || submitting}
              onPress={() => void confirm()}
              className="h-10 rounded-full bg-[var(--primary)] px-5 text-sm font-medium text-[var(--primary-fg)] shadow-[var(--shadow-sm)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Scheduling…' : 'Set schedule time'}
            </Button>
          </div>
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
}

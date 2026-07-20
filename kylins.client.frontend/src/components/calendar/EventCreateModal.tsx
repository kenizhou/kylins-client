// Quick event-create modal. Builds a VEVENT via icalHelper and persists it
// (with its ical_data) to calendar_events; the calendar store re-expands.

import { useEffect, useMemo, useRef, useState } from 'react';
import { IcalHelper } from '@/services/calendar/icalHelper';
import { insertCalendarEvent } from '@/services/db/calendarEvents';
import { useCalendarStore } from '@/stores/calendarStore';
import { toUnixSeconds } from './range';
import { CloseIcon } from '@/components/icons';
import {
  Button,
  Dialog,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Modal as RACModal,
  ModalOverlay,
  Popover,
  Select,
  SelectValue,
  Switch,
  TextArea,
  TextField,
} from 'react-aria-components';

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

  const calendars = useCalendarStore((s) => s.calendars);
  const accountCalendars = useMemo(
    () =>
      calendars
        .filter((c) => c.accountId === accountId)
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
    [calendars, accountId],
  );
  const defaultCalendarId =
    accountCalendars.find((c) => c.isPrimary)?.id ?? accountCalendars[0]?.id ?? '';
  const [calendarId, setCalendarId] = useState(defaultCalendarId);

  // If the stored selection no longer matches the available calendars, fall
  // back to the default without synchronously resetting state in an effect.
  const effectiveCalendarId =
    calendarId && accountCalendars.some((c) => c.id === calendarId)
      ? calendarId
      : defaultCalendarId;

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const handleSave = async () => {
    if (!summary.trim() || !effectiveCalendarId) return;
    setSaving(true);
    setError(null);
    try {
      let startDate = new Date(start);
      let endDate = new Date(end);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        setError('Please enter valid start and end dates.');
        setSaving(false);
        return;
      }
      if (endDate.getTime() <= startDate.getTime()) {
        setError('End time must be after start time.');
        setSaving(false);
        return;
      }
      if (allDay) {
        startDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
        endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 1);
      }
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
        calendarId: effectiveCalendarId,
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

  const selectedCalendar = accountCalendars.find((c) => c.id === effectiveCalendarId);

  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-black/40 p-4"
    >
      <RACModal className="w-full max-w-md rounded-lg border border-[var(--border-subtle)] bg-surface-floating p-5 shadow-xl outline-none">
        <Dialog aria-label="New event" className="outline-none">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-base font-semibold text-foreground">New event</h3>
            <Button
              slot="close"
              className="flex h-11 w-11 items-center justify-center rounded-md text-muted-text transition-colors hover:bg-[var(--primary-subtle)] hover:text-foreground"
              aria-label="Close"
            >
              <CloseIcon size={16} />
            </Button>
          </div>

          <div className="space-y-3">
            <TextField value={summary} onChange={setSummary} className="block" autoFocus>
              <Input
                type="text"
                placeholder="Title"
                className="h-11 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--background)] px-3 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-ring"
              />
            </TextField>

            <TextField value={location} onChange={setLocation} className="block">
              <Input
                type="text"
                placeholder="Location"
                className="h-11 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--background)] px-3 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-ring"
              />
            </TextField>

            <Select
              selectedKey={effectiveCalendarId || undefined}
              onSelectionChange={(key) => setCalendarId(key as string)}
              isDisabled={accountCalendars.length === 0}
              className="block"
            >
              <Label className="mb-1 block text-xs text-muted-text">Calendar</Label>
              <Button className="flex h-11 w-full items-center justify-between rounded-md border border-[var(--border-subtle)] bg-[var(--background)] px-3 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-ring disabled:opacity-50">
                <span className="flex items-center gap-2">
                  {selectedCalendar && (
                    <span
                      className="h-3.5 w-3.5 rounded-full border border-border"
                      style={{ backgroundColor: selectedCalendar.color || 'var(--primary)' }}
                    />
                  )}
                  <SelectValue />
                </span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </Button>
              <Popover className="min-w-[var(--trigger-width)] rounded-md border border-[var(--border-subtle)] bg-surface-floating py-1 shadow-lg">
                <ListBox>
                  {accountCalendars.map((cal) => (
                    <ListBoxItem
                      key={cal.id}
                      id={cal.id}
                      textValue={cal.displayName || 'Untitled calendar'}
                      className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-foreground outline-none hover:bg-[var(--primary-subtle)] data-[selected=true]:bg-[var(--primary-muted)] data-[selected=true]:text-[var(--foreground)]"
                    >
                      <span
                        className="h-3.5 w-3.5 rounded-full border border-border"
                        style={{ backgroundColor: cal.color || 'var(--primary)' }}
                      />
                      {cal.displayName || 'Untitled calendar'}
                    </ListBoxItem>
                  ))}
                </ListBox>
              </Popover>
            </Select>

            <Switch
              isSelected={allDay}
              onChange={setAllDay}
              className="flex min-h-11 items-center gap-2 text-sm text-foreground"
            >
              {({ isSelected }) => (
                <>
                  <span
                    className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                      isSelected ? 'bg-primary' : 'bg-border'
                    }`}
                  >
                    <span
                      className={`h-3 w-3 rounded-full bg-[var(--surface-floating)] transition-transform ${
                        isSelected ? 'translate-x-3' : 'translate-x-0.5'
                      }`}
                    />
                  </span>
                  All day
                </>
              )}
            </Switch>

            <div className="flex gap-3">
              <Label className="flex-1 text-xs text-muted-text">
                Starts
                <Input
                  type="datetime-local"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="mt-1 h-11 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--background)] px-2 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-ring"
                />
              </Label>
              <Label className="flex-1 text-xs text-muted-text">
                Ends
                <Input
                  type="datetime-local"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className="mt-1 h-11 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--background)] px-2 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-ring"
                />
              </Label>
            </div>

            <TextField value={description} onChange={setDescription} className="block">
              <TextArea
                placeholder="Description"
                rows={3}
                className="w-full resize-y rounded-md border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-ring"
              />
            </TextField>

            {error && (
              <div className="flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                {error}
              </div>
            )}
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <Button
              slot="close"
              className="h-11 rounded-md px-4 text-sm text-foreground transition-colors hover:bg-[var(--primary-subtle)]"
            >
              Cancel
            </Button>
            <Button
              isDisabled={!summary.trim() || saving || !effectiveCalendarId}
              onPress={handleSave}
              className="flex h-11 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-fg transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving && (
                <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              )}
              Save
            </Button>
          </div>
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
}

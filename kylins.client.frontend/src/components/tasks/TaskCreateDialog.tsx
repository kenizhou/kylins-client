import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  Input,
  Label,
  Modal as RACModal,
  ModalOverlay,
  Select,
  SelectValue,
  TextArea,
  TextField,
  Popover,
  ListBox,
  ListBoxItem,
  DateInput,
  DatePicker,
  DateSegment,
  Group,
  Calendar,
  CalendarGrid,
  CalendarGridHeader,
  CalendarGridBody,
  CalendarHeaderCell,
  CalendarCell,
  Heading,
} from 'react-aria-components';
import { parseAbsoluteToLocal, type DateValue } from '@internationalized/date';
import { CloseIcon } from '../icons';
import type { Task, TaskPriority, UpsertTaskInput } from '@/services/db/tasks';

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export interface TaskCreateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: UpsertTaskInput) => void;
  task?: Task | null;
  initialTitle?: string;
  initialDescription?: string;
  accountId?: string | null;
  threadId?: string | null;
  threadAccountId?: string | null;
}

function dateValueToUnixSeconds(value: DateValue | null): number | null {
  if (!value) return null;
  return Math.floor(value.toDate('UTC').getTime() / 1000);
}

function unixSecondsToDateValue(seconds: number | null): DateValue | null {
  if (!seconds) return null;
  return parseAbsoluteToLocal(new Date(seconds * 1000).toISOString());
}

export function TaskCreateDialog({
  isOpen,
  onClose,
  onSubmit,
  task,
  initialTitle,
  initialDescription,
  accountId,
  threadId,
  threadAccountId,
}: TaskCreateDialogProps) {
  const isEdit = Boolean(task);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('none');
  const [dueDate, setDueDate] = useState<DateValue | null>(null);
  const [tags, setTags] = useState('');
  const wasOpenRef = useRef(false);

  // Reset form fields only on the closed → open transition so edits while the
  // dialog is open are not overwritten by prop changes.
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setTitle(task?.title ?? initialTitle ?? '');
      setDescription(task?.description ?? initialDescription ?? '');
      setPriority(task?.priority ?? 'none');
      setDueDate(unixSecondsToDateValue(task?.dueDate ?? null));
      setTags((task?.tags ?? []).join(', '));
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, task, initialTitle, initialDescription]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedTags = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const input: UpsertTaskInput = {
      title,
      description: description || null,
      priority,
      dueDate: dateValueToUnixSeconds(dueDate),
      tags: trimmedTags,
    };

    if (!isEdit) {
      input.accountId = accountId ?? null;
      input.threadId = threadId ?? null;
      input.threadAccountId = threadAccountId ?? null;
    }

    onSubmit(input);
    onClose();
  }

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center bg-black/30 p-4"
    >
      <RACModal className="relative w-[480px] max-w-full rounded-lg border border-border bg-background p-4 shadow-xl outline-none">
        <Dialog aria-label={isEdit ? 'Edit task' : 'Create task'} className="outline-none">
          {({ close }) => (
            <form onSubmit={handleSubmit} className="relative">
              <Button
                slot="close"
                onPress={close}
                className="absolute right-2 top-2 flex h-11 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                aria-label="Close"
              >
                <CloseIcon size={14} />
              </Button>

              <h3 className="mb-4 pr-6 text-base font-medium text-foreground">
                {isEdit ? 'Edit task' : 'Create task'}
              </h3>

              <div className="space-y-4">
                <TextField className="block" isRequired>
                  <Label className="mb-1 block text-xs text-muted-text">Title</Label>
                  <Input
                    autoFocus
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="What needs to be done?"
                    className="h-11 w-full rounded border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
                  />
                </TextField>

                <TextField className="block">
                  <Label className="mb-1 block text-xs text-muted-text">Description</Label>
                  <TextArea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Add details..."
                    className="min-h-[80px] w-full rounded border border-border bg-background px-2 py-2 text-sm text-foreground outline-none focus:border-primary"
                  />
                </TextField>

                <div className="grid grid-cols-2 gap-4">
                  <Select
                    selectedKey={priority}
                    onSelectionChange={(key) => setPriority(key as TaskPriority)}
                    className="block"
                  >
                    <Label className="mb-1 block text-xs text-muted-text">Priority</Label>
                    <Button className="flex h-11 w-full items-center justify-between rounded border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary">
                      <SelectValue />
                      <span aria-hidden="true">▼</span>
                    </Button>
                    <Popover className="z-[var(--z-popover)] rounded border border-border bg-background shadow-lg">
                      <ListBox className="py-1">
                        {PRIORITY_OPTIONS.map((opt) => (
                          <ListBoxItem
                            key={opt.value}
                            id={opt.value}
                            className="cursor-pointer px-3 py-2 text-sm text-foreground outline-none hover:bg-hover data-[selected=true]:bg-selected"
                          >
                            {opt.label}
                          </ListBoxItem>
                        ))}
                      </ListBox>
                    </Popover>
                  </Select>

                  <DatePicker
                    value={dueDate}
                    onChange={setDueDate}
                    granularity="day"
                    className="block"
                  >
                    <Label className="mb-1 block text-xs text-muted-text">Due date</Label>
                    <Group className="flex h-11 items-center rounded border border-border bg-background px-2 text-sm text-foreground outline-none focus-within:border-primary">
                      <DateInput className="flex">
                        {(segment) => (
                          <DateSegment
                            segment={segment}
                            className="px-0.5 py-1 text-foreground outline-none data-[placeholder]:text-muted-text"
                          />
                        )}
                      </DateInput>
                    </Group>
                    <Popover className="z-[var(--z-popover)] rounded border border-border bg-background p-2 shadow-lg">
                      <Calendar className="outline-none">
                        <header className="mb-2 flex items-center justify-between">
                          <Button slot="previous">◀</Button>
                          <Heading className="text-sm font-medium" />
                          <Button slot="next">▶</Button>
                        </header>
                        <CalendarGrid className="border-collapse">
                          <CalendarGridHeader>
                            {(day) => (
                              <CalendarHeaderCell className="p-1 text-xs text-muted-text">
                                {day}
                              </CalendarHeaderCell>
                            )}
                          </CalendarGridHeader>
                          <CalendarGridBody>
                            {(date) => (
                              <CalendarCell
                                date={date}
                                className="h-8 w-8 cursor-pointer rounded text-center text-sm text-foreground outline-none hover:bg-hover data-[selected=true]:bg-primary data-[selected=true]:text-primary-fg"
                              />
                            )}
                          </CalendarGridBody>
                        </CalendarGrid>
                      </Calendar>
                    </Popover>
                  </DatePicker>
                </div>

                <TextField className="block">
                  <Label className="mb-1 block text-xs text-muted-text">
                    Tags (comma separated)
                  </Label>
                  <Input
                    type="text"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="work, follow-up"
                    className="h-11 w-full rounded border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
                  />
                </TextField>
              </div>

              <div className="mt-6 flex justify-end gap-2">
                <Button
                  type="button"
                  onPress={close}
                  className="h-11 rounded px-3 text-sm text-foreground transition-colors hover:bg-hover"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  isDisabled={!title.trim()}
                  className="h-11 rounded bg-primary px-3 text-sm text-primary-fg transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {isEdit ? 'Save' : 'Create'}
                </Button>
              </div>
            </form>
          )}
        </Dialog>
      </RACModal>
    </ModalOverlay>
  );
}

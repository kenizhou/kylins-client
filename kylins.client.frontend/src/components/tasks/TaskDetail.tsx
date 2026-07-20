import { useState } from 'react';
import {
  Button,
  Checkbox,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  TextArea,
  TextField,
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
import { CalendarIcon, TrashIcon } from '../icons';
import type { Task, TaskPriority, UpsertTaskInput } from '@/services/db/tasks';

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

function dateValueToUnixSeconds(value: DateValue | null): number | null {
  if (!value) return null;
  return Math.floor(value.toDate('UTC').getTime() / 1000);
}

function unixSecondsToDateValue(seconds: number | null): DateValue | null {
  if (!seconds) return null;
  return parseAbsoluteToLocal(new Date(seconds * 1000).toISOString());
}

function formatDateTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

export interface TaskDetailProps {
  task: Task;
  onUpdate: (id: string, updates: UpsertTaskInput) => void;
  onDelete: (id: string) => void;
}

export function TaskDetail({ task, onUpdate, onDelete }: TaskDetailProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dueDate, setDueDate] = useState<DateValue | null>(unixSecondsToDateValue(task.dueDate));
  const [tags, setTags] = useState(task.tags.join(', '));

  function save() {
    const trimmedTags = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    onUpdate(task.id, {
      title,
      description: description || null,
      priority,
      dueDate: dateValueToUnixSeconds(dueDate),
      tags: trimmedTags,
    });
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-surface-elevated p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">Task details</h2>
        <Button
          onPress={() => onDelete(task.id)}
          className="inline-flex h-9 items-center gap-1 rounded px-2 text-sm text-[var(--error)] transition-colors hover:bg-[var(--error)]/10"
        >
          <TrashIcon size={16} />
          Delete
        </Button>
      </div>

      <div className="space-y-4">
        <TextField className="block">
          <Label className="type-overline mb-1 block text-muted-text">Title</Label>
          <Input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={save}
            className="h-11 w-full rounded-lg border border-[var(--border-subtle)] bg-surface-floating px-2 text-sm text-foreground outline-none focus:border-primary"
          />
        </TextField>

        <TextField className="block">
          <Label className="type-overline mb-1 block text-muted-text">Description</Label>
          <TextArea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={save}
            placeholder="Add details..."
            className="min-h-[120px] w-full rounded-lg border border-[var(--border-subtle)] bg-surface-floating px-2 py-2 text-sm text-foreground outline-none focus:border-primary"
          />
        </TextField>

        <div className="grid grid-cols-2 gap-4">
          <Select
            selectedKey={priority}
            onSelectionChange={(key) => {
              setPriority(key as TaskPriority);
              onUpdate(task.id, { priority: key as TaskPriority });
            }}
            className="block"
          >
            <Label className="type-overline mb-1 block text-muted-text">Priority</Label>
            <Button className="flex h-11 w-full items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-surface-floating px-2 text-sm text-foreground outline-none focus:border-primary">
              <SelectValue />
              <span aria-hidden="true">▼</span>
            </Button>
            <Popover className="z-[var(--z-popover)] rounded-lg border border-[var(--border-subtle)] bg-surface-floating shadow-lg">
              <ListBox className="py-1">
                {PRIORITY_OPTIONS.map((opt) => (
                  <ListBoxItem
                    key={opt.value}
                    id={opt.value}
                    className="cursor-pointer px-3 py-2 text-sm text-foreground outline-none hover:bg-[var(--primary-subtle)] data-[selected=true]:bg-[var(--primary-muted)]"
                  >
                    {opt.label}
                  </ListBoxItem>
                ))}
              </ListBox>
            </Popover>
          </Select>

          <DatePicker
            value={dueDate}
            onChange={(value) => {
              setDueDate(value);
              onUpdate(task.id, { dueDate: dateValueToUnixSeconds(value) });
            }}
            granularity="day"
            className="block"
          >
            <Label className="type-overline mb-1 block text-muted-text">Due date</Label>
            <Group className="flex h-11 items-center rounded-lg border border-[var(--border-subtle)] bg-surface-floating px-2 text-sm text-foreground outline-none focus-within:border-primary">
              <DateInput className="flex">
                {(segment) => (
                  <DateSegment
                    segment={segment}
                    className="px-0.5 py-1 text-foreground outline-none data-[placeholder]:text-muted-text"
                  />
                )}
              </DateInput>
            </Group>
            <Popover className="z-[var(--z-popover)] rounded-lg border border-[var(--border-subtle)] bg-surface-floating p-2 shadow-lg">
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
                        className="h-8 w-8 cursor-pointer rounded text-center text-sm text-foreground outline-none hover:bg-[var(--primary-subtle)] data-[selected=true]:bg-primary data-[selected=true]:text-primary-fg"
                      />
                    )}
                  </CalendarGridBody>
                </CalendarGrid>
              </Calendar>
            </Popover>
          </DatePicker>
        </div>

        <TextField className="block">
          <Label className="type-overline mb-1 block text-muted-text">Tags (comma separated)</Label>
          <Input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onBlur={save}
            placeholder="work, follow-up"
            className="h-11 w-full rounded-lg border border-[var(--border-subtle)] bg-surface-floating px-2 text-sm text-foreground outline-none focus:border-primary"
          />
        </TextField>

        <div className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-surface-floating p-3">
          <Checkbox
            isSelected={task.isCompleted}
            onChange={() => onUpdate(task.id, { isCompleted: !task.isCompleted })}
            className="flex h-5 w-5 items-center justify-center rounded border border-border data-[selected]:border-primary data-[selected]:bg-primary"
          >
            {task.isCompleted && <span className="text-xs text-primary-fg">✓</span>}
          </Checkbox>
          <span className="text-sm text-foreground">
            {task.isCompleted ? 'Completed' : 'Mark complete'}
          </span>
        </div>

        <div className="space-y-1 pt-4 text-xs text-muted-text">
          <div className="flex items-center gap-2">
            <CalendarIcon size={12} />
            Created {formatDateTime(task.createdAt)}
          </div>
          <div>Updated {formatDateTime(task.updatedAt)}</div>
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Checkbox, Button } from 'react-aria-components';
import { CalendarIcon, CheckIcon, LinkIcon, TrashIcon } from '../icons';
import { formatRelativeDueDate } from '../../utils/formatDate';
import type { Task } from '@/services/db/tasks';

export interface TaskItemProps {
  task: Task;
  isSelected?: boolean;
  onSelect?: () => void;
  onToggle?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

const PRIORITY_DOT: Record<Task['priority'], string> = {
  none: 'bg-transparent',
  low: 'bg-[var(--success)]',
  medium: 'bg-[var(--warning)]',
  high: 'bg-[var(--error)]',
};

export function TaskItem({
  task,
  isSelected = false,
  onSelect,
  onToggle,
  onEdit,
  onDelete,
}: TaskItemProps) {
  const [now] = useState(() => Date.now());
  const dueText = task.dueDate ? formatRelativeDueDate(task.dueDate * 1000, now) : null;
  const isOverdue = task.dueDate && !task.isCompleted && task.dueDate * 1000 < now - 86400000;

  return (
    <div
      role="listitem"
      onClick={onSelect}
      onDoubleClick={onEdit}
      className={`group relative flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
        isSelected
          ? 'border-primary bg-[var(--primary-muted)]'
          : 'border-[var(--border-subtle)] bg-surface-elevated hover:border-[var(--primary)]/50 hover:bg-[var(--primary-subtle)]'
      }`}
    >
      {isSelected && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full iris-line" />
      )}
      <Checkbox
        isSelected={task.isCompleted}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        aria-label={task.isCompleted ? 'Mark incomplete' : 'Mark complete'}
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--border-subtle)] bg-[var(--background)] data-[selected]:border-primary data-[selected]:bg-primary"
      >
        {task.isCompleted && <CheckIcon size={12} className="text-primary-fg" />}
      </Checkbox>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[task.priority]}`}
            title={`Priority: ${task.priority}`}
          />
          <span
            className={`truncate text-sm font-medium ${
              task.isCompleted ? 'text-muted-text line-through' : 'text-foreground'
            }`}
          >
            {task.title}
          </span>
          {task.threadId && <LinkIcon size={14} className="shrink-0 text-muted-text" />}
        </div>

        {(dueText || task.tags.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {dueText && (
              <span
                className={`inline-flex items-center gap-1 text-xs tabular-nums ${
                  isOverdue ? 'text-[var(--error)]' : 'text-muted-text'
                }`}
              >
                <CalendarIcon size={12} />
                {dueText}
              </span>
            )}
            {task.tags.map((tag) => (
              <span
                key={tag}
                className="type-caption rounded-full border border-[var(--border-subtle)] bg-[var(--surface-floating)] px-2 py-0.5 text-[var(--muted-text)]"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {onDelete && (
        <Button
          onPress={onDelete}
          onClick={(e) => e.stopPropagation()}
          aria-label="Delete task"
          className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
        >
          <TrashIcon size={16} className="text-muted-text hover:text-[var(--error)]" />
        </Button>
      )}
    </div>
  );
}

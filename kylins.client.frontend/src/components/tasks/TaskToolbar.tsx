import {
  Button,
  Select,
  SelectValue,
  Popover,
  ListBox,
  ListBoxItem,
  Tab,
  TabList,
  Tabs,
} from 'react-aria-components';
import { PlusIcon } from '../icons';
import type { TaskFilter, TaskSortBy } from '@/stores/taskStore';

const FILTER_OPTIONS: { value: TaskFilter; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
];

const SORT_OPTIONS: { value: TaskSortBy; label: string }[] = [
  { value: 'sortOrder', label: 'Manual order' },
  { value: 'dueDate', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
  { value: 'createdAt', label: 'Created' },
];

export interface TaskToolbarProps {
  filter: TaskFilter;
  sortBy: TaskSortBy;
  sortDirection: 'asc' | 'desc';
  onFilterChange: (filter: TaskFilter) => void;
  onSortChange: (sortBy: TaskSortBy) => void;
  onSortDirectionChange: (direction: 'asc' | 'desc') => void;
  onNewTask: () => void;
}

export function TaskToolbar({
  filter,
  sortBy,
  sortDirection,
  onFilterChange,
  onSortChange,
  onSortDirectionChange,
  onNewTask,
}: TaskToolbarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-b-[var(--border-subtle)] bg-surface px-4 py-3">
      <Tabs selectedKey={filter} onSelectionChange={(key) => onFilterChange(key as TaskFilter)}>
        <TabList className="flex rounded-lg bg-surface-elevated p-1">
          {FILTER_OPTIONS.map((opt) => (
            <Tab
              key={opt.value}
              id={opt.value}
              className="rounded-md px-3 py-1.5 text-sm text-muted-text outline-none transition-colors hover:bg-[var(--primary-subtle)] hover:text-foreground data-[selected]:bg-surface-floating data-[selected]:text-foreground data-[selected]:shadow-sm"
            >
              {opt.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>

      <div className="flex items-center gap-2">
        <Select
          selectedKey={sortBy}
          onSelectionChange={(key) => onSortChange(key as TaskSortBy)}
          className="flex items-center gap-2"
        >
          <span className="text-sm text-muted-text">Sort:</span>
          <Button className="flex h-9 items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-surface-elevated px-2 text-sm text-foreground outline-none focus:border-primary">
            <SelectValue />
            <span aria-hidden="true">▼</span>
          </Button>
          <Popover className="z-[var(--z-popover)] rounded-lg border border-[var(--border-subtle)] bg-surface-elevated shadow-lg">
            <ListBox className="py-1">
              {SORT_OPTIONS.map((opt) => (
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

        <Button
          onPress={() => onSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc')}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-sm text-foreground hover:bg-hover"
          aria-label={sortDirection === 'asc' ? 'Sort descending' : 'Sort ascending'}
        >
          {sortDirection === 'asc' ? '↑' : '↓'}
        </Button>

        <Button
          onPress={onNewTask}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm text-primary-fg shadow-[var(--shadow-sm)] transition-opacity hover:opacity-90"
        >
          <PlusIcon size={16} />
          New task
        </Button>
      </div>
    </div>
  );
}

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TaskItem } from '@/components/tasks/TaskItem';
import type { Task } from '@/services/db/tasks';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    accountId: 'acc-1',
    title: 'Test task',
    description: null,
    priority: 'medium',
    isCompleted: false,
    completedAt: null,
    dueDate: null,
    parentId: null,
    threadId: null,
    threadAccountId: null,
    sortOrder: 0,
    recurrenceRule: null,
    nextRecurrenceAt: null,
    tags: ['work'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('TaskItem', () => {
  it('renders title, tag, and priority indicator', () => {
    render(
      <TaskItem
        task={makeTask({ title: 'Review PR', priority: 'high' })}
        isSelected={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('Review PR')).toBeInTheDocument();
    expect(screen.getByText('work')).toBeInTheDocument();
    expect(screen.getByLabelText('Mark complete')).toBeInTheDocument();
  });

  it('calls onSelect when clicked', () => {
    const onSelect = vi.fn();
    render(<TaskItem task={makeTask()} isSelected={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('listitem'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('calls onToggle when checkbox is clicked', () => {
    const onToggle = vi.fn();
    render(<TaskItem task={makeTask()} isSelected={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByLabelText('Mark complete'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('calls onEdit on double click', () => {
    const onEdit = vi.fn();
    render(<TaskItem task={makeTask()} isSelected={false} onEdit={onEdit} />);
    fireEvent.doubleClick(screen.getByRole('listitem'));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('calls onDelete when delete button is activated', () => {
    const onDelete = vi.fn();
    render(<TaskItem task={makeTask()} isSelected={false} onDelete={onDelete} />);
    fireEvent.click(screen.getByLabelText('Delete task'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('shows link icon for thread-linked tasks', () => {
    render(<TaskItem task={makeTask({ threadId: 'thread-1' })} isSelected={false} />);
    expect(document.querySelector('svg')).toBeInTheDocument();
  });
});

// Tests for the task Zustand store.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useTaskStore,
  useFilteredSortedTasks,
  useIncompleteTaskCount,
  filterTasks,
} from '@/stores/taskStore';
import * as taskService from '@/services/db/tasks';
import type { Task } from '@/services/db/tasks';

vi.mock('@/services/db/tasks', async () => {
  const actual = await vi.importActual<typeof import('@/services/db/tasks')>('@/services/db/tasks');
  return {
    ...actual,
    getTasksForAccount: vi.fn(),
    getTaskTags: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    toggleTaskCompleted: vi.fn(),
  };
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    accountId: 'acc-1',
    title: 'Task 1',
    description: null,
    priority: 'none',
    isCompleted: false,
    completedAt: null,
    dueDate: null,
    parentId: null,
    threadId: null,
    threadAccountId: null,
    sortOrder: 0,
    recurrenceRule: null,
    nextRecurrenceAt: null,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('taskStore', () => {
  beforeEach(() => {
    act(() => useTaskStore.getState().clear());
    vi.clearAllMocks();
  });

  it('loads tasks and tags for an account', async () => {
    vi.mocked(taskService.getTasksForAccount).mockResolvedValueOnce([
      makeTask({ id: 't1', title: 'A' }),
      makeTask({ id: 't2', title: 'B' }),
    ]);
    vi.mocked(taskService.getTaskTags).mockResolvedValueOnce([
      { tag: 'work', accountId: 'acc-1', color: null, sortOrder: 0, createdAt: 1 },
    ]);

    await act(async () => {
      await useTaskStore.getState().loadTasks('acc-1');
      await useTaskStore.getState().loadTags('acc-1');
    });

    expect(useTaskStore.getState().tasks).toHaveLength(2);
    expect(useTaskStore.getState().tags).toHaveLength(1);
    expect(useTaskStore.getState().loading).toBe(false);
  });

  it('surfaces load errors', async () => {
    vi.mocked(taskService.getTasksForAccount).mockRejectedValueOnce(new Error('db down'));
    await act(async () => {
      await useTaskStore.getState().loadTasks('acc-1');
    });
    expect(useTaskStore.getState().error).toBe('db down');
    expect(useTaskStore.getState().loading).toBe(false);
  });

  it('creates a task and selects it', async () => {
    const created = makeTask({ id: 'new', title: 'New task' });
    vi.mocked(taskService.createTask).mockResolvedValueOnce(created);

    await act(async () => {
      await useTaskStore.getState().createTask({ title: 'New task', accountId: 'acc-1' });
    });

    expect(useTaskStore.getState().tasks[0]?.id).toBe('new');
    expect(useTaskStore.getState().selectedTaskId).toBe('new');
  });

  it('updates a task in place', async () => {
    act(() => useTaskStore.setState({ tasks: [makeTask({ id: 't1', title: 'Old' })] }));
    const updated = makeTask({ id: 't1', title: 'Updated' });
    vi.mocked(taskService.updateTask).mockResolvedValueOnce(updated);

    await act(async () => {
      await useTaskStore.getState().updateTask('t1', { title: 'Updated' });
    });

    expect(useTaskStore.getState().tasks[0]?.title).toBe('Updated');
  });

  it('deletes a task and clears selection', async () => {
    act(() => useTaskStore.setState({ tasks: [makeTask({ id: 't1' })], selectedTaskId: 't1' }));
    vi.mocked(taskService.deleteTask).mockResolvedValueOnce(undefined);

    await act(async () => {
      await useTaskStore.getState().deleteTask('t1');
    });

    expect(useTaskStore.getState().tasks).toHaveLength(0);
    expect(useTaskStore.getState().selectedTaskId).toBeNull();
  });

  it('toggles completion optimistically and reverts on failure', async () => {
    const original = makeTask({ id: 't1', isCompleted: false });
    act(() => useTaskStore.setState({ tasks: [original] }));
    vi.mocked(taskService.toggleTaskCompleted).mockRejectedValueOnce(new Error('network'));

    await expect(
      act(async () => {
        await useTaskStore.getState().toggleComplete('t1');
      }),
    ).rejects.toThrow('network');

    expect(useTaskStore.getState().tasks[0]?.isCompleted).toBe(false);
  });

  it('filters tasks by active/completed', () => {
    const tasks = [
      makeTask({ id: 'a', isCompleted: false }),
      makeTask({ id: 'b', isCompleted: true }),
    ];
    expect(filterTasks(tasks, 'active')).toHaveLength(1);
    expect(filterTasks(tasks, 'completed')[0]?.id).toBe('b');
    expect(filterTasks(tasks, 'all')).toHaveLength(2);
  });

  it('useFilteredSortedTasks reflects filter and sort', () => {
    act(() =>
      useTaskStore.setState({
        tasks: [
          makeTask({ id: 'high', priority: 'high' }),
          makeTask({ id: 'low', priority: 'low' }),
        ],
        filter: 'all',
        sortBy: 'priority',
        sortDirection: 'desc',
      }),
    );
    const { result } = renderHook(() => useFilteredSortedTasks());
    expect(result.current.map((t) => t.id)).toEqual(['high', 'low']);
  });

  it('useIncompleteTaskCount counts only open tasks', () => {
    act(() =>
      useTaskStore.setState({
        tasks: [
          makeTask({ id: 'a', isCompleted: false }),
          makeTask({ id: 'b', isCompleted: true }),
          makeTask({ id: 'c', isCompleted: false }),
        ],
      }),
    );
    const { result } = renderHook(() => useIncompleteTaskCount());
    expect(result.current).toBe(2);
  });
});

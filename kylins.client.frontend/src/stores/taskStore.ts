// Task UI store (Zustand). Holds the task list, selection, filters, and
// derived incomplete count for the badge on the Tasks icon.

import { create } from 'zustand';
import {
  createTask,
  deleteTask,
  getTaskTags,
  getTasksForAccount,
  toggleTaskCompleted,
  updateTask,
  type Task,
  type TaskPriority,
  type TaskTag,
  type UpsertTaskInput,
} from '@/services/db/tasks';

export type TaskFilter = 'all' | 'active' | 'completed';
export type TaskSortBy = 'dueDate' | 'priority' | 'createdAt' | 'sortOrder';

export interface TaskState {
  tasks: Task[];
  tags: TaskTag[];
  selectedTaskId: string | null;
  filter: TaskFilter;
  sortBy: TaskSortBy;
  sortDirection: 'asc' | 'desc';
  loading: boolean;
  error: string | null;
  setSelectedTaskId: (id: string | null) => void;
  setFilter: (filter: TaskFilter) => void;
  setSortBy: (sortBy: TaskSortBy) => void;
  setSortDirection: (direction: 'asc' | 'desc') => void;
  loadTasks: (accountId: string) => Promise<void>;
  loadTags: (accountId?: string) => Promise<void>;
  createTask: (input: UpsertTaskInput) => Promise<Task>;
  updateTask: (id: string, updates: UpsertTaskInput) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  toggleComplete: (id: string) => Promise<void>;
  clear: () => void;
}

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function sortTasks(tasks: Task[], sortBy: TaskSortBy, direction: 'asc' | 'desc'): Task[] {
  const sorted = [...tasks];
  const dir = direction === 'asc' ? 1 : -1;

  sorted.sort((a, b) => {
    switch (sortBy) {
      case 'sortOrder':
        return (a.sortOrder - b.sortOrder) * dir;
      case 'priority':
        return (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]) * dir;
      case 'dueDate': {
        const aDue = a.dueDate ?? Number.MAX_SAFE_INTEGER;
        const bDue = b.dueDate ?? Number.MAX_SAFE_INTEGER;
        return (aDue - bDue) * dir;
      }
      case 'createdAt':
      default:
        return (a.createdAt - b.createdAt) * dir;
    }
  });

  return sorted;
}

export function filterTasks(tasks: Task[], filter: TaskFilter): Task[] {
  switch (filter) {
    case 'active':
      return tasks.filter((t) => !t.isCompleted);
    case 'completed':
      return tasks.filter((t) => t.isCompleted);
    default:
      return tasks;
  }
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  tags: [],
  selectedTaskId: null,
  filter: 'active',
  sortBy: 'sortOrder',
  sortDirection: 'asc',
  loading: false,
  error: null,

  setSelectedTaskId: (selectedTaskId) => set({ selectedTaskId }),
  setFilter: (filter) => set({ filter }),
  setSortBy: (sortBy) => set({ sortBy }),
  setSortDirection: (sortDirection) => set({ sortDirection }),

  loadTasks: async (accountId) => {
    set({ loading: true, error: null });
    try {
      const tasks = await getTasksForAccount(accountId, true);
      set({ tasks, loading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
    }
  },

  loadTags: async (accountId) => {
    try {
      const tags = await getTaskTags(accountId);
      set({ tags });
    } catch (err) {
      console.error('[taskStore] loadTags failed:', err);
    }
  },

  createTask: async (input) => {
    const task = await createTask(input);
    set((state) => ({
      tasks: sortTasks([task, ...state.tasks], state.sortBy, state.sortDirection),
      selectedTaskId: task.id,
    }));
    return task;
  },

  updateTask: async (id, updates) => {
    const task = await updateTask(id, updates);
    set((state) => ({
      tasks: sortTasks(
        state.tasks.map((t) => (t.id === id ? task : t)),
        state.sortBy,
        state.sortDirection,
      ),
    }));
    return task;
  },

  deleteTask: async (id) => {
    await deleteTask(id);
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
      selectedTaskId: state.selectedTaskId === id ? null : state.selectedTaskId,
    }));
  },

  toggleComplete: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    const nextCompleted = !task.isCompleted;

    // Optimistic update
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id
          ? {
              ...t,
              isCompleted: nextCompleted,
              completedAt: nextCompleted ? Math.floor(Date.now() / 1000) : null,
            }
          : t,
      ),
    }));

    try {
      await toggleTaskCompleted(id, nextCompleted);
    } catch (err) {
      // Revert on failure
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === id
            ? {
                ...t,
                isCompleted: task.isCompleted,
                completedAt: task.completedAt,
              }
            : t,
        ),
      }));
      throw err;
    }
  },

  clear: () =>
    set({
      tasks: [],
      tags: [],
      selectedTaskId: null,
      filter: 'active',
      sortBy: 'sortOrder',
      sortDirection: 'asc',
      loading: false,
      error: null,
    }),
}));

export function useFilteredSortedTasks(): Task[] {
  const { tasks, filter, sortBy, sortDirection } = useTaskStore();
  return sortTasks(filterTasks(tasks, filter), sortBy, sortDirection);
}

export function useIncompleteTaskCount(): number {
  return useTaskStore((state) => state.tasks.filter((t) => !t.isCompleted).length);
}

import { useEffect, useState } from 'react';
import { useAccountStore } from '@/stores/accountStore';
import { useTaskStore, useFilteredSortedTasks } from '@/stores/taskStore';
import { ResizablePaneGroup } from '@/components/layout/ResizablePaneGroup';
import { TaskToolbar } from './TaskToolbar';
import { TaskList } from './TaskList';
import { TaskDetail } from './TaskDetail';
import { TaskCreateDialog } from './TaskCreateDialog';
import type { Task, UpsertTaskInput } from '@/services/db/tasks';

const CONSTRAINTS = {
  list: { min: 20 },
  detail: { min: 30 },
} as const;

export function TasksPage() {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);

  const tasks = useTaskStore((s) => s.tasks);
  const filter = useTaskStore((s) => s.filter);
  const sortBy = useTaskStore((s) => s.sortBy);
  const sortDirection = useTaskStore((s) => s.sortDirection);
  const selectedTaskId = useTaskStore((s) => s.selectedTaskId);
  const loading = useTaskStore((s) => s.loading);
  const error = useTaskStore((s) => s.error);
  const loadTasks = useTaskStore((s) => s.loadTasks);
  const loadTags = useTaskStore((s) => s.loadTags);
  const createTask = useTaskStore((s) => s.createTask);
  const updateTask = useTaskStore((s) => s.updateTask);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const toggleComplete = useTaskStore((s) => s.toggleComplete);
  const setSelectedTaskId = useTaskStore((s) => s.setSelectedTaskId);
  const setFilter = useTaskStore((s) => s.setFilter);
  const setSortBy = useTaskStore((s) => s.setSortBy);
  const setSortDirection = useTaskStore((s) => s.setSortDirection);

  const filteredSortedTasks = useFilteredSortedTasks();
  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  useEffect(() => {
    if (activeAccountId) {
      loadTasks(activeAccountId);
      loadTags(activeAccountId);
    }
  }, [activeAccountId, loadTasks, loadTags]);

  // Keep the selected task visible when filter changes.
  useEffect(() => {
    if (selectedTaskId && !filteredSortedTasks.some((t) => t.id === selectedTaskId)) {
      setSelectedTaskId(null);
    }
  }, [filteredSortedTasks, selectedTaskId, setSelectedTaskId]);

  function handleNewTask() {
    setEditingTask(null);
    setDialogOpen(true);
  }

  function handleEditTask(task: Task) {
    setEditingTask(task);
    setDialogOpen(true);
  }

  async function handleSubmit(input: UpsertTaskInput) {
    if (editingTask) {
      await updateTask(editingTask.id, input);
    } else if (activeAccountId) {
      await createTask({ ...input, accountId: activeAccountId });
    }
  }

  if (!activeAccountId) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center text-muted-text">
        <p className="text-base font-medium text-foreground">No account selected</p>
        <p className="mt-1 text-sm">Add an account to start managing tasks.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card">
      <TaskToolbar
        filter={filter}
        sortBy={sortBy}
        sortDirection={sortDirection}
        onFilterChange={setFilter}
        onSortChange={setSortBy}
        onSortDirectionChange={setSortDirection}
        onNewTask={handleNewTask}
      />

      {loading && tasks.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-muted-text">
          Loading tasks…
        </div>
      )}
      {error && (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-[var(--error)]">
          {error}
        </div>
      )}

      <ResizablePaneGroup
        className="flex flex-1 overflow-hidden"
        panels={[
          {
            id: 'tasks-list',
            content: (
              <TaskList
                tasks={filteredSortedTasks}
                selectedTaskId={selectedTaskId}
                onSelect={setSelectedTaskId}
                onToggle={toggleComplete}
                onEdit={handleEditTask}
                onDelete={deleteTask}
              />
            ),
            defaultSize: 40,
            minSize: CONSTRAINTS.list.min,
            card: false,
          },
          {
            id: 'tasks-detail',
            content: selectedTask ? (
              <TaskDetail task={selectedTask} onUpdate={updateTask} onDelete={deleteTask} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center p-6 text-center text-muted-text">
                <p className="text-sm">Select a task to view details.</p>
              </div>
            ),
            defaultSize: 60,
            minSize: CONSTRAINTS.detail.min,
            card: false,
          },
        ]}
      />

      <TaskCreateDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleSubmit}
        task={editingTask}
        accountId={activeAccountId}
      />
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { PlusIcon, TasksIcon } from '../icons';
import { getTasksForThread, type Task, type UpsertTaskInput } from '@/services/db/tasks';
import { useTaskStore } from '@/stores/taskStore';
import { TaskCreateDialog } from './TaskCreateDialog';

export interface TaskThreadSidebarProps {
  message?: Record<string, unknown> | null;
  accountId?: string | null;
}

export function TaskThreadSidebar({ message, accountId }: TaskThreadSidebarProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const createTask = useTaskStore((s) => s.createTask);
  const toggleComplete = useTaskStore((s) => s.toggleComplete);

  const threadId = typeof message?.threadId === 'string' ? message.threadId : null;

  useEffect(() => {
    if (!accountId || !threadId) return;
    getTasksForThread(accountId, threadId)
      .then(setTasks)
      .catch((err) => console.error('[TaskThreadSidebar] failed to load tasks:', err));
  }, [accountId, threadId]);

  async function handleSubmit(input: UpsertTaskInput) {
    if (!accountId || !threadId) return;
    const task = await createTask({
      ...input,
      accountId,
      threadId,
      threadAccountId: accountId,
    });
    setTasks((prev) => [...prev, task]);
  }

  if (!accountId || !threadId) return null;

  return (
    <div className="border-t border-[var(--border-subtle)] bg-surface-elevated p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="type-overline flex items-center gap-2 text-foreground">
          <TasksIcon size={16} />
          Tasks (<span className="tabular-nums">{tasks.length}</span>)
        </div>
        <Button
          onPress={() => setDialogOpen(true)}
          className="inline-flex h-8 items-center gap-1 rounded-lg bg-primary px-2 text-xs text-primary-fg shadow-[var(--shadow-sm)] transition-opacity hover:opacity-90"
        >
          <PlusIcon size={14} />
          Add
        </Button>
      </div>

      {tasks.length === 0 ? (
        <p className="text-xs text-muted-text">No tasks linked to this thread.</p>
      ) : (
        <ul className="space-y-1">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={task.isCompleted}
                onChange={() => toggleComplete(task.id)}
                className="h-4 w-4 rounded border-border"
              />
              <span
                className={task.isCompleted ? 'text-muted-text line-through' : 'text-foreground'}
              >
                {task.title}
              </span>
            </li>
          ))}
        </ul>
      )}

      <TaskCreateDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleSubmit}
        initialTitle={typeof message?.subject === 'string' ? message.subject : ''}
        accountId={accountId}
        threadId={threadId}
        threadAccountId={accountId}
      />
    </div>
  );
}

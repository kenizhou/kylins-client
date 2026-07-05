import { useState } from 'react';
import { IconButton } from '../ui/IconButton';
import { TasksIcon } from '../icons';
import { TaskCreateDialog } from './TaskCreateDialog';
import { suggestTaskFromThread } from '@/services/ai/taskExtraction';
import { useTaskStore } from '@/stores/taskStore';
import type { UpsertTaskInput } from '@/services/db/tasks';

export interface TaskActionButtonProps {
  message?: Record<string, unknown> | null;
  accountId?: string | null;
}

export function TaskActionButton({ message, accountId }: TaskActionButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [suggestion, setSuggestion] = useState<UpsertTaskInput>({});
  const createTask = useTaskStore((s) => s.createTask);

  const threadId = typeof message?.threadId === 'string' ? message.threadId : null;

  function handleOpen() {
    const subject = typeof message?.subject === 'string' ? message.subject : '';
    const body = typeof message?.body === 'string' ? message.body : '';
    const suggested = suggestTaskFromThread(subject, body);
    setSuggestion({
      title: suggested.title,
      description: suggested.description,
      priority: suggested.priority,
      dueDate: suggested.dueDate,
    });
    setDialogOpen(true);
  }

  async function handleSubmit(input: UpsertTaskInput) {
    if (!accountId || !threadId) return;
    await createTask({
      ...input,
      accountId,
      threadId,
      threadAccountId: accountId,
    });
  }

  if (!accountId || !threadId) return null;

  return (
    <>
      <IconButton
        icon={<TasksIcon size={18} />}
        title="Add task"
        label="Task"
        size="md"
        onClick={handleOpen}
      />
      <TaskCreateDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleSubmit}
        initialTitle={suggestion.title}
        initialDescription={suggestion.description ?? undefined}
        accountId={accountId}
        threadId={threadId}
        threadAccountId={accountId}
      />
    </>
  );
}

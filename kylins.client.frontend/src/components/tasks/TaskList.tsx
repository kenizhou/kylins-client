import { TaskItem } from './TaskItem';
import type { Task } from '@/services/db/tasks';

export interface TaskListProps {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
}

export function TaskList({
  tasks,
  selectedTaskId,
  onSelect,
  onToggle,
  onEdit,
  onDelete,
}: TaskListProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center text-muted-text">
        <p className="text-sm">No tasks found.</p>
        <p className="mt-1 text-xs">Create one with the New Task button.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2">
      {tasks.map((task) => (
        <TaskItem
          key={task.id}
          task={task}
          isSelected={task.id === selectedTaskId}
          onSelect={() => onSelect(task.id)}
          onToggle={() => onToggle(task.id)}
          onEdit={() => onEdit(task)}
          onDelete={() => onDelete(task.id)}
        />
      ))}
    </div>
  );
}

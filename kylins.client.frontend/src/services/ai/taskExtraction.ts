// AI task extraction stub.
//
// Returns a structured task suggestion from an email subject/body. This is a
// placeholder implementation; a future version will call the LLM pipeline.

import type { TaskPriority } from '@/services/db/tasks';

export interface TaskSuggestion {
  title: string;
  description: string | null;
  priority: TaskPriority;
  dueDate: number | null;
}

export function suggestTaskFromThread(subject: string, _body: string): TaskSuggestion {
  const title = subject.trim() || 'Follow up';

  // Pick a deterministic priority based on the subject keywords.
  const lowered = title.toLowerCase();
  let priority: TaskPriority = 'none';
  if (lowered.includes('urgent') || lowered.includes('asap') || lowered.includes('deadline')) {
    priority = 'high';
  } else if (lowered.includes('important') || lowered.includes('review')) {
    priority = 'medium';
  } else if (lowered.includes('todo') || lowered.includes('reminder')) {
    priority = 'low';
  }

  // Suggest a due date 3 business days from now as a placeholder.
  const now = new Date();
  let addedDays = 0;
  let days = 0;
  while (addedDays < 3 && days < 10) {
    days += 1;
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + days);
    const day = candidate.getDay();
    if (day !== 0 && day !== 6) {
      addedDays += 1;
    }
  }
  const due = new Date(now);
  due.setDate(due.getDate() + days);
  due.setHours(23, 59, 59, 0);

  return {
    title,
    description: null,
    priority,
    dueDate: Math.floor(due.getTime() / 1000),
  };
}

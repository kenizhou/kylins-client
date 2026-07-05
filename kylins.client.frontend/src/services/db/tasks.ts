// Task / to-do service.
//
// CRUD over the local `tasks` and `task_tags` tables. Tasks are local-first and
// can be linked to an email thread via `threadId` / `threadAccountId`.

import { invoke } from '@tauri-apps/api/core';

export type TaskPriority = 'none' | 'low' | 'medium' | 'high';

export const PRIORITY_ORDER: Record<TaskPriority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export interface DbTask {
  id: string;
  account_id: string | null;
  title: string;
  description: string | null;
  priority: string;
  is_completed: number;
  completed_at: number | null;
  due_date: number | null;
  parent_id: string | null;
  thread_id: string | null;
  thread_account_id: string | null;
  sort_order: number;
  recurrence_rule: string | null;
  next_recurrence_at: number | null;
  tags_json: string;
  created_at: number;
  updated_at: number;
}

export interface Task {
  id: string;
  accountId: string | null;
  title: string;
  description: string | null;
  priority: TaskPriority;
  isCompleted: boolean;
  completedAt: number | null;
  dueDate: number | null;
  parentId: string | null;
  threadId: string | null;
  threadAccountId: string | null;
  sortOrder: number;
  recurrenceRule: string | null;
  nextRecurrenceAt: number | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface UpsertTaskInput {
  id?: string;
  accountId?: string | null;
  title?: string;
  description?: string | null;
  priority?: TaskPriority;
  isCompleted?: boolean;
  completedAt?: number | null;
  dueDate?: number | null;
  parentId?: string | null;
  threadId?: string | null;
  threadAccountId?: string | null;
  sortOrder?: number;
  recurrenceRule?: string | null;
  nextRecurrenceAt?: number | null;
  tags?: string[];
}

export interface DbTaskTag {
  tag: string;
  account_id: string | null;
  color: string | null;
  sort_order: number;
  created_at: number;
}

export interface TaskTag {
  tag: string;
  accountId: string | null;
  color: string | null;
  sortOrder: number;
  createdAt: number;
}

export function parseTagsJson(tagsJson: string | null | undefined): string[] {
  if (!tagsJson) return [];
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string');
    }
  } catch {
    // fall through
  }
  return [];
}

export function mapDbTask(db: DbTask): Task {
  return {
    id: db.id,
    accountId: db.account_id,
    title: db.title,
    description: db.description,
    priority: (db.priority as TaskPriority) ?? 'none',
    isCompleted: db.is_completed === 1,
    completedAt: db.completed_at,
    dueDate: db.due_date,
    parentId: db.parent_id,
    threadId: db.thread_id,
    threadAccountId: db.thread_account_id,
    sortOrder: db.sort_order,
    recurrenceRule: db.recurrence_rule,
    nextRecurrenceAt: db.next_recurrence_at,
    tags: parseTagsJson(db.tags_json),
    createdAt: db.created_at,
    updatedAt: db.updated_at,
  };
}

export function mapTaskInput(input: UpsertTaskInput): Record<string, unknown> {
  return {
    id: input.id,
    accountId: input.accountId,
    title: input.title,
    description: input.description,
    priority: input.priority,
    isCompleted: input.isCompleted,
    completedAt: input.completedAt,
    dueDate: input.dueDate,
    parentId: input.parentId,
    threadId: input.threadId,
    threadAccountId: input.threadAccountId,
    sortOrder: input.sortOrder,
    recurrenceRule: input.recurrenceRule,
    nextRecurrenceAt: input.nextRecurrenceAt,
    tagsJson: input.tags ? JSON.stringify(input.tags) : undefined,
  };
}

export async function getTasksForAccount(
  accountId: string,
  includeCompleted = false,
): Promise<Task[]> {
  const rows = await invoke<DbTask[]>('db_get_tasks_for_account', { accountId, includeCompleted });
  return rows.map(mapDbTask);
}

export async function getTasksForThread(
  threadAccountId: string,
  threadId: string,
): Promise<Task[]> {
  const rows = await invoke<DbTask[]>('db_get_tasks_for_thread', { threadAccountId, threadId });
  return rows.map(mapDbTask);
}

export async function getTaskById(id: string): Promise<Task | null> {
  const row = await invoke<DbTask | null>('db_get_task_by_id', { id });
  return row ? mapDbTask(row) : null;
}

export async function createTask(input: UpsertTaskInput): Promise<Task> {
  const id = await invoke<string>('db_insert_task', { input: mapTaskInput(input) });
  const task = await getTaskById(id);
  if (!task) throw new Error(`[tasks] created task ${id} not found`);
  return task;
}

export async function updateTask(id: string, updates: UpsertTaskInput): Promise<Task> {
  await invoke<void>('db_update_task', { id, updates: mapTaskInput(updates) });
  const task = await getTaskById(id);
  if (!task) throw new Error(`[tasks] updated task ${id} not found`);
  return task;
}

export async function deleteTask(id: string): Promise<void> {
  await invoke<void>('db_delete_task', { id });
}

export async function toggleTaskCompleted(id: string, completed: boolean): Promise<void> {
  await invoke<void>('db_toggle_task_completed', { id, completed });
}

export function mapDbTaskTag(db: DbTaskTag): TaskTag {
  return {
    tag: db.tag,
    accountId: db.account_id,
    color: db.color,
    sortOrder: db.sort_order,
    createdAt: db.created_at,
  };
}

export async function getTaskTags(accountId?: string): Promise<TaskTag[]> {
  const rows = await invoke<DbTaskTag[]>('db_get_task_tags', { accountId: accountId ?? null });
  return rows.map(mapDbTaskTag);
}

export async function createTaskTag(
  tag: string,
  accountId?: string | null,
  color?: string | null,
): Promise<void> {
  await invoke<void>('db_create_task_tag', {
    tag,
    accountId: accountId ?? null,
    color: color ?? null,
  });
}

export async function updateTaskTagColor(
  tag: string,
  accountId: string | null,
  color: string | null,
): Promise<void> {
  await invoke<void>('db_update_task_tag_color', { tag, accountId, color });
}

export async function deleteTaskTag(tag: string, accountId: string | null): Promise<void> {
  await invoke<void>('db_delete_task_tag', { tag, accountId });
}

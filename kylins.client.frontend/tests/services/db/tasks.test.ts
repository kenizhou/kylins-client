// Tests for the task service layer.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getTasksForAccount,
  getTasksForThread,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  toggleTaskCompleted,
  getTaskTags,
  createTaskTag,
  updateTaskTagColor,
  deleteTaskTag,
  mapDbTask,
  mapDbTaskTag,
  parseTagsJson,
  type DbTask,
  type DbTaskTag,
} from '@/services/db/tasks';
import { wireDefaultDbResults } from '@/test/mockInvoke';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

function makeDbTask(overrides: Partial<DbTask> = {}): DbTask {
  return {
    id: 'task-1',
    account_id: 'acc-1',
    title: 'Test task',
    description: null,
    priority: 'medium',
    is_completed: 0,
    completed_at: null,
    due_date: null,
    parent_id: null,
    thread_id: null,
    thread_account_id: null,
    sort_order: 0,
    recurrence_rule: null,
    next_recurrence_at: null,
    tags_json: '["work"]',
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function makeDbTaskTag(overrides: Partial<DbTaskTag> = {}): DbTaskTag {
  return {
    tag: 'work',
    account_id: 'acc-1',
    color: '#ff0000',
    sort_order: 0,
    created_at: 1000,
    ...overrides,
  };
}

describe('tasks service', () => {
  beforeEach(() => wireDefaultDbResults(mockInvoke));

  it('maps DB rows to UI tasks and parses tags JSON', () => {
    const task = mapDbTask(makeDbTask({ is_completed: 1, completed_at: 2000 }));
    expect(task.id).toBe('task-1');
    expect(task.isCompleted).toBe(true);
    expect(task.completedAt).toBe(2000);
    expect(task.priority).toBe('medium');
    expect(task.tags).toEqual(['work']);
  });

  it('returns empty tags for invalid JSON', () => {
    const task = mapDbTask(makeDbTask({ tags_json: 'not json' }));
    expect(task.tags).toEqual([]);
  });

  it('parseTagsJson handles null and non-array values', () => {
    expect(parseTagsJson(null)).toEqual([]);
    expect(parseTagsJson('{}')).toEqual([]);
    expect(parseTagsJson('["a", 1, "b"]')).toEqual(['a', 'b']);
  });

  it('getTasksForAccount maps rows and passes includeCompleted flag', async () => {
    mockInvoke.mockResolvedValueOnce([makeDbTask({ id: 't1' }), makeDbTask({ id: 't2' })]);
    const tasks = await getTasksForAccount('acc-1', true);
    expect(tasks).toHaveLength(2);
    expect(mockInvoke).toHaveBeenCalledWith('db_get_tasks_for_account', {
      accountId: 'acc-1',
      includeCompleted: true,
    });
  });

  it('getTasksForThread passes thread identifiers', async () => {
    mockInvoke.mockResolvedValueOnce([makeDbTask()]);
    await getTasksForThread('acc-1', 'thread-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_tasks_for_thread', {
      threadAccountId: 'acc-1',
      threadId: 'thread-1',
    });
  });

  it('getTaskById returns null when no row', async () => {
    mockInvoke.mockResolvedValueOnce(null);
    const task = await getTaskById('missing');
    expect(task).toBeNull();
  });

  it('createTask inserts and fetches the new task', async () => {
    mockInvoke
      .mockResolvedValueOnce('new-task-id')
      .mockResolvedValueOnce(makeDbTask({ id: 'new-task-id', title: 'New' }));
    const task = await createTask({ title: 'New', accountId: 'acc-1' });
    expect(task.id).toBe('new-task-id');
    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'db_insert_task', {
      input: expect.objectContaining({ title: 'New', accountId: 'acc-1' }),
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'db_get_task_by_id', { id: 'new-task-id' });
  });

  it('updateTask applies updates and refetches', async () => {
    mockInvoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(makeDbTask({ title: 'Updated' }));
    const task = await updateTask('task-1', { title: 'Updated' });
    expect(task.title).toBe('Updated');
    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'db_update_task', {
      id: 'task-1',
      updates: expect.objectContaining({ title: 'Updated' }),
    });
  });

  it('deleteTask invokes db_delete_task', async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await deleteTask('task-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_delete_task', { id: 'task-1' });
  });

  it('toggleTaskCompleted invokes db_toggle_task_completed', async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await toggleTaskCompleted('task-1', true);
    expect(mockInvoke).toHaveBeenCalledWith('db_toggle_task_completed', {
      id: 'task-1',
      completed: true,
    });
  });

  it('maps DB tags to UI tags', () => {
    const tag = mapDbTaskTag(makeDbTaskTag({ color: '#00ff00' }));
    expect(tag.tag).toBe('work');
    expect(tag.color).toBe('#00ff00');
  });

  it('getTaskTags passes accountId or null', async () => {
    mockInvoke.mockResolvedValueOnce([makeDbTaskTag()]);
    await getTaskTags('acc-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_task_tags', { accountId: 'acc-1' });
  });

  it('createTaskTag serializes null defaults', async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await createTaskTag('personal');
    expect(mockInvoke).toHaveBeenCalledWith('db_create_task_tag', {
      tag: 'personal',
      accountId: null,
      color: null,
    });
  });

  it('updateTaskTagColor and deleteTaskTag pass identifiers', async () => {
    mockInvoke.mockResolvedValue(undefined);
    await updateTaskTagColor('work', 'acc-1', '#000000');
    expect(mockInvoke).toHaveBeenCalledWith('db_update_task_tag_color', {
      tag: 'work',
      accountId: 'acc-1',
      color: '#000000',
    });

    mockInvoke.mockClear();
    await deleteTaskTag('work', 'acc-1');
    expect(mockInvoke).toHaveBeenCalledWith('db_delete_task_tag', {
      tag: 'work',
      accountId: 'acc-1',
    });
  });
});

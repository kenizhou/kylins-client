-- Add ON DELETE SET NULL foreign key from tasks to threads so that deleting a
-- thread preserves user-created tasks but clears the thread link.
-- SQLite does not support ALTER TABLE ADD FOREIGN KEY, so we recreate the table.

CREATE TABLE IF NOT EXISTS tasks_new (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT DEFAULT 'none',
  is_completed INTEGER DEFAULT 0,
  completed_at INTEGER,
  due_date INTEGER,
  parent_id TEXT,
  thread_id TEXT,
  thread_account_id TEXT,
  sort_order INTEGER DEFAULT 0,
  recurrence_rule TEXT,
  next_recurrence_at INTEGER,
  tags_json TEXT DEFAULT '[]',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (parent_id) REFERENCES tasks_new(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE SET NULL
);

INSERT INTO tasks_new SELECT * FROM tasks;

DROP INDEX IF EXISTS idx_tasks_account;
DROP INDEX IF EXISTS idx_tasks_completed_due;
DROP INDEX IF EXISTS idx_tasks_parent;
DROP INDEX IF EXISTS idx_tasks_thread;
DROP INDEX IF EXISTS idx_tasks_due;
DROP INDEX IF EXISTS idx_tasks_sort;

DROP TABLE tasks;

ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_tasks_completed_due ON tasks(is_completed, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_account_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks(sort_order);

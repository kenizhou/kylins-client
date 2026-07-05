//! Task / to-do domain query layer.
//!
//! Owns the `tasks` and `task_tags` tables. Tasks are local-first and can be
//! linked to an email thread via `thread_id` / `thread_account_id`.

use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/// Task row. Mirrors the TS `DbTask` interface; JSON keys are snake_case to
/// match the column names returned by sqlx.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct Task {
    pub id: String,
    pub account_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub priority: String,
    pub is_completed: i64,
    pub completed_at: Option<i64>,
    pub due_date: Option<i64>,
    pub parent_id: Option<String>,
    pub thread_id: Option<String>,
    pub thread_account_id: Option<String>,
    pub sort_order: i64,
    pub recurrence_rule: Option<String>,
    pub next_recurrence_at: Option<i64>,
    pub tags_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Input for [`insert`]/[`update`]. Mirrors TS `UpsertTaskInput`.
/// `Option<Option<T>>` distinguishes "set to NULL" from "not provided".
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpsertTaskInput {
    pub id: Option<String>,
    pub account_id: Option<Option<String>>,
    pub title: Option<String>,
    pub description: Option<Option<String>>,
    pub priority: Option<String>,
    pub is_completed: Option<bool>,
    pub completed_at: Option<Option<i64>>,
    pub due_date: Option<Option<i64>>,
    pub parent_id: Option<Option<String>>,
    pub thread_id: Option<Option<String>>,
    pub thread_account_id: Option<Option<String>>,
    pub sort_order: Option<i64>,
    pub recurrence_rule: Option<Option<String>>,
    pub next_recurrence_at: Option<Option<i64>>,
    pub tags_json: Option<String>,
}

/// Task tag row. Mirrors TS `TaskTag`. `account_id` is `None` for global tags.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct TaskTag {
    pub tag: String,
    pub account_id: Option<String>,
    pub color: Option<String>,
    pub sort_order: i64,
    pub created_at: i64,
}

fn row_to_task(row: &SqliteRow) -> Task {
    Task {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or(None),
        title: row.try_get("title").unwrap_or_default(),
        description: row.try_get("description").unwrap_or(None),
        priority: row.try_get("priority").unwrap_or_else(|_| "none".into()),
        is_completed: row.try_get("is_completed").unwrap_or(0),
        completed_at: row.try_get("completed_at").unwrap_or(None),
        due_date: row.try_get("due_date").unwrap_or(None),
        parent_id: row.try_get("parent_id").unwrap_or(None),
        thread_id: row.try_get("thread_id").unwrap_or(None),
        thread_account_id: row.try_get("thread_account_id").unwrap_or(None),
        sort_order: row.try_get("sort_order").unwrap_or(0),
        recurrence_rule: row.try_get("recurrence_rule").unwrap_or(None),
        next_recurrence_at: row.try_get("next_recurrence_at").unwrap_or(None),
        tags_json: row.try_get("tags_json").unwrap_or_else(|_| "[]".into()),
        created_at: row.try_get("created_at").unwrap_or(0),
        updated_at: row.try_get("updated_at").unwrap_or(0),
    }
}

fn row_to_task_tag(row: &SqliteRow) -> TaskTag {
    TaskTag {
        tag: row.try_get("tag").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or(None),
        color: row.try_get("color").unwrap_or(None),
        sort_order: row.try_get("sort_order").unwrap_or(0),
        created_at: row.try_get("created_at").unwrap_or(0),
    }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/// List tasks for an account. If `include_completed` is `false`, completed tasks
/// are omitted.
pub async fn list_for_account(
    pool: &SqlitePool,
    account_id: &str,
    include_completed: bool,
) -> Result<Vec<Task>, String> {
    let sql = if include_completed {
        "SELECT * FROM tasks WHERE account_id = $1 OR account_id IS NULL ORDER BY sort_order, created_at DESC"
    } else {
        "SELECT * FROM tasks WHERE (account_id = $1 OR account_id IS NULL) AND is_completed = 0 ORDER BY sort_order, created_at DESC"
    };
    let rows = sqlx::query(sql).bind(account_id).fetch_all(pool).await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_task).collect())
}

/// List tasks linked to a specific thread.
pub async fn list_for_thread(
    pool: &SqlitePool,
    thread_account_id: &str,
    thread_id: &str,
) -> Result<Vec<Task>, String> {
    let rows = sqlx::query(
        "SELECT * FROM tasks WHERE thread_account_id = $1 AND thread_id = $2 ORDER BY sort_order, created_at DESC",
    )
    .bind(thread_account_id)
    .bind(thread_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_task).collect())
}

/// Get a single task by id.
pub async fn get_by_id(pool: &SqlitePool, id: &str) -> Result<Option<Task>, String> {
    let row = sqlx::query("SELECT * FROM tasks WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(row_to_task))
}

/// Insert a new task. Returns the created task id.
pub async fn insert(pool: &SqlitePool, input: UpsertTaskInput) -> Result<String, String> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = now_secs();
    let title = input.title.unwrap_or_default();
    let priority = input.priority.unwrap_or_else(|| "none".into());
    let tags_json = input.tags_json.unwrap_or_else(|| "[]".into());
    let is_completed = input.is_completed.unwrap_or(false) as i64;
    let completed_at = input.completed_at.unwrap_or(None);
    let sort_order = input.sort_order.unwrap_or(0);

    sqlx::query(
        "INSERT INTO tasks (
            id, account_id, title, description, priority, is_completed, completed_at,
            due_date, parent_id, thread_id, thread_account_id, sort_order,
            recurrence_rule, next_recurrence_at, tags_json, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
    )
    .bind(&id)
    .bind(input.account_id.unwrap_or(None))
    .bind(&title)
    .bind(input.description.unwrap_or(None))
    .bind(&priority)
    .bind(is_completed)
    .bind(completed_at)
    .bind(input.due_date.unwrap_or(None))
    .bind(input.parent_id.unwrap_or(None))
    .bind(input.thread_id.unwrap_or(None))
    .bind(input.thread_account_id.unwrap_or(None))
    .bind(sort_order)
    .bind(input.recurrence_rule.unwrap_or(None))
    .bind(input.next_recurrence_at.unwrap_or(None))
    .bind(&tags_json)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(id)
}

/// Dynamic partial update of a task. No-op if no fields are provided.
pub async fn update(
    pool: &SqlitePool,
    id: &str,
    updates: UpsertTaskInput,
) -> Result<(), String> {
    let mut sets: Vec<(&str, crate::db::BindValue)> = Vec::new();

    if let Some(opt) = updates.account_id {
        sets.push(("account_id", opt.map(crate::db::BindValue::Text).unwrap_or(crate::db::BindValue::Null)));
    }
    if let Some(v) = updates.title {
        sets.push(("title", crate::db::BindValue::Text(v)));
    }
    if let Some(opt) = updates.description {
        sets.push(("description", opt.map(crate::db::BindValue::Text).unwrap_or(crate::db::BindValue::Null)));
    }
    if let Some(v) = updates.priority {
        sets.push(("priority", crate::db::BindValue::Text(v)));
    }
    if let Some(v) = updates.is_completed {
        sets.push(("is_completed", crate::db::BindValue::Int(if v { 1 } else { 0 })));
    }
    if let Some(opt) = updates.completed_at {
        sets.push(("completed_at", opt.map(crate::db::BindValue::Int).unwrap_or(crate::db::BindValue::Null)));
    }
    if let Some(opt) = updates.due_date {
        sets.push(("due_date", opt.map(crate::db::BindValue::Int).unwrap_or(crate::db::BindValue::Null)));
    }
    if let Some(opt) = updates.parent_id {
        sets.push(("parent_id", opt.map(crate::db::BindValue::Text).unwrap_or(crate::db::BindValue::Null)));
    }
    if let Some(opt) = updates.thread_id {
        sets.push(("thread_id", opt.map(crate::db::BindValue::Text).unwrap_or(crate::db::BindValue::Null)));
    }
    if let Some(opt) = updates.thread_account_id {
        sets.push(("thread_account_id", opt.map(crate::db::BindValue::Text).unwrap_or(crate::db::BindValue::Null)));
    }
    if let Some(v) = updates.sort_order {
        sets.push(("sort_order", crate::db::BindValue::Int(v)));
    }
    if let Some(opt) = updates.recurrence_rule {
        sets.push(("recurrence_rule", opt.map(crate::db::BindValue::Text).unwrap_or(crate::db::BindValue::Null)));
    }
    if let Some(opt) = updates.next_recurrence_at {
        sets.push(("next_recurrence_at", opt.map(crate::db::BindValue::Int).unwrap_or(crate::db::BindValue::Null)));
    }
    if let Some(v) = updates.tags_json {
        sets.push(("tags_json", crate::db::BindValue::Text(v)));
    }

    if !sets.is_empty() {
        sets.push(("updated_at", crate::db::BindValue::Int(now_secs())));
    }

    crate::db::exec_dynamic_update(pool, "tasks", "id", id, sets).await
}

/// Delete a task by id. Subtasks are cascade-deleted by the existing FK.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM tasks WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Toggle a task's completion status and set/unset `completed_at`.
pub async fn toggle_completed(
    pool: &SqlitePool,
    id: &str,
    completed: bool,
) -> Result<(), String> {
    let completed_at = if completed { Some(now_secs()) } else { None };
    sqlx::query(
        "UPDATE tasks SET is_completed = $1, completed_at = $2, updated_at = $3 WHERE id = $4",
    )
    .bind(if completed { 1 } else { 0 })
    .bind(completed_at)
    .bind(now_secs())
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/// List tags for an account, including global tags (`account_id IS NULL`).
pub async fn list_tags(
    pool: &SqlitePool,
    account_id: Option<&str>,
) -> Result<Vec<TaskTag>, String> {
    let rows = if let Some(account_id) = account_id {
        sqlx::query(
            "SELECT * FROM task_tags WHERE account_id = $1 OR account_id IS NULL ORDER BY sort_order, tag",
        )
        .bind(account_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
    } else {
        sqlx::query("SELECT * FROM task_tags ORDER BY sort_order, tag")
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?
    };
    Ok(rows.iter().map(row_to_task_tag).collect())
}

/// Create or update a tag. The PK is `(tag, account_id)` so this is effectively
/// an upsert for color/sort_order.
pub async fn create_tag(
    pool: &SqlitePool,
    tag: &str,
    account_id: Option<&str>,
    color: Option<&str>,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO task_tags (tag, account_id, color, sort_order, created_at)
         VALUES ($1, $2, $3, 0, unixepoch())
         ON CONFLICT(tag, account_id) DO UPDATE SET color = COALESCE($3, task_tags.color)",
    )
    .bind(tag)
    .bind(account_id)
    .bind(color)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Update a tag's color.
pub async fn update_tag_color(
    pool: &SqlitePool,
    tag: &str,
    account_id: Option<&str>,
    color: Option<&str>,
) -> Result<(), String> {
    sqlx::query("UPDATE task_tags SET color = $1 WHERE tag = $2 AND account_id = $3")
        .bind(color)
        .bind(tag)
        .bind(account_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a tag. Any tasks referencing it keep their `tags_json` entry; the UI
/// simply renders unknown tags as plain chips.
pub async fn delete_tag(
    pool: &SqlitePool,
    tag: &str,
    account_id: Option<&str>,
) -> Result<(), String> {
    sqlx::query("DELETE FROM task_tags WHERE tag = $1 AND account_id = $2")
        .bind(tag)
        .bind(account_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    #[tokio::test]
    async fn insert_and_get_by_id() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();

        let id = insert(
            &pool,
            UpsertTaskInput {
                title: Some("Test task".into()),
                priority: Some("high".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let task = get_by_id(&pool, &id).await.unwrap().unwrap();
        assert_eq!(task.title, "Test task");
        assert_eq!(task.priority, "high");
        assert_eq!(task.is_completed, 0);
    }

    #[tokio::test]
    async fn list_for_account_excludes_completed() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();

        insert(
            &pool,
            UpsertTaskInput {
                title: Some("Active".into()),
                account_id: Some(Some("acc1".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let completed_id = insert(
            &pool,
            UpsertTaskInput {
                title: Some("Done".into()),
                account_id: Some(Some("acc1".into())),
                is_completed: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let all = list_for_account(&pool, "acc1", true).await.unwrap();
        assert_eq!(all.len(), 2);

        let active = list_for_account(&pool, "acc1", false).await.unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].title, "Active");

        toggle_completed(&pool, &completed_id, false).await.unwrap();
        let active_after = list_for_account(&pool, "acc1", false).await.unwrap();
        assert_eq!(active_after.len(), 2);
    }

    #[tokio::test]
    async fn list_for_thread_filter() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();

        // The migration adds a FK from tasks to threads, so we need a matching
        // account + thread row before inserting a linked task.
        sqlx::query("INSERT INTO accounts (id, email) VALUES ($1, $2)")
            .bind("acc1")
            .bind("acc1@example.com")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO threads (id, account_id, subject) VALUES ($1, $2, $3)")
            .bind("th1")
            .bind("acc1")
            .bind("Thread subject")
            .execute(&pool)
            .await
            .unwrap();

        insert(
            &pool,
            UpsertTaskInput {
                title: Some("Linked".into()),
                thread_id: Some(Some("th1".into())),
                thread_account_id: Some(Some("acc1".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        insert(
            &pool,
            UpsertTaskInput {
                title: Some("Unlinked".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let linked = list_for_thread(&pool, "acc1", "th1").await.unwrap();
        assert_eq!(linked.len(), 1);
        assert_eq!(linked[0].title, "Linked");
    }

    #[tokio::test]
    async fn update_title_priority_due_date() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();

        let id = insert(
            &pool,
            UpsertTaskInput {
                title: Some("Old".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        update(
            &pool,
            &id,
            UpsertTaskInput {
                title: Some("New".into()),
                priority: Some("medium".into()),
                due_date: Some(Some(1750000000)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let task = get_by_id(&pool, &id).await.unwrap().unwrap();
        assert_eq!(task.title, "New");
        assert_eq!(task.priority, "medium");
        assert_eq!(task.due_date, Some(1750000000));
    }

    #[tokio::test]
    async fn toggle_completed_sets_timestamp() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();

        let id = insert(
            &pool,
            UpsertTaskInput {
                title: Some("Toggle me".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        toggle_completed(&pool, &id, true).await.unwrap();
        let task = get_by_id(&pool, &id).await.unwrap().unwrap();
        assert_eq!(task.is_completed, 1);
        assert!(task.completed_at.is_some());

        toggle_completed(&pool, &id, false).await.unwrap();
        let task = get_by_id(&pool, &id).await.unwrap().unwrap();
        assert_eq!(task.is_completed, 0);
        assert!(task.completed_at.is_none());
    }

    #[tokio::test]
    async fn delete_removes_task() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();

        let parent_id = insert(
            &pool,
            UpsertTaskInput {
                title: Some("Parent".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let child_id = insert(
            &pool,
            UpsertTaskInput {
                title: Some("Child".into()),
                parent_id: Some(Some(parent_id.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        delete(&pool, &parent_id).await.unwrap();
        assert!(get_by_id(&pool, &parent_id).await.unwrap().is_none());
        assert!(get_by_id(&pool, &child_id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn tag_crud() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();

        create_tag(&pool, "urgent", Some("acc1"), Some("#ff0000")).await.unwrap();
        create_tag(&pool, "global", None, Some("#00ff00")).await.unwrap();

        let tags = list_tags(&pool, Some("acc1")).await.unwrap();
        assert_eq!(tags.len(), 2);

        update_tag_color(&pool, "urgent", Some("acc1"), Some("#aa0000")).await.unwrap();
        let tags = list_tags(&pool, Some("acc1")).await.unwrap();
        let urgent = tags.iter().find(|t| t.tag == "urgent").unwrap();
        assert_eq!(urgent.color.as_deref(), Some("#aa0000"));

        delete_tag(&pool, "urgent", Some("acc1")).await.unwrap();
        let tags = list_tags(&pool, Some("acc1")).await.unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].tag, "global");
    }
}

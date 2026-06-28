//! Settings (key/value) query layer.
//!
//! Rust port of `kylins.client.frontend/src/services/settings.ts`. The
//! `settings` table is a simple `key TEXT PRIMARY KEY, value TEXT NOT NULL`
//! store seeded by the baseline migration. These helpers cover the six
//! accessors the frontend uses (`getSetting`, `setSetting`, `getSettingBool`,
//! `setSettingBool`, `getSettingNumber`, `setSettingNumber`), with identical
//! semantics:
//!
//! - bool is stored as the literal strings `"true"` / `"false"`
//! - number is stored as `String(value)`; parsing uses Rust's `f64::from_str`,
//!   and a non-numeric value parses to `None` (mirroring TS `Number.isNaN`)
//!
//! `INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)` is used for
//! writes so the row is created on first write and overwritten on update.

use sqlx::Row;
use sqlx::SqlitePool;

/// Return the raw string value for `key`, or `None` if the row is absent.
///
/// Mirrors `getSetting` (`settings.ts:3-9`).
pub async fn get(pool: &SqlitePool, key: &str) -> Result<Option<String>, String> {
    let row = sqlx::query("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| r.get::<String, _>("value")))
}

/// Upsert the raw string value for `key`.
///
/// Mirrors `setSetting` (`settings.ts:11-14`). Uses `INSERT OR REPLACE` so an
/// existing row is overwritten atomically.
pub async fn set(pool: &SqlitePool, key: &str, value: &str) -> Result<(), String> {
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Return the value parsed as a bool. `None` if the row is absent; `Some(bool)`
/// comparing the stored string against `"true"` (anything else is `false`),
/// matching `getSettingBool` (`settings.ts:16-20`).
pub async fn get_bool(pool: &SqlitePool, key: &str) -> Result<Option<bool>, String> {
    Ok(get(pool, key).await?.map(|v| v == "true"))
}

/// Store a bool as the literal `"true"` / `"false"` string, matching
/// `setSettingBool` (`settings.ts:22-24`).
pub async fn set_bool(pool: &SqlitePool, key: &str, value: bool) -> Result<(), String> {
    set(pool, key, if value { "true" } else { "false" }).await
}

/// Return the value parsed as an `f64`. `None` if the row is absent or the
/// stored value is not a valid number (TS: `Number.isNaN(parsed) ? null`).
/// Mirrors `getSettingNumber` (`settings.ts:26-31`).
pub async fn get_number(pool: &SqlitePool, key: &str) -> Result<Option<f64>, String> {
    match get(pool, key).await? {
        None => Ok(None),
        Some(raw) => Ok(raw.parse::<f64>().ok()),
    }
}

/// Store a number via `String(value)`. Mirrors `setSettingNumber`
/// (`settings.ts:33-35`). Note the TS version uses JS `String(value)` which
/// formats floats with the JS default; Rust's `f64::to_string` differs for
/// some edge cases (e.g. exponents), but for the settings this layer touches
/// (counts, delays, durations) the two agree.
pub async fn set_number(pool: &SqlitePool, key: &str, value: f64) -> Result<(), String> {
    set(pool, key, &value.to_string()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn get_returns_none_for_missing_key() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        assert!(get(&pool, "no.such.key").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn set_and_get_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        set(&pool, "theme", "dark").await.unwrap();
        assert_eq!(get(&pool, "theme").await.unwrap().as_deref(), Some("dark"));
    }

    #[tokio::test]
    async fn set_overwrites_existing_value() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        set(&pool, "k", "v1").await.unwrap();
        set(&pool, "k", "v2").await.unwrap();
        assert_eq!(get(&pool, "k").await.unwrap().as_deref(), Some("v2"));
    }

    #[tokio::test]
    async fn get_bool_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        // Missing key → None.
        assert!(get_bool(&pool, "flag").await.unwrap().is_none());

        set_bool(&pool, "flag", true).await.unwrap();
        assert_eq!(get_bool(&pool, "flag").await.unwrap(), Some(true));

        set_bool(&pool, "flag", false).await.unwrap();
        assert_eq!(get_bool(&pool, "flag").await.unwrap(), Some(false));
    }

    #[tokio::test]
    async fn get_bool_treats_non_true_as_false() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        // The TS implementation does `raw === 'true'`, so any other value
        // (including typos like "True" or "1") must read back as false.
        set(&pool, "flag", "True").await.unwrap();
        assert_eq!(get_bool(&pool, "flag").await.unwrap(), Some(false));
    }

    #[tokio::test]
    async fn get_number_roundtrip_and_nan() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        // Missing key → None.
        assert!(get_number(&pool, "n").await.unwrap().is_none());

        set_number(&pool, "n", 365.0).await.unwrap();
        assert_eq!(get_number(&pool, "n").await.unwrap(), Some(365.0));

        // Fractional value (TS uses String(value) and Number(raw)).
        set_number(&pool, "n", 0.5).await.unwrap();
        assert_eq!(get_number(&pool, "n").await.unwrap(), Some(0.5));
    }

    #[tokio::test]
    async fn get_number_returns_none_for_non_numeric() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        // Simulate a hand-written non-numeric value.
        set(&pool, "n", "not-a-number").await.unwrap();
        assert_eq!(get_number(&pool, "n").await.unwrap(), None);
    }

    #[tokio::test]
    async fn seeded_defaults_are_visible() {
        // The baseline migration seeds ~50 default settings; confirm we can
        // read one of them back through our helper. Guards against accidental
        // drift between the seed list and this module.
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        assert_eq!(
            get(&pool, "theme").await.unwrap().as_deref(),
            Some("system"),
            "default theme should be seeded"
        );
        assert_eq!(
            get_bool(&pool, "calendar_enabled").await.unwrap(),
            Some(false),
            "calendar_enabled should be seeded to false"
        );
        assert_eq!(
            get_number(&pool, "sync_period_days").await.unwrap(),
            Some(365.0),
            "sync_period_days should be seeded to 365"
        );
    }
}

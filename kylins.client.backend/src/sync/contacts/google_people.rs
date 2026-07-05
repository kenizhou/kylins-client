//! Google People API contact sync adapter (Phase 4 stub).
//!
//! Future implementation will use OAuth credentials on the account, call
//! `people.connections.list` with sync tokens, and map Person resources into
//! `ParsedContact` rows.

use async_trait::async_trait;

use crate::sync::contacts::source::{ContactSyncDelta, ContactSyncSource};

#[derive(Debug, Clone, Default)]
pub struct GooglePeopleSource;

#[async_trait]
impl ContactSyncSource for GooglePeopleSource {
    fn source_name(&self) -> &'static str {
        "google_people"
    }

    async fn initialize(
        &self,
        _pool: &sqlx::SqlitePool,
        _account_id: &str,
    ) -> Result<String, String> {
        Ok(String::new())
    }

    async fn sync(
        &self,
        _pool: &sqlx::SqlitePool,
        _account_id: &str,
        _token: &str,
    ) -> Result<ContactSyncDelta, String> {
        Ok(ContactSyncDelta::default())
    }
}

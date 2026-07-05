//! CardDAV contact sync adapter (Phase 3 stub).
//!
//! Future implementation will perform DNS SRV / `.well-known/carddav` discovery,
//! `sync-collection` REPORT with ctag/sync-token, and a multiget fallback for
//! individual vCards.

use async_trait::async_trait;

use crate::sync::contacts::source::{ContactSyncDelta, ContactSyncSource};

#[derive(Debug, Clone, Default)]
pub struct CardDavSource;

#[async_trait]
impl ContactSyncSource for CardDavSource {
    fn source_name(&self) -> &'static str {
        "carddav"
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

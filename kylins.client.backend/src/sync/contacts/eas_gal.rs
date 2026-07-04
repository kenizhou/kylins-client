//! EAS Global Address List (GAL) contact sync adapter (Phase 4 stub).
//!
//! Future implementation will issue `ResolveRecipients` / GAL Find requests via
//! the EAS client and map returned rows into `ParsedContact`.

use async_trait::async_trait;

use crate::sync::contacts::source::{ContactSyncDelta, ContactSyncSource};

#[derive(Debug, Clone, Default)]
pub struct EasGalSource;

#[async_trait]
impl ContactSyncSource for EasGalSource {
    fn source_name(&self) -> &'static str {
        "eas_gal"
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

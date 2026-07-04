//! Contact sync-source abstraction and dispatcher.
//!
//! Phase 0 ships the trait + stub adapters only. The runner is invoked from the
//! sync engine tail when an account has `account.{id}.contact_sync_source` set.
//!
//! Source precedence (highest to lowest):
//!   `carddav` / `google_people` / `eas_gal` > `local` > `mail`
//! Synced sources overwrite structured fields and mark the row read-only, but
//! preserve accumulated `frequency`.

use async_trait::async_trait;
use sqlx::SqlitePool;

use crate::db::contact_sync_state;
use crate::sync::contacts::types::ParsedContact;

/// Result of one contact-source sync pass.
#[derive(Debug, Clone, Default)]
pub struct ContactSyncDelta {
    /// Opaque continuation token / sync-token / ctag to persist for the next pass.
    pub token: String,
    /// Contacts to upsert. The primary email is used as the stable key.
    pub contacts: Vec<ParsedContact>,
    /// External IDs that disappeared on the server and should be deleted locally.
    pub removed_external_ids: Vec<String>,
}

/// Adapter trait for CardDAV, Google People, EAS GAL, etc.
#[async_trait]
pub trait ContactSyncSource: Send + Sync {
    fn source_name(&self) -> &'static str;

    /// One-time (or per-sync) discovery / token bootstrap. Called before `sync`
    /// when no persisted token exists for the account+source.
    async fn initialize(&self, _pool: &SqlitePool, _account_id: &str) -> Result<String, String> {
        Ok(String::new())
    }

    /// Perform one incremental sync pass. `token` is the value previously
    /// returned by `initialize` or the last `ContactSyncDelta::token`.
    async fn sync(
        &self,
        _pool: &SqlitePool,
        _account_id: &str,
        _token: &str,
    ) -> Result<ContactSyncDelta, String> {
        Ok(ContactSyncDelta::default())
    }
}

/// Resolve a source name to a stub adapter.
pub fn source_for_name(name: &str) -> Option<Box<dyn ContactSyncSource>> {
    match name {
        "carddav" => Some(Box::new(super::carddav::CardDavSource)),
        "google_people" => Some(Box::new(super::google_people::GooglePeopleSource)),
        "eas_gal" => Some(Box::new(super::eas_gal::EasGalSource)),
        _ => None,
    }
}

/// Run one contact-sync pass for `account_id` using the configured source.
/// The source name is read from `account.{account_id}.contact_sync_source`.
/// Failures are logged and returned so the caller can decide whether to fail
/// the whole sync round (contact sync is best-effort in Phase 0).
pub async fn run_for_account(pool: &SqlitePool, account_id: &str) -> Result<(), String> {
    let key = format!("account.{account_id}.contact_sync_source");
    let source_name = match crate::db::settings::get(pool, &key).await {
        Ok(Some(name)) => name,
        Ok(None) => return Ok(()),
        Err(e) => {
            log::warn!("[contacts] {account_id} failed to read contact_sync_source: {e}");
            return Ok(());
        }
    };

    let source = match source_for_name(&source_name) {
        Some(s) => s,
        None => {
            log::warn!(
                "[contacts] {account_id} unknown contact_sync_source: {source_name}"
            );
            return Ok(());
        }
    };

    let state = contact_sync_state::get(pool, account_id, &source_name).await?;
    let token = match state {
        Some(s) => s.sync_token,
        None => Some(source.initialize(pool, account_id).await?),
    };

    log::info!(
        "[contacts] {account_id} starting {source_name} sync (token_len={})",
        token.as_deref().map_or(0, |s| s.len())
    );
    let delta = source.sync(pool, account_id, token.as_deref().unwrap_or("")).await?;

    // Apply the delta. Phase 0 stubs return empty deltas, so this is currently a
    // no-op aside from persisting the token. When an adapter is implemented, the
    // upsert path must respect source precedence and preserve `frequency`.
    for _contact in &delta.contacts {
        // TODO: upsert preserving frequency, set source + is_readonly.
    }
    for _external_id in &delta.removed_external_ids {
        // TODO: delete local row by external_id for this account+source.
    }

    contact_sync_state::set(pool, account_id, &source_name, Some(&delta.token), None).await?;
    log::info!(
        "[contacts] {account_id} {source_name} sync done (upserted={}, removed={})",
        delta.contacts.len(),
        delta.removed_external_ids.len()
    );
    Ok(())
}

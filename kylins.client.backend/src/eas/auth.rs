//! EAS authentication strategies. The transport in `client.rs` calls
//! `auth.authorization_header()` to populate the `Authorization` header.
//!
//! `Basic` is the historical default. `OAuth` is required for Exchange Online
//! modern auth tenants — the access token is short-lived (~1h) and refreshed
//! on a 401 by the transport's retry layer.
//!
//! Phase 3b Task 3: type + refresh helper only. The transport wiring (selecting
//! Basic vs OAuth based on `EasConfig.auth_type`, calling `refresh()` on a 401)
//! lands in a later task.

use crate::eas::client::EasError;
use base64::Engine;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum EasAuth {
    Basic {
        username: String,
        password: String,
    },
    OAuth {
        access_token: String,
        /// OAuth2 refresh token. Required for unattended refresh; if absent,
        /// a 401 surfaces as `AuthRefreshFailed` (user must re-authenticate).
        refresh_token: Option<String>,
        /// Client ID registered with the IdP. Required to call the token endpoint.
        client_id: String,
        /// Client secret. Public clients (desktop apps) typically omit this and
        /// use PKCE instead — left optional and not validated here.
        client_secret: Option<String>,
        /// Token endpoint URL, e.g.
        /// `https://login.microsoftonline.com/common/oauth2/v2.0/token`.
        token_url: String,
        /// Space-separated scopes to request on refresh.
        scope: Option<String>,
    },
}

impl EasAuth {
    pub fn is_oauth(&self) -> bool {
        matches!(self, EasAuth::OAuth { .. })
    }

    /// Build the `Authorization` header value for the next request.
    pub fn authorization_header(&self) -> String {
        match self {
            EasAuth::Basic { username, password } => {
                let encoded = base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{}", username, password));
                format!("Basic {}", encoded)
            }
            EasAuth::OAuth { access_token, .. } => format!("Bearer {}", access_token),
        }
    }

    /// Refresh the access token (OAuth only). Basic is a no-op success.
    /// Mirrors `crate::oauth::oauth_refresh_token` (form-post + JSON parse) but
    /// operates on `&mut self` and rotates the access token (and refresh token,
    /// if the IdP returns a new one per RFC 6749 §6) in place.
    pub async fn refresh(&mut self) -> Result<(), EasError> {
        let (refresh_token, client_id, client_secret, scope, token_url) = match self {
            EasAuth::Basic { .. } => return Ok(()),
            EasAuth::OAuth {
                refresh_token,
                client_id,
                client_secret,
                scope,
                token_url,
                ..
            } => {
                let rt = refresh_token.clone().ok_or_else(|| {
                    EasError::AuthRefreshFailed("no refresh_token — user must re-authenticate".into())
                })?;
                (
                    rt,
                    client_id.clone(),
                    client_secret.clone(),
                    scope.clone(),
                    token_url.clone(),
                )
            }
        };

        let form = build_refresh_form(
            &refresh_token,
            &client_id,
            client_secret.as_deref(),
            scope.as_deref(),
        );
        let client = reqwest::Client::new();
        let resp = client
            .post(&token_url)
            .form(&form)
            .send()
            .await
            .map_err(|e| EasError::AuthRefreshFailed(format!("refresh request failed: {}", e)))?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(EasError::AuthRefreshFailed(format!("refresh status: {}", body)));
        }
        let parsed: RefreshResponse = resp
            .json()
            .await
            .map_err(|e| EasError::AuthRefreshFailed(format!("refresh parse: {}", e)))?;

        // Overwrite the access_token in place; adopt a rotated refresh_token if
        // the IdP returned one (RFC 6749 §6: refresh token MAY be rotated).
        if let EasAuth::OAuth {
            access_token,
            refresh_token,
            ..
        } = self
        {
            *access_token = parsed.access_token;
            if let Some(new_rt) = parsed.refresh_token {
                *refresh_token = Some(new_rt);
            }
        }
        Ok(())
    }
}

/// Build the x-www-form-urlencoded body for a refresh_token grant.
/// Pure / no I/O so it's directly testable without a network mock.
pub fn build_refresh_form(
    refresh_token: &str,
    client_id: &str,
    client_secret: Option<&str>,
    scope: Option<&str>,
) -> Vec<(String, String)> {
    let mut v = vec![
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("refresh_token".to_string(), refresh_token.to_string()),
        ("client_id".to_string(), client_id.to_string()),
    ];
    if let Some(s) = client_secret {
        v.push(("client_secret".to_string(), s.to_string()));
    }
    if let Some(s) = scope {
        v.push(("scope".to_string(), s.to_string()));
    }
    v
}

/// Successful token-refresh response (subset of RFC 6749 §5.1). Only the
/// fields we read are modeled; `expires_in` / `scope` / `id_token` are
/// ignored — the EAS transport only needs the new access token.
#[derive(serde::Deserialize)]
struct RefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_authorization_header_is_base64() {
        let auth = EasAuth::Basic {
            username: "alice".into(),
            password: "s3cret".into(),
        };
        assert_eq!(auth.authorization_header(), "Basic YWxpY2U6czNjcmV0");
        assert!(!auth.is_oauth());
    }

    #[tokio::test]
    async fn build_refresh_form_fields() {
        // Pure-form test: no network, no mock. Asserts the grant_type,
        // refresh_token, client_id are always present and that client_secret /
        // scope are appended only when supplied. Mirrors the contract of
        // `crate::oauth::oauth_refresh_token`'s form body.
        let form = build_refresh_form("rtok", "cid", Some("csec"), Some("scope"));
        assert_eq!(
            form.iter().find(|(k, _)| k == "grant_type").unwrap().1,
            "refresh_token"
        );
        assert_eq!(
            form.iter().find(|(k, _)| k == "refresh_token").unwrap().1,
            "rtok"
        );
        assert_eq!(
            form.iter().find(|(k, _)| k == "client_id").unwrap().1,
            "cid"
        );
        assert_eq!(
            form.iter().find(|(k, _)| k == "client_secret").unwrap().1,
            "csec"
        );
        assert_eq!(form.iter().find(|(k, _)| k == "scope").unwrap().1, "scope");
    }

    #[test]
    fn oauth_authorization_header_is_bearer() {
        // The plan's `EasAuth::OAuth { access_token: .., ..Default::default() }`
        // shorthand does not work on an enum (enums have no `Default`). Construct
        // the OAuth variant explicitly with all fields.
        let auth = EasAuth::OAuth {
            access_token: "ATOM".into(),
            refresh_token: None,
            client_id: "cid".into(),
            client_secret: None,
            token_url: "https://example.invalid/token".into(),
            scope: None,
        };
        assert_eq!(auth.authorization_header(), "Bearer ATOM");
        assert!(auth.is_oauth());
    }
}

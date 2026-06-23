// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Serialize)]
pub struct OAuthResult {
    pub code: String,
    pub state: String,
}

/// Binds to a localhost port for OAuth callback. Tries the given port first,
/// falls back to nearby ports if taken.
#[tauri::command]
pub async fn start_oauth_server(port: u16, state: String) -> Result<OAuthResult, String> {
    let mut listener = None;
    for p in [port, port + 1, port + 2, port + 3] {
        match TcpListener::bind(format!("127.0.0.1:{}", p)).await {
            Ok(l) => {
                listener = Some(l);
                break;
            }
            Err(_) => continue,
        }
    }

    let listener = listener.ok_or("Failed to bind to any port")?;
    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get addr: {}", e))?
        .port();

    log::info!("OAuth callback server listening on port {}", actual_port);

    // Wait for exactly one connection (the redirect from the IdP) with 5-minute timeout
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(300), listener.accept())
        .await
        .map_err(|_| "OAuth timed out — please try again".to_string())?
        .map_err(|e| format!("Failed to accept: {}", e))?;

    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read: {}", e))?;
    let request = String::from_utf8_lossy(&buf[..n]);

    let (code, returned_state) = parse_auth_code_and_state(&request)?;

    if returned_state != state {
        return Err("OAuth state mismatch — possible CSRF attack".to_string());
    }

    let html = r#"<!DOCTYPE html>
<html>
<head><title>Kylins Mail</title></head>
<body style="font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0;">
<div style="text-align: center;">
<h1 style="margin-bottom: 8px;">Account Connected!</h1>
<p style="opacity: 0.7;">You can close this tab and return to Kylins Mail.</p>
</div>
</body>
</html>"#;

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );

    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;

    drop(listener);

    Ok(OAuthResult {
        code,
        state: returned_state,
    })
}

fn parse_auth_code_and_state(request: &str) -> Result<(String, String), String> {
    let first_line = request.lines().next().ok_or("Empty request")?;

    let path = first_line
        .split_whitespace()
        .nth(1)
        .ok_or("No path in request")?;

    if path.contains("error=") {
        let params = parse_query_string(path);
        let error = params.get("error").cloned().unwrap_or_default();
        return Err(format!("OAuth error: {}", error));
    }

    let params = parse_query_string(path);
    let code = params
        .get("code")
        .cloned()
        .ok_or_else(|| "No auth code in redirect".to_string())?;
    let state = params
        .get("state")
        .cloned()
        .ok_or_else(|| "No state in redirect".to_string())?;
    Ok((code, state))
}

fn parse_query_string(path: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    if let Some(query) = path.split('?').nth(1) {
        for pair in query.split('&') {
            let mut kv = pair.splitn(2, '=');
            if let (Some(key), Some(value)) = (kv.next(), kv.next()) {
                params.insert(key.to_string(), urlencoding_decode(value));
            }
        }
    }
    params
}

fn urlencoding_decode(s: &str) -> String {
    let mut result = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                result.push(byte);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            result.push(b' ');
        } else {
            result.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| s.to_string())
}

#[derive(Serialize, Deserialize)]
pub struct TokenExchangeResult {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
    pub token_type: String,
    pub scope: Option<String>,
    pub id_token: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencoding_decode_plain() {
        assert_eq!(urlencoding_decode("hello"), "hello");
    }

    #[test]
    fn urlencoding_decode_plus() {
        assert_eq!(urlencoding_decode("hello+world"), "hello world");
    }

    #[test]
    fn urlencoding_decode_percent_hex() {
        assert_eq!(urlencoding_decode("%41%42%43"), "ABC");
    }

    #[test]
    fn urlencoding_decode_mixed() {
        // "hello world+foo+bar%2Cbaz" → "hello world foo bar,baz"
        assert_eq!(urlencoding_decode("hello+world%2Cfoo"), "hello world,foo");
    }

    #[test]
    fn urlencoding_decode_utf8_percent_encoded() {
        // U+00E9 (é) is 0xC3 0xA9 in UTF-8 → %C3%A9
        assert_eq!(urlencoding_decode("caf%C3%A9"), "café");
    }

    #[test]
    fn urlencoding_decode_truncated_percent_treated_literally() {
        // "%4" is too short to be a valid percent-escape — fall back to literal byte
        assert_eq!(urlencoding_decode("%4"), "%4");
    }

    #[test]
    fn urlencoding_decode_empty() {
        assert_eq!(urlencoding_decode(""), "");
    }

    #[test]
    fn parse_query_string_simple() {
        let params = parse_query_string("/cb?code=abc&state=xyz");
        assert_eq!(params.get("code"), Some(&"abc".to_string()));
        assert_eq!(params.get("state"), Some(&"xyz".to_string()));
    }

    #[test]
    fn parse_query_string_url_encoded_values() {
        let params = parse_query_string("/cb?state=a+b%20c");
        assert_eq!(params.get("state"), Some(&"a b c".to_string()));
    }

    #[test]
    fn parse_query_string_no_query_returns_empty() {
        let params = parse_query_string("/cb");
        assert!(params.is_empty());
    }

    #[test]
    fn parse_query_string_empty_query_returns_empty() {
        let params = parse_query_string("/cb?");
        assert!(params.is_empty());
    }

    #[test]
    fn parse_query_string_ignores_lone_keys() {
        let params = parse_query_string("/cb?code=abc&lone");
        assert_eq!(params.len(), 1);
        assert!(params.contains_key("code"));
    }

    #[test]
    fn parse_auth_code_and_state_happy_path() {
        let request =
            "GET /cb?code=AUTH_CODE_123&state=CSRF_456 HTTP/1.1\r\nHost: localhost:1420\r\n\r\n";
        let (code, state) = parse_auth_code_and_state(request).expect("parse");
        assert_eq!(code, "AUTH_CODE_123");
        assert_eq!(state, "CSRF_456");
    }

    #[test]
    fn parse_auth_code_and_state_with_url_encoded_special_chars() {
        let request = "GET /cb?code=abc%2B123&state=xyz HTTP/1.1\r\n\r\n";
        let (code, state) = parse_auth_code_and_state(request).expect("parse");
        assert_eq!(code, "abc+123");
        assert_eq!(state, "xyz");
    }

    #[test]
    fn parse_auth_code_and_state_missing_code() {
        let request = "GET /cb?state=xyz HTTP/1.1\r\n\r\n";
        assert!(parse_auth_code_and_state(request).is_err());
    }

    #[test]
    fn parse_auth_code_and_state_server_error() {
        let request =
            "GET /cb?error=access_denied&error_description=user+cancelled HTTP/1.1\r\n\r\n";
        let result = parse_auth_code_and_state(request);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("access_denied"), "error message: {err}");
    }

    #[test]
    fn parse_auth_code_and_state_empty_request() {
        assert!(parse_auth_code_and_state("").is_err());
    }

    #[test]
    fn parse_auth_code_and_state_no_path() {
        let request = "NOT_AN_HTTP_REQUEST\r\n";
        assert!(parse_auth_code_and_state(request).is_err());
    }
}

/// Exchange an OAuth authorization code for tokens via Rust HTTP client (avoids CORS).
#[tauri::command]
pub async fn oauth_exchange_token(
    token_url: String,
    code: String,
    client_id: String,
    redirect_uri: String,
    code_verifier: Option<String>,
    client_secret: Option<String>,
    scope: Option<String>,
) -> Result<TokenExchangeResult, String> {
    let mut params = vec![
        ("code", code),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code".to_string()),
    ];
    if let Some(verifier) = code_verifier {
        params.push(("code_verifier", verifier));
    }
    if let Some(secret) = client_secret {
        if !secret.is_empty() {
            params.push(("client_secret", secret));
        }
    }
    if let Some(s) = scope {
        params.push(("scope", s));
    }

    let client = reqwest::Client::new();
    let response = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {}", e))?;

    if !response.status().is_success() {
        let error = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Token exchange failed: {}", error));
    }

    response
        .json::<TokenExchangeResult>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))
}

/// Refresh an OAuth token via Rust HTTP client (avoids CORS).
#[tauri::command]
pub async fn oauth_refresh_token(
    token_url: String,
    refresh_token: String,
    client_id: String,
    client_secret: Option<String>,
    scope: Option<String>,
) -> Result<TokenExchangeResult, String> {
    let mut params = vec![
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(secret) = client_secret {
        if !secret.is_empty() {
            params.push(("client_secret", secret));
        }
    }
    if let Some(s) = scope {
        params.push(("scope", s));
    }

    let client = reqwest::Client::new();
    let response = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {}", e))?;

    if !response.status().is_success() {
        let error = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("Token refresh failed: {}", error));
    }

    response
        .json::<TokenExchangeResult>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))
}

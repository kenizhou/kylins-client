//! Exchange AutoDiscover — resolves the EAS URL for a user's email.
//!
//! Two flows, tried in order:
//!   1. V1 POX — POST the mobilesync XML envelope to
//!      `https://<domain>/autodiscover/autodiscover.xml` (and the same path on
//!      `autodiscover.<domain>`). Parse the `<MobileSync><Server><Url>` from
//!      the XML response. Follow `<Redirect><Url>` up to MAX_REDIRECTS hops.
//!   2. V2 JSON — GET `https://autodiscover-s.outlook.com/autodiscover/autodiscover.json?Email=<email>`
//!      and read `Url` from the JSON. The V2 endpoint returns the canonical
//!      Exchange Online EAS URL for any M365 mailbox.
//!
//! HTTP 301/302/303 redirects on the V1 endpoint also count toward
//! MAX_REDIRECTS. POX `<Action>redirect</Action>` + `<Redirect><Url>` is the
//! in-body redirect signal.
//!
//! Parsing note: the POX response is parsed with a regex-free tag-scan (the
//! `find_tag` helper), NOT a full XML parser. The response shape is server-
//! controlled and stable, and the EAS crate already ships a hand-written
//! WBXML codec; adding `quick-xml` for ~3 tags is out of proportion. Robust
//! XML parsing is a documented deferred hardening item.

use serde::Deserialize;

const MAX_REDIRECTS: u8 = 3;

#[derive(Debug, thiserror::Error)]
pub enum AutoDiscoverError {
    #[error("HTTP {status}: {body}")]
    HttpStatus { status: u16, body: String },
    #[error("transport: {0}")]
    Transport(String),
    #[error("parse: {0}")]
    Parse(String),
    #[error("redirect loop exceeded {0} hops")]
    TooManyRedirects(u8),
    #[error("no EAS URL found in any flow")]
    NotFound,
}

#[derive(Debug, Clone)]
pub struct AutodiscoverResult {
    pub eas_url: String,
}

/// Outcome of parsing one V1 POX response body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoxOutcome {
    /// `<MobileSync><Server><Url>` — the EAS endpoint to use.
    Server(String),
    /// `<Action>redirect</Action>` + `<Redirect><Url>` — re-issue the request
    /// to this URL (counts toward MAX_REDIRECTS).
    Redirect(String),
}

/// Run the full flow: V1 POX (with redirects) on the email's domain and
/// `autodiscover.<domain>`, then V2 JSON fallback for Exchange Online.
///
/// V1 is tried first because on-prem Exchange won't be reachable via the V2
/// Outlook Online endpoint; V2 is the reliable fallback for M365 mailboxes.
pub async fn autodiscover(
    email: &str,
    http: &reqwest::Client,
) -> Result<AutodiscoverResult, AutoDiscoverError> {
    let domain = email.rsplit_once('@').map(|(_, d)| d).ok_or_else(|| {
        AutoDiscoverError::Parse(format!("not an email: {}", email))
    })?;
    let v1_candidates = [
        format!("https://{}/autodiscover/autodiscover.xml", domain),
        format!("https://autodiscover.{}/autodiscover/autodiscover.xml", domain),
    ];
    for base in v1_candidates {
        match try_v1_pox(base.clone(), email, http).await {
            Ok(url) => return Ok(AutodiscoverResult { eas_url: url }),
            Err(AutoDiscoverError::NotFound) => continue,
            Err(e) => {
                log::debug!("AutoDiscover V1 {} failed: {}", base, e);
                continue;
            }
        }
    }
    // V2 fallback.
    let url = try_v2_json(email, http).await?;
    Ok(AutodiscoverResult { eas_url: url })
}

/// POST the mobilesync envelope to `url` and follow HTTP + POX redirects up to
/// MAX_REDIRECTS hops. Returns the resolved EAS URL on `PoxOutcome::Server`.
async fn try_v1_pox(
    url: String,
    email: &str,
    http: &reqwest::Client,
) -> Result<String, AutoDiscoverError> {
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">
  <Request>
    <AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/mobilesync/responseschema/2006</AcceptableResponseSchema>
    <EMailAddress>{}</EMailAddress>
  </Request>
</Autodiscover>"#,
        email
    );
    let mut current_url = url;
    for _ in 0..MAX_REDIRECTS {
        let resp = http
            .post(&current_url)
            .header("Content-Type", "text/xml")
            .body(body.clone())
            .send()
            .await
            .map_err(|e| AutoDiscoverError::Transport(e.to_string()))?;
        let status = resp.status().as_u16();
        if status == 301 || status == 302 || status == 303 {
            if let Some(loc) = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
            {
                current_url = loc.to_string();
                continue;
            }
        }
        if status != 200 {
            let b = resp.text().await.unwrap_or_default();
            return Err(AutoDiscoverError::HttpStatus { status, body: b });
        }
        let text = resp
            .text()
            .await
            .map_err(|e| AutoDiscoverError::Transport(e.to_string()))?;
        match parse_v1_pox_response(&text)? {
            PoxOutcome::Server(u) => return Ok(u),
            PoxOutcome::Redirect(u) => {
                current_url = u;
                continue;
            }
        }
    }
    Err(AutoDiscoverError::TooManyRedirects(MAX_REDIRECTS))
}

/// Parse a V1 POX response body. Tag-scan (NOT a full XML parser) — see the
/// module docs.
///
/// - `<Error>` anywhere → `Parse` error.
/// - `<Action>redirect</Action>` (case-insensitive whitespace trim) →
///   `Redirect(<Redirect><Url>)`.
/// - Otherwise the first `<Url>` (the `<MobileSync><Server><Url>`) → `Server`.
/// - None of the above → `NotFound`.
pub fn parse_v1_pox_response(body: &str) -> Result<PoxOutcome, AutoDiscoverError> {
    if find_tag(body, "Error").is_some() {
        return Err(AutoDiscoverError::Parse("server returned <Error>".into()));
    }
    if let Some(action) = find_tag(body, "Action") {
        if action.trim().eq_ignore_ascii_case("redirect") {
            let url = find_tag(body, "Url")
                .ok_or_else(|| AutoDiscoverError::Parse("redirect without <Url>".into()))?;
            return Ok(PoxOutcome::Redirect(url));
        }
    }
    // MobileSync Server Url — the first <Url> in the document.
    if let Some(url) = find_tag(body, "Url") {
        return Ok(PoxOutcome::Server(url));
    }
    Err(AutoDiscoverError::NotFound)
}

/// GET the V2 JSON endpoint and read `Url`.
async fn try_v2_json(email: &str, http: &reqwest::Client) -> Result<String, AutoDiscoverError> {
    let url = format!(
        "https://autodiscover-s.outlook.com/autodiscover/autodiscover.json?Email={}",
        email
    );
    let resp = http
        .get(&url)
        .send()
        .await
        .map_err(|e| AutoDiscoverError::Transport(e.to_string()))?;
    let status = resp.status().as_u16();
    if status != 200 {
        let b = resp.text().await.unwrap_or_default();
        return Err(AutoDiscoverError::HttpStatus { status, body: b });
    }
    let text = resp
        .text()
        .await
        .map_err(|e| AutoDiscoverError::Transport(e.to_string()))?;
    parse_v2_json_response(&text)
}

#[derive(Deserialize)]
struct V2Response {
    #[serde(rename = "Url")]
    url: String,
    #[serde(rename = "Protocol", default = "default_protocol")]
    _protocol: String,
}
fn default_protocol() -> String {
    String::new()
}

/// Parse the V2 JSON response: `{"Url":"...","Protocol":"ActiveSync"}`. Only
/// `Url` is required; `Protocol` is ignored (defaulted if absent).
pub fn parse_v2_json_response(body: &str) -> Result<String, AutoDiscoverError> {
    let parsed: V2Response = serde_json::from_str(body)
        .map_err(|e| AutoDiscoverError::Parse(format!("V2 JSON: {}", e)))?;
    Ok(parsed.url)
}

/// Find the inner text of the first `<tag ...>...</tag>` occurrence. Naive
/// tag-scan — does NOT handle namespaces, CDATA, or self-closing tags, and
/// only finds the FIRST occurrence. Sufficient for AutoDiscover's fixed
/// server-controlled response shape.
///
/// Handles an opening tag with attributes (e.g. `<Url foo="bar">`) by scanning
/// forward from `<tag` to the `>` that closes the opening tag; the inner text
/// starts immediately after that `>`.
fn find_tag(body: &str, tag: &str) -> Option<String> {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let open_start = body.find(&open)?;
    // Text starts right after the `>` that closes the opening tag. The opening
    // tag may contain attributes (`<Url foo="bar">`) so we scan forward from
    // the start of `<tag` to the first `>`.
    let text_start = body[open_start..].find('>')? + open_start + 1;
    let text_end = body[text_start..].find(&close)? + text_start;
    Some(body[text_start..text_end].trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::{parse_v1_pox_response, parse_v2_json_response, PoxOutcome};

    #[test]
    fn parse_v1_pox_extracts_server_url() {
        let body = r#"<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response>
    <User><AutoDiscoverEmail>alice@contoso.com</AutoDiscoverEmail></User>
    <Action>Settings</Action>
    <MobileSync>
      <Server>
        <Type>MobileSync</Type>
        <Url>https://mail.contoso.com/Microsoft-Server-ActiveSync</Url>
        <Name>https://mail.contoso.com/Microsoft-Server-ActiveSync</Name>
      </Server>
    </MobileSync>
  </Response>
</Autodiscover>"#;
        let parsed = parse_v1_pox_response(body).unwrap();
        match parsed {
            PoxOutcome::Server(url) => assert_eq!(url, "https://mail.contoso.com/Microsoft-Server-ActiveSync"),
            _ => panic!("expected Server outcome"),
        }
    }

    #[test]
    fn parse_v1_pox_returns_redirect_when_action_redirect() {
        let body = r#"<Autodiscover xmlns="...">
      <Response><Action>redirect</Action><Redirect><Url>https://contoso.onmicrosoft.com/autodiscover/autodiscover.xml</Url></Redirect></Response>
    </Autodiscover>"#;
        let parsed = parse_v1_pox_response(body).unwrap();
        match parsed {
            PoxOutcome::Redirect(url) => assert!(url.contains("contoso.onmicrosoft.com")),
            _ => panic!("expected Redirect"),
        }
    }

    #[test]
    fn parse_v2_json_extracts_url() {
        let body = r#"{"Url":"https://outlook.office365.com/Microsoft-Server-ActiveSync","Protocol":"ActiveSync"}"#;
        let url = parse_v2_json_response(body).unwrap();
        assert_eq!(url, "https://outlook.office365.com/Microsoft-Server-ActiveSync");
    }

    #[test]
    fn parse_v1_pox_rejects_error_response() {
        let body = r#"<Autodiscover xmlns="..."><Response><Error><ErrorCode>500</ErrorCode><Message>Invalid request</Message></Error></Response></Autodiscover>"#;
        assert!(parse_v1_pox_response(body).is_err());
    }
}

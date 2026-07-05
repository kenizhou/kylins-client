//! Header address parsing utilities.
//!
//! Parses the comma/semicolon separated strings produced by the IMAP layer's
//! `format_address_list` (e.g. `"Alice <alice@example.com>, bob@example.com"`)
//! into normalized (display_name, email) pairs. The parser is intentionally
//! permissive: malformed tokens are skipped rather than causing sync failures.

/// Parse a header value such as `To`, `Cc`, `Reply-To`, or `From` into a list
/// of normalized `(display_name, email)` pairs.
///
/// Supported forms:
/// - `"Display Name" <email@example.com>`
/// - `Display Name <email@example.com>`
/// - `email@example.com`
/// - comma/semicolon separated combinations of the above
///
/// Display names are trimmed and surrounding quotes are removed. Emails are
/// lower-cased and whitespace-trimmed. Empty or malformed tokens are ignored.
pub fn parse_address_header(value: &str) -> Vec<(Option<String>, String)> {
    let value = value.replace('\n', ", ").replace('\r', "");
    let tokens = split_address_tokens(&value);

    let mut result = Vec::new();
    for token in tokens {
        if let Some((name, email)) = parse_address_token(token.trim()) {
            if is_valid_email(&email) {
                result.push((name, email));
            }
        }
    }
    result
}

/// Split a header value on top-level commas and semicolons, ignoring commas
/// inside double-quoted display names.
fn split_address_tokens(value: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut start = 0;
    let mut in_quotes = false;
    let bytes = value.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        let c = bytes[i] as char;
        if c == '"' {
            // Toggle quote state unless escaped.
            if i == 0 || bytes[i - 1] as char != '\\' {
                in_quotes = !in_quotes;
            }
        } else if !in_quotes && (c == ',' || c == ';') {
            if i > start {
                tokens.push(&value[start..i]);
            }
            start = i + 1;
        }
        i += 1;
    }

    if start < value.len() {
        tokens.push(&value[start..]);
    }
    tokens
}

/// Parse a single address token into `(display_name, email)`.
fn parse_address_token(token: &str) -> Option<(Option<String>, String)> {
    if token.is_empty() {
        return None;
    }

    // Form: "Display Name" <email> or Display Name <email>
    if let Some(lt) = token.rfind('<') {
        if let Some(gt) = token[lt..].find('>') {
            let email = token[lt + 1..lt + gt].trim().to_lowercase();
            let name = token[..lt].trim();
            let name = clean_display_name(name);
            return Some((name, email));
        }
    }

    // Form: email
    if token.contains('@') && !token.contains(' ') {
        let email = token.trim().to_lowercase();
        return Some((None, email));
    }

    // Form: email (Display Name)
    if let Some(paren) = token.find('(') {
        if let Some(close) = token[paren..].find(')') {
            let email_part = token[..paren].trim();
            if email_part.contains('@') {
                let name = token[paren + 1..paren + close].trim();
                let name = clean_display_name(name);
                return Some((name, email_part.to_lowercase()));
            }
        }
    }

    None
}

/// Remove surrounding quotes and collapse whitespace from a display name.
fn clean_display_name(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let name = name
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(name);
    let name = name.replace("\\\"", "\"");
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Minimal email sanity check: must have non-empty local part and a domain
/// that contains at least one dot. This is intentionally looser than a full
/// RFC 5322 parser; the goal is to skip obvious garbage without rejecting
/// real-world addresses.
fn is_valid_email(email: &str) -> bool {
    if email.is_empty() {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    if local.trim().is_empty() || domain.trim().is_empty() {
        return false;
    }
    let domain = domain.trim();
    // Reject IP-literal-only domains and domains without a dot.
    if domain.starts_with('[') && domain.ends_with(']') {
        return false;
    }
    domain.contains('.')
}

/// Return true if the email address or display name looks like a robot,
/// no-reply, mailing list, or bulk sender and should not be recorded.
pub fn is_unworthy_address(email: &str, display_name: Option<&str>) -> bool {
    if let Some(name) = display_name {
        let lower = name.to_lowercase();
        if lower.contains(" via ") {
            return true;
        }
    }

    let local = match email.split_once('@') {
        Some((local, _)) => local,
        None => return true,
    };
    let local = local.to_lowercase();

    const UNWORTHY: &[&str] = &[
        "noreply",
        "no-reply",
        "no_reply",
        "donotreply",
        "do-not-reply",
        "do_not_reply",
        "unsubscribe",
        "notification",
        "notifications",
        "notify",
        "bounce",
        "bounces",
        "news",
        "newsletter",
        "marketing",
        "sales",
        "support",
        "mailer-daemon",
        "postmaster",
        "daemon",
    ];

    UNWORTHY.iter().any(|prefix| {
        local == *prefix
            || local.starts_with(&format!("{prefix}."))
            || local.starts_with(&format!("{prefix}+"))
            || local.starts_with(&format!("{prefix}-"))
            || local.starts_with(&format!("{prefix}_"))
            || local.ends_with(&format!(".{prefix}"))
            || local.ends_with(&format!("+{prefix}"))
            || local.ends_with(&format!("-{prefix}"))
            || local.ends_with(&format!("_{prefix}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_plain_email() {
        let got = parse_address_header("alice@example.com");
        assert_eq!(got, vec![(None, "alice@example.com".into())]);
    }

    #[test]
    fn test_parse_name_angle_email() {
        let got = parse_address_header("Alice Smith <alice@example.com>");
        assert_eq!(
            got,
            vec![(Some("Alice Smith".into()), "alice@example.com".into())]
        );
    }

    #[test]
    fn test_parse_quoted_name() {
        let got = parse_address_header(r#""Alice Smith" <alice@example.com>"#);
        assert_eq!(
            got,
            vec![(Some("Alice Smith".into()), "alice@example.com".into())]
        );
    }

    #[test]
    fn test_parse_multiple() {
        let got = parse_address_header(
            "Alice <alice@example.com>; bob@example.com, Charlie <charlie@example.co.uk>",
        );
        assert_eq!(
            got,
            vec![
                (Some("Alice".into()), "alice@example.com".into()),
                (None, "bob@example.com".into()),
                (Some("Charlie".into()), "charlie@example.co.uk".into()),
            ]
        );
    }

    #[test]
    fn test_parse_lowercases_and_trims() {
        let got = parse_address_header("  ALICE@EXAMPLE.COM  ");
        assert_eq!(got, vec![(None, "alice@example.com".into())]);
    }

    #[test]
    fn test_parse_ignores_malformed() {
        let got = parse_address_header("Alice <alice@example.com>, not-an-email, Bob <bob@>");
        assert_eq!(
            got,
            vec![
                (Some("Alice".into()), "alice@example.com".into()),
            ]
        );
    }

    #[test]
    fn test_rejects_ip_literal_domain() {
        let got = parse_address_header("root@[192.168.1.1]");
        assert!(got.is_empty());
    }

    #[test]
    fn test_rejects_domain_without_dot() {
        let got = parse_address_header("alice@localhost");
        assert!(got.is_empty());
    }

    #[test]
    fn test_unworthy_addresses() {
        assert!(is_unworthy_address("noreply@example.com", None));
        assert!(is_unworthy_address("no-reply@example.com", None));
        assert!(is_unworthy_address("notifications@example.com", None));
        assert!(is_unworthy_address("mailer-daemon@example.com", None));
        assert!(is_unworthy_address("alice@example.com", Some("List via Mailer")));
        assert!(!is_unworthy_address("alice@example.com", Some("Alice Smith")));
        assert!(!is_unworthy_address("alice.smith@example.com", None));
    }
}

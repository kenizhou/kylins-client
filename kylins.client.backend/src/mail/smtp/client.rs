// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

use lettre::{
    transport::smtp::{
        authentication::{Credentials, Mechanism},
        client::{Tls, TlsParametersBuilder},
    },
    AsyncSmtpTransport, AsyncTransport, Tokio1Executor,
};

use super::types::{SmtpConfig, SmtpSendResult};

fn build_transport(config: &SmtpConfig) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let credentials = Credentials::new(config.username.clone(), config.password.clone());

    let auth_mechanisms = if config.auth_method == "oauth2" {
        vec![Mechanism::Xoauth2]
    } else {
        vec![Mechanism::Plain, Mechanism::Login]
    };

    let transport = match config.security.as_str() {
        "tls" => {
            let mut builder = AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)
                .map_err(|e| format!("SMTP relay error: {}", e))?
                .port(config.port)
                .credentials(credentials)
                .authentication(auth_mechanisms);

            if config.accept_invalid_certs {
                let tls_params = TlsParametersBuilder::new(config.host.clone())
                    .dangerous_accept_invalid_certs(true)
                    .dangerous_accept_invalid_hostnames(true)
                    .build()
                    .map_err(|e| format!("SMTP TLS params error: {}", e))?;
                builder = builder.tls(Tls::Required(tls_params));
            }

            builder.build()
        }
        "starttls" => {
            let mut builder = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)
                .map_err(|e| format!("SMTP STARTTLS error: {}", e))?
                .port(config.port)
                .credentials(credentials)
                .authentication(auth_mechanisms);

            if config.accept_invalid_certs {
                let tls_params = TlsParametersBuilder::new(config.host.clone())
                    .dangerous_accept_invalid_certs(true)
                    .dangerous_accept_invalid_hostnames(true)
                    .build()
                    .map_err(|e| format!("SMTP TLS params error: {}", e))?;
                builder = builder.tls(Tls::Required(tls_params));
            }

            builder.build()
        }
        _ => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&config.host)
            .port(config.port)
            .credentials(credentials)
            .authentication(auth_mechanisms)
            .build(),
    };

    Ok(transport)
}

fn extract_envelope(raw: &[u8]) -> Result<lettre::address::Envelope, String> {
    let message = mail_parser::MessageParser::default()
        .parse(raw)
        .ok_or("Failed to parse email for envelope extraction")?;

    let from = message
        .from()
        .and_then(|list| list.first())
        .and_then(|addr| addr.address())
        .ok_or("No From address found in email")?;

    let from_addr: lettre::Address = from
        .parse()
        .map_err(|e| format!("Invalid From address '{}': {}", from, e))?;

    let mut recipients: Vec<lettre::Address> = Vec::new();

    if let Some(to_list) = message.to() {
        for addr in to_list.iter() {
            if let Some(email) = addr.address() {
                if let Ok(a) = email.parse::<lettre::Address>() {
                    recipients.push(a);
                }
            }
        }
    }

    if let Some(cc_list) = message.cc() {
        for addr in cc_list.iter() {
            if let Some(email) = addr.address() {
                if let Ok(a) = email.parse::<lettre::Address>() {
                    recipients.push(a);
                }
            }
        }
    }

    if let Some(bcc_list) = message.bcc() {
        for addr in bcc_list.iter() {
            if let Some(email) = addr.address() {
                if let Ok(a) = email.parse::<lettre::Address>() {
                    recipients.push(a);
                }
            }
        }
    }

    if recipients.is_empty() {
        return Err("No recipients found in email".to_string());
    }

    lettre::address::Envelope::new(Some(from_addr), recipients)
        .map_err(|e| format!("Envelope error: {}", e))
}

pub async fn send_raw_email(
    config: &SmtpConfig,
    raw_email: &[u8],
) -> Result<SmtpSendResult, String> {
    let envelope = extract_envelope(raw_email)?;
    let transport = build_transport(config)?;

    transport
        .send_raw(&envelope, raw_email)
        .await
        .map(|_response| SmtpSendResult {
            success: true,
            message: "Email sent successfully".to_string(),
        })
        .map_err(|e| format!("SMTP send error: {}", e))
}

pub async fn test_connection(config: &SmtpConfig) -> Result<SmtpSendResult, String> {
    let transport = build_transport(config)?;

    transport
        .test_connection()
        .await
        .map(|success| SmtpSendResult {
            success,
            message: if success {
                "Connection successful".to_string()
            } else {
                "Connection failed".to_string()
            },
        })
        .map_err(|e| format!("SMTP test error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_envelope_valid() {
        let raw = b"From: alice@example.com\r\nTo: bob@example.com\r\nCc: carol@example.com\r\nSubject: Test\r\n\r\nBody";
        let envelope = extract_envelope(raw).unwrap();
        assert!(envelope.from().is_some());
        assert_eq!(envelope.to().len(), 2);
    }

    #[test]
    fn test_extract_envelope_no_from() {
        let raw = b"To: bob@example.com\r\nSubject: Test\r\n\r\nBody";
        let result = extract_envelope(raw);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No From address"));
    }

    #[test]
    fn test_extract_envelope_no_recipients() {
        let raw = b"From: alice@example.com\r\nSubject: Test\r\n\r\nBody";
        let result = extract_envelope(raw);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No recipients found"));
    }

    #[test]
    fn test_extract_envelope_with_bcc() {
        let raw = b"From: alice@example.com\r\nTo: bob@example.com\r\nBcc: secret@example.com\r\nSubject: Test\r\n\r\nBody";
        let envelope = extract_envelope(raw).unwrap();
        assert_eq!(envelope.to().len(), 2);
    }
}

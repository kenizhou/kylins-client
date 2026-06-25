use crate::sync::contacts::types::{ContactAddress, ContactEmail, ContactPhone, ParsedContact};

fn unfold_lines(input: &str) -> String {
    let mut unfolded = String::new();
    for line in input.lines() {
        if let Some(stripped) = line.strip_prefix(' ') {
            unfolded.push_str(stripped);
        } else if let Some(stripped) = line.strip_prefix('\t') {
            unfolded.push_str(stripped);
        } else {
            if !unfolded.is_empty() {
                unfolded.push('\n');
            }
            unfolded.push_str(line);
        }
    }
    unfolded
}

fn unescape_vcard(value: &str) -> String {
    value
        .replace("\\\\", "\\")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\n", "\n")
        .replace("\\N", "\n")
}

fn escape_vcard(value: &str) -> String {
    value
        .replace("\\", "\\\\")
        .replace(",", "\\,")
        .replace(";", "\\;")
        .replace("\n", "\\n")
        .replace("\r", "")
}

#[derive(Debug, Clone)]
struct Property {
    name: String,
    label: Option<String>,
    value: String,
}

fn parse_property(line: &str) -> Option<Property> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (head, value) = line.split_once(':')?;
    let parts: Vec<&str> = head.split(';').collect();
    let name = parts[0].to_uppercase();
    let mut label: Option<String> = None;
    for part in parts.iter().skip(1) {
        if let Some((key, val)) = part.split_once('=') {
            let key = key.to_uppercase();
            if key == "TYPE" {
                label = Some(val.to_lowercase());
            }
        }
    }
    Some(Property {
        name,
        label,
        value: unescape_vcard(value).trim().to_string(),
    })
}

fn split_structured(value: &str) -> Vec<String> {
    // Split on unescaped semicolons.
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            current.push(c);
            if let Some(next) = chars.next() {
                current.push(next);
            }
        } else if c == ';' {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
    }
    parts.push(current);
    parts
}

fn address_from_parts(parts: &[Option<String>]) -> ContactAddress {
    let get = |i: usize| parts.get(i).and_then(|o| o.clone()).filter(|s| !s.is_empty());
    let street_parts: Vec<String> =
        [get(2), get(1)].into_iter().flatten().collect();
    ContactAddress {
        label: None,
        street: if street_parts.is_empty() {
            None
        } else {
            Some(street_parts.join("\n"))
        },
        city: get(3),
        region: get(4),
        postal_code: get(5),
        country: get(6),
        formatted: None,
    }
}

fn parse_vcard_block(block: &str) -> ParsedContact {
    let raw = block.to_string();
    let mut contact = ParsedContact {
        raw_vcard: Some(raw),
        ..Default::default()
    };

    for line in unfold_lines(block).lines() {
        let Some(prop) = parse_property(line) else {
            continue;
        };

        match prop.name.as_str() {
            "UID" => contact.id = Some(prop.value),
            "FN" => contact.display_name = Some(prop.value),
            "N" => {
                let parts = split_structured(&prop.value);
                if contact.display_name.is_none() {
                    let family = parts.get(0).cloned().unwrap_or_default();
                    let given = parts.get(1).cloned().unwrap_or_default();
                    let name = format!("{} {}", given, family).trim().to_string();
                    if !name.is_empty() {
                        contact.display_name = Some(name);
                    }
                }
            }
            "EMAIL" => {
                let email = prop.value.trim().to_lowercase();
                if contact.email.is_none() {
                    contact.email = Some(email.clone());
                }
                contact.emails.push(ContactEmail {
                    label: prop.label,
                    value: email,
                    is_primary: contact.emails.is_empty(),
                });
            }
            "TEL" => contact.phones.push(ContactPhone {
                label: prop.label,
                value: prop.value,
            }),
            "ADR" => {
                let parts: Vec<Option<String>> =
                    split_structured(&prop.value).into_iter().map(Some).collect();
                let mut addr = address_from_parts(&parts);
                addr.label = prop.label;
                contact.addresses.push(addr);
            }
            "ORG" => {
                let parts = split_structured(&prop.value);
                contact.company = parts.into_iter().next().filter(|s| !s.is_empty());
            }
            "TITLE" => contact.job_title = Some(prop.value),
            "NOTE" => contact.notes = Some(prop.value),
            "PHOTO" => {
                // Only capture URI-based photos.
                if prop.value.starts_with("http") {
                    contact.avatar_url = Some(prop.value);
                }
            }
            _ => {}
        }
    }

    if contact.email.is_none() {
        if let Some(primary) = contact.emails.iter().find(|e| e.is_primary) {
            contact.email = Some(primary.value.clone());
        } else if let Some(first) = contact.emails.first() {
            contact.email = Some(first.value.clone());
        }
    }

    contact
}

pub fn parse_vcard(input: &str) -> Vec<ParsedContact> {
    let mut contacts = Vec::new();
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut current = String::new();
    let mut in_vcard = false;

    for line in normalized.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("BEGIN:VCARD") {
            in_vcard = true;
            current.clear();
        } else if trimmed.eq_ignore_ascii_case("END:VCARD") {
            in_vcard = false;
            if !current.is_empty() {
                contacts.push(parse_vcard_block(&current));
            }
        } else if in_vcard {
            if !current.is_empty() {
                current.push('\n');
            }
            current.push_str(line);
        }
    }

    contacts
}

fn name_parts(display_name: &str) -> (String, String) {
    let trimmed = display_name.trim();
    if trimmed.is_empty() {
        return (String::new(), String::new());
    }
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() == 1 {
        return (String::new(), parts[0].to_string());
    }
    let last = parts[parts.len() - 1].to_string();
    let first = parts[..parts.len() - 1].join(" ");
    (last, first)
}

pub fn export_vcard(contacts: &[ParsedContact]) -> String {
    let mut output = String::new();
    for contact in contacts {
        output.push_str("BEGIN:VCARD\r\n");
        output.push_str("VERSION:3.0\r\n");

        let id = contact.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        output.push_str(&format!("UID:{}\r\n", escape_vcard(&id)));

        let display = contact.display_name.clone().unwrap_or_default();
        if !display.is_empty() {
            output.push_str(&format!("FN:{}\r\n", escape_vcard(&display)));
            let (family, given) = name_parts(&display);
            output.push_str(&format!(
                "N:{};{};;;\r\n",
                escape_vcard(&family),
                escape_vcard(&given)
            ));
        }

        if let Some(company) = &contact.company {
            if !company.is_empty() {
                output.push_str(&format!("ORG:{}\r\n", escape_vcard(company)));
            }
        }
        if let Some(title) = &contact.job_title {
            if !title.is_empty() {
                output.push_str(&format!("TITLE:{}\r\n", escape_vcard(title)));
            }
        }

        for email in &contact.emails {
            let label_part = email
                .label
                .as_ref()
                .filter(|l| !l.is_empty())
                .map(|l| format!(";TYPE={}", l.to_uppercase()))
                .unwrap_or_default();
            output.push_str(&format!(
                "EMAIL{}:{}\r\n",
                label_part,
                escape_vcard(&email.value)
            ));
        }

        for phone in &contact.phones {
            let label_part = phone
                .label
                .as_ref()
                .filter(|l| !l.is_empty())
                .map(|l| format!(";TYPE={}", l.to_uppercase()))
                .unwrap_or_default();
            output.push_str(&format!(
                "TEL{}:{}\r\n",
                label_part,
                escape_vcard(&phone.value)
            ));
        }

        for addr in &contact.addresses {
            let label_part = addr
                .label
                .as_ref()
                .filter(|l| !l.is_empty())
                .map(|l| format!(";TYPE={}", l.to_uppercase()))
                .unwrap_or_default();
            let street = addr.street.as_deref().unwrap_or("").replace('\n', ";");
            output.push_str(&format!(
                "ADR{}:;;{};{};{};{};{}\r\n",
                label_part,
                escape_vcard(&street),
                escape_vcard(addr.city.as_deref().unwrap_or("")),
                escape_vcard(addr.region.as_deref().unwrap_or("")),
                escape_vcard(addr.postal_code.as_deref().unwrap_or("")),
                escape_vcard(addr.country.as_deref().unwrap_or(""))
            ));
        }

        if let Some(notes) = &contact.notes {
            if !notes.is_empty() {
                output.push_str(&format!("NOTE:{}\r\n", escape_vcard(notes)));
            }
        }

        if let Some(avatar) = &contact.avatar_url {
            if !avatar.is_empty() {
                output.push_str(&format!("PHOTO;VALUE=URI:{}\r\n", escape_vcard(avatar)));
            }
        }

        output.push_str("END:VCARD\r\n");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_vcard() {
        let input = r#"BEGIN:VCARD
VERSION:3.0
FN:Ada Lovelace
N:Lovelace;Ada;;;
EMAIL;TYPE=WORK:ada@example.com
TEL;TYPE=CELL:+1-555-0100
ORG:Analytical Engines
TITLE:Countess
NOTE:First programmer
END:VCARD"#;

        let contacts = parse_vcard(input);
        assert_eq!(contacts.len(), 1);
        let c = &contacts[0];
        assert_eq!(c.display_name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(c.email.as_deref(), Some("ada@example.com"));
        assert_eq!(c.company.as_deref(), Some("Analytical Engines"));
        assert_eq!(c.job_title.as_deref(), Some("Countess"));
        assert_eq!(c.notes.as_deref(), Some("First programmer"));
        assert_eq!(c.emails.len(), 1);
        assert_eq!(c.phones.len(), 1);
        assert_eq!(c.phones[0].value, "+1-555-0100");
    }

    #[test]
    fn test_export_roundtrip() {
        let contact = ParsedContact {
            id: Some("id-1".into()),
            display_name: Some("Grace Hopper".into()),
            email: Some("grace@example.com".into()),
            company: Some("US Navy".into()),
            job_title: Some("Rear Admiral".into()),
            emails: vec![ContactEmail {
                label: Some("work".into()),
                value: "grace@example.com".into(),
                is_primary: true,
            }],
            phones: vec![ContactPhone {
                label: Some("cell".into()),
                value: "+1-555-0199".into(),
            }],
            notes: Some("Bug hunter".into()),
            ..Default::default()
        };

        let vcf = export_vcard(&[contact]);
        assert!(vcf.contains("BEGIN:VCARD"));
        assert!(vcf.contains("FN:Grace Hopper"));
        assert!(vcf.contains("EMAIL;TYPE=WORK:grace@example.com"));
        assert!(vcf.contains("NOTE:Bug hunter"));

        let parsed = parse_vcard(&vcf);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].display_name.as_deref(), Some("Grace Hopper"));
    }
}

//! Provision command (MS-ASPROV). Two-phase handshake:
//!   Phase 1: client requests the policy → server returns a TEMP PolicyKey
//!           and the policy XML in <Data>.
//!   Phase 2: client acknowledges with the temp PolicyKey and <Status>1</Status>
//!           → server returns a PERMANENT PolicyKey that the client must send
//!           in the X-MS-PolicyKey header on every subsequent command.
//!
//! RemoteWipe: if the server returns <RemoteWipe>, we surface it as a
//! permanent error — never auto-execute. The UI is a follow-up.

use crate::eas::wbxml::tags::{pages, provision};
use crate::eas::wbxml::types::{WbxmlElement, WbxmlValue};
use crate::eas::wbxml::WbxmlError;

const MS_EAS_PROVISIONING_WBXML: &str = "MS-EAS-Provisioning-WBXML";

/// Build the Phase-1 Provision request (no policy key yet).
pub fn build_provision_phase1_request() -> WbxmlElement {
    WbxmlElement::container(
        pages::PROVISION,
        provision::PROVISION,
        vec![WbxmlElement::container(
            pages::PROVISION,
            provision::POLICIES,
            vec![WbxmlElement::container(
                pages::PROVISION,
                provision::POLICY,
                vec![WbxmlElement::text(
                    pages::PROVISION,
                    provision::POLICY_TYPE,
                    MS_EAS_PROVISIONING_WBXML,
                )],
            )],
        )],
    )
}

/// Build the Phase-2 ack: client has received the temp policy and accepts it
/// (Status 1 = client compliant). Server replies with the permanent key.
pub fn build_provision_phase2_request(temp_policy_key: &str) -> WbxmlElement {
    WbxmlElement::container(
        pages::PROVISION,
        provision::PROVISION,
        vec![WbxmlElement::container(
            pages::PROVISION,
            provision::POLICIES,
            vec![WbxmlElement::container(
                pages::PROVISION,
                provision::POLICY,
                vec![
                    WbxmlElement::text(
                        pages::PROVISION,
                        provision::POLICY_TYPE,
                        MS_EAS_PROVISIONING_WBXML,
                    ),
                    WbxmlElement::text(
                        pages::PROVISION,
                        provision::POLICY_KEY,
                        temp_policy_key,
                    ),
                    WbxmlElement::text(pages::PROVISION, provision::STATUS, "1"),
                ],
            )],
        )],
    )
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProvisionResult {
    /// Top-level Provision Status. 1 = success.
    pub status: u32,
    /// Permanent (Phase 2) or temp (Phase 1) policy key returned by the server.
    pub policy_key: Option<String>,
    /// True if the server sent a `<RemoteWipe>` element. Caller MUST surface,
    /// never auto-wipe.
    pub remote_wipe: bool,
}

/// Parse a Provision response. Extracts the top-level Status, the nested
/// Policy's PolicyKey, and detects a RemoteWipe element.
pub fn parse_provision_response(root: &WbxmlElement) -> Result<ProvisionResult, WbxmlError> {
    let mut out = ProvisionResult {
        status: 1,
        ..Default::default()
    };
    for child in &root.children {
        // Match on (page, token) — provision page is unambiguous in the root.
        match (child.page, child.token) {
            (pages::PROVISION, provision::STATUS) => {
                out.status = text(child).parse().unwrap_or(1);
            }
            (pages::PROVISION, provision::POLICIES) => {
                if let Some(key) = find_policy_key(child) {
                    out.policy_key = Some(key);
                }
            }
            (pages::PROVISION, provision::REMOTE_WIPE) => {
                out.remote_wipe = true;
            }
            _ => {}
        }
    }
    Ok(out)
}

fn find_policy_key(policies_el: &WbxmlElement) -> Option<String> {
    for policy in &policies_el.children {
        if policy.token != provision::POLICY {
            continue;
        }
        for field in &policy.children {
            if field.token == provision::POLICY_KEY {
                return Some(text(field));
            }
        }
    }
    None
}

fn text(el: &WbxmlElement) -> String {
    match &el.value {
        WbxmlValue::Text(s) => s.clone(),
        WbxmlValue::Opaque(b) => String::from_utf8_lossy(b).into_owned(),
        WbxmlValue::Empty => String::new(),
    }
}

#[cfg(test)]
mod tests {
    //! Task 2 (EAS hardening plan) — see
    //! docs/superpowers/plans/2026-06-30-sync-engine-phase3-eas-hardening.md
    use super::*;
    use crate::eas::wbxml::tags::{pages, provision};
    use crate::eas::wbxml::types::{WbxmlElement, WbxmlValue};

    /// Pull a text leaf's string. `WbxmlElement` has no `text_str()` helper on
    /// the codec (intentionally — Task 2 must not modify the codec), so we
    /// inline the extraction here.
    fn text_str(el: &WbxmlElement) -> String {
        match &el.value {
            WbxmlValue::Text(s) => s.clone(),
            _ => panic!(
                "expected Text value on (page={}, token={}), got {:?}",
                el.page, el.token, el.value
            ),
        }
    }

    #[test]
    fn phase1_request_has_policy_type_ms_eas_provisioning_wbxml() {
        let tree = build_provision_phase1_request();
        // Root: Provision (page 14, 0x05)
        assert_eq!(tree.page, pages::PROVISION);
        assert_eq!(tree.token, provision::PROVISION);
        // Walk: Provision > Policies > Policy > PolicyType == "MS-EAS-Provisioning-WBXML"
        let policies = tree
            .children
            .iter()
            .find(|c| c.token == provision::POLICIES)
            .expect("Policies");
        let policy = policies
            .children
            .iter()
            .find(|c| c.token == provision::POLICY)
            .expect("Policy");
        let ptype = policy
            .children
            .iter()
            .find(|c| c.token == provision::POLICY_TYPE)
            .expect("PolicyType");
        assert_eq!(text_str(ptype), "MS-EAS-Provisioning-WBXML");
    }

    #[test]
    fn parse_phase1_response_extracts_temp_policy_key() {
        // Build a tree mimicking:
        // <Provision><Status>1</Status><Policies><Policy><PolicyType>...</PolicyType>
        //   <Status>1</Status><PolicyKey>{TEMP-123}</PolicyKey><Data>...</Data></Policy></Policies></Provision>
        let tree = WbxmlElement::container(
            pages::PROVISION,
            provision::PROVISION,
            vec![
                WbxmlElement::text(pages::PROVISION, provision::STATUS, "1"),
                WbxmlElement::container(
                    pages::PROVISION,
                    provision::POLICIES,
                    vec![WbxmlElement::container(
                        pages::PROVISION,
                        provision::POLICY,
                        vec![
                            WbxmlElement::text(
                                pages::PROVISION,
                                provision::POLICY_TYPE,
                                "MS-EAS-Provisioning-WBXML",
                            ),
                            WbxmlElement::text(pages::PROVISION, provision::STATUS, "1"),
                            WbxmlElement::text(
                                pages::PROVISION,
                                provision::POLICY_KEY,
                                "{TEMP-123}",
                            ),
                        ],
                    )],
                ),
            ],
        );
        let r = parse_provision_response(&tree).unwrap();
        assert_eq!(r.status, 1);
        assert_eq!(r.policy_key.as_deref(), Some("{TEMP-123}"));
        assert!(!r.remote_wipe);
    }

    #[test]
    fn parse_response_flags_remote_wipe() {
        // <Provision><Status>1</Status><RemoteWipe>...</RemoteWipe></Provision>
        let tree = WbxmlElement::container(
            pages::PROVISION,
            provision::PROVISION,
            vec![
                WbxmlElement::text(pages::PROVISION, provision::STATUS, "1"),
                WbxmlElement::empty(pages::PROVISION, provision::REMOTE_WIPE),
            ],
        );
        let r = parse_provision_response(&tree).unwrap();
        assert!(r.remote_wipe, "must flag RemoteWipe so caller surfaces it");
    }

    /// Task 7 Step 1 — WBXML codec round-trip integration test.
    /// The T2 tests above build the Phase-1 tree and parse a hand-built
    /// response tree, but never push the tree through the WBXML codec. This
    /// proves `build_provision_phase1_request()` → bytes → tree survives a
    /// full serialize/deserialize cycle with the PolicyType leaf intact, so
    /// the orchestrator can rely on the codec for the live transport path.
    #[test]
    fn phase1_request_round_trips_through_wbxml_codec() {
        use crate::eas::wbxml::{deserialize_to_tree, serialize_tree};

        let tree = build_provision_phase1_request();
        let bytes = serialize_tree(&tree).expect("serialize Phase-1 Provision request");
        assert!(
            !bytes.is_empty(),
            "serializer must emit a non-empty WBXML document"
        );
        let back = deserialize_to_tree(&bytes).expect("deserialize round-tripped bytes");

        // Root must still be Provision (page 14, token 0x05).
        assert_eq!(back.page, pages::PROVISION);
        assert_eq!(back.token, provision::PROVISION);

        // Walk Provision > Policies > Policy > PolicyType and confirm the
        // leaf text survived the codec round-trip. This is the exact contract
        // the live request relies on (server rejects empty/wrong PolicyType).
        let policies = back
            .children
            .iter()
            .find(|c| c.token == provision::POLICIES)
            .expect("Policies container survived round-trip");
        let policy = policies
            .children
            .iter()
            .find(|c| c.token == provision::POLICY)
            .expect("Policy container survived round-trip");
        let ptype = policy
            .children
            .iter()
            .find(|c| c.token == provision::POLICY_TYPE)
            .expect("PolicyType leaf survived round-trip");
        assert_eq!(
            text_str(ptype),
            "MS-EAS-Provisioning-WBXML",
            "PolicyType leaf text must survive the WBXML codec round-trip"
        );
    }
}

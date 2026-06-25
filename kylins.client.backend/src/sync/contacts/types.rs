use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedContact {
    pub id: Option<String>,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub company: Option<String>,
    pub job_title: Option<String>,
    pub emails: Vec<ContactEmail>,
    pub phones: Vec<ContactPhone>,
    pub addresses: Vec<ContactAddress>,
    pub notes: Option<String>,
    pub avatar_url: Option<String>,
    pub raw_vcard: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactEmail {
    pub label: Option<String>,
    pub value: String,
    #[serde(default)]
    pub is_primary: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactPhone {
    pub label: Option<String>,
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactAddress {
    pub label: Option<String>,
    pub formatted: Option<String>,
    pub street: Option<String>,
    pub city: Option<String>,
    pub region: Option<String>,
    pub postal_code: Option<String>,
    pub country: Option<String>,
}

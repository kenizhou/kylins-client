use tauri::command;

use crate::sync::contacts::types::ParsedContact;
use crate::sync::contacts::vcard;

#[command]
pub fn parse_vcard(data: String) -> Result<Vec<ParsedContact>, String> {
    Ok(vcard::parse_vcard(&data))
}

#[command]
pub fn export_vcard(contacts: Vec<ParsedContact>) -> Result<String, String> {
    Ok(vcard::export_vcard(&contacts))
}

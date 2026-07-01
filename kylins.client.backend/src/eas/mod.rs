// ActiveSync (EAS) module. Ported from mailkit_arkts — see ATTRIBUTIONS.md.
//
// MVP scope: FolderSync, Sync (mail/calendar/contacts), SendMail, SmartForward,
// SmartReply, ItemOperations, GetItemEstimate, Ping, FolderCreate/Delete/Update.

pub mod auth;
pub mod autodiscover;
pub mod client;
pub mod commands;
pub mod provision;
pub mod service;
pub mod status;
pub mod types;
pub mod wbxml;

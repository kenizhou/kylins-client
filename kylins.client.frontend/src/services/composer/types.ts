// Mirror of the Rust `SendDraft` / `AttachmentRef` / `AddressSpec` types in
// `kylins.client.backend/src/mail/builder.rs`. All field names are camelCase
// so the JSON payload crossing IPC deserializes directly into the backend
// structs (which use `#[serde(rename_all = "camelCase")]`).
//
// **Keep this file in sync with the Rust definitions.** Any field added/
// renamed here must be reflected in `builder.rs` (and vice versa), or the
// `MutationOp::Send { draft }` round-trip will break.

/**
 * RFC5322 address — single recipient/sender. `name` is the display name and is
 * omitted (undefined → Rust `None` via `skip_serializing_if`) when empty.
 */
export interface AddressSpec {
  name?: string;
  email: string;
}

/**
 * Reference to a file-backed attachment (regular or inline).
 *
 * `filePath` is absolute, under `<appData>/outbox-attachments/{draftId}/`.
 * The backend reads the bytes at send time via `tokio::fs::read`, so no
 * base64 ever crosses IPC.
 *
 * `cid` is set only for `inlineImages` entries and must match a `cid:` ref in
 * `htmlBody`. Regular attachments leave it undefined.
 */
export interface AttachmentRef {
  filePath: string;
  filename: string;
  mimeType: string;
  cid?: string;
}

/**
 * Structured draft crossing IPC as JSON. The frontend `buildSendDraft`
 * produces this; the backend builds RFC5322 bytes via `build_mime`.
 *
 * Optional fields (`undefined`) map to Rust `Option::None` / empty `Vec`
 * (both `skip_serializing_if`), so they are omitted from the JSON payload
 * unless explicitly set.
 *
 * `extraHeaders` mirrors Rust `Vec<(String, String)>` — a JSON array of
 * 2-tuples (`[[name, value], ...]`), NOT a Record. This is the shape serde
 * emits for tuple-vec and what the backend's mail-builder header loop expects.
 */
export interface SendDraft {
  draftId: string;
  from: AddressSpec;
  to: AddressSpec[];
  cc?: AddressSpec[];
  bcc?: AddressSpec[];
  replyTo?: AddressSpec[];
  subject: string;
  htmlBody?: string;
  textBody?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: AttachmentRef[];
  inlineImages?: AttachmentRef[];
  extraHeaders?: Array<[string, string]>;
  /** Per-message crypto intent. Plan 4a honors 'smime'; 'none' = plain MIME. */
  cryptoMethod: 'none' | 'smime';
  sign: boolean;
  encrypt: boolean;
}

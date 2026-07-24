// Attachment staging helpers for the send flow.
//
// Files bound for an outgoing message are copied/written under
// `<appData>/outbox-attachments/{draftId}/` so the backend can stream them
// into the MIME builder without base64 ever crossing IPC. The directory is
// created lazily; cleanup is best-effort (the engine also cleans up on
// successful send — see the backend `send_op`).
//
// Backend capability `fs:allow-appdata-read/write-recursive` (already in
// `kylins.client.backend/capabilities/default.json`) covers this path.

import { appDataDir, join } from '@tauri-apps/api/path';
import { copyFile, exists, mkdir, remove, writeFile } from '@tauri-apps/plugin-fs';

/**
 * Generate a new opaque draft id. Used when the caller has no persisted
 * draft row yet (e.g. a quick-reply that bypasses the drafts table).
 *
 * Uses `crypto.randomUUID` when available (modern browsers + the Tauri
 * webview), with a timestamp fallback for the test/jsdom path where
 * `randomUUID` may be missing on older Node builds.
 */
export function newDraftId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Generate a new opaque attachment-chip id (UI identity only — never sent to
 * the backend). Shared by the OS compose window, inline dock, and
 * draftFactory seeding so the randomUUID-with-fallback pattern lives in one
 * place.
 */
export function newAttachmentId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Absolute path of the per-draft outbox directory under `<appData>`.
 * Callers should `mkdir({ recursive: true })` before writing.
 */
export async function outboxDir(draftId: string): Promise<string> {
  return join(await appDataDir(), 'outbox-attachments', draftId);
}

/**
 * Copy a picked source file into the draft's outbox and return the absolute
 * destination path. `srcPath` must already be filesystem-visible to the
 * Tauri fs plugin (i.e. a path returned by the dialog picker or another
 * in-scope location).
 *
 * The directory is created if missing. If `filename` collides with an
 * existing file in the outbox it is overwritten (re-pick of the same name
 * should be idempotent).
 */
export async function stageAttachment(
  draftId: string,
  srcPath: string,
  filename: string,
): Promise<string> {
  const dir = await outboxDir(draftId);
  await mkdir(dir, { recursive: true });
  const dest = await join(dir, sanitizeFilename(filename));
  await copyFile(srcPath, dest);
  return dest;
}

/**
 * Write raw bytes into the draft's outbox under `filename` and return the
 * absolute path. Used for in-memory attachment sources (e.g. a forwarded
 * message synthesized as .eml bytes, or base64-decoded drop data) where
 * there is no source path to `copyFile` from.
 */
export async function stageAttachmentBytes(
  draftId: string,
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<{ filePath: string; filename: string; mimeType: string }> {
  const dir = await outboxDir(draftId);
  await mkdir(dir, { recursive: true });
  const safeName = sanitizeFilename(filename);
  const dest = await join(dir, safeName);
  await writeFile(dest, bytes);
  return { filePath: dest, filename: safeName, mimeType };
}

/**
 * Stage an inline image (a base64 `data:` URL extracted from the HTML body)
 * into the draft's outbox. Returns the `AttachmentRef` fields plus the `cid`
 * the caller already chose; the HTML body's `cid:` ref points back here.
 *
 * `base64` is the raw base64 payload (no `data:<mime>;base64,` prefix).
 */
export async function stageInlineImage(
  draftId: string,
  cid: string,
  mimeType: string,
  base64: string,
): Promise<{ filePath: string; filename: string; mimeType: string; cid: string }> {
  const ext = mimeTypeToExtension(mimeType);
  // The cid is opaque but tends to look like an email (`inline_...@kylins.mail`);
  // collapse it to a filesystem-safe stem so the staged file is debuggable.
  const stem = cid.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 48);
  const filename = `${stem}.${ext}`;
  const bytes = base64Decode(base64);
  const staged = await stageAttachmentBytes(draftId, filename, mimeType, bytes);
  return { ...staged, cid };
}

/**
 * Best-effort cleanup of the per-draft outbox directory. Called by the
 * backend on successful send; exposed here for the frontend to call on
 * draft discard / send-fail-abandon paths.
 */
export async function cleanupAttachments(draftId: string): Promise<void> {
  const dir = await outboxDir(draftId);
  if (await exists(dir)) {
    await remove(dir, { recursive: true });
  }
}

/**
 * Map a MIME type to a file extension. Falls back to `bin` so the staged
 * filename is always well-formed.
 */
function mimeTypeToExtension(mimeType: string): string {
  const sub = mimeType.split('/')[1];
  if (!sub) return 'bin';
  // Strip any parameters (e.g. `image/png; charset=...` → `png`).
  return sub.split(';')[0]?.trim() || 'bin';
}

/**
 * Strip path separators and shell-dangerous characters from a user-supplied
 * filename so it is safe to write under the outbox. Preserves dots and dashes.
 * Rejects reserved names `.` and `..` which would otherwise traverse the
 * directory tree.
 */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  if (cleaned === '.' || cleaned === '..') return 'attachment';
  return cleaned.length > 0 ? cleaned : 'attachment';
}

/**
 * Decode a base64 string into bytes. Uses `atob` when available (browser +
 * jsdom); otherwise falls back to Node's Buffer (test/Node-only contexts).
 */
function base64Decode(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const B = (globalThis as any).Buffer;
  if (B) {
    // Node path returns a Node Buffer; coerce to Uint8Array for the fs plugin.
    return new Uint8Array(B.from(base64, 'base64'));
  }
  throw new Error('No base64 decoder available (atob nor Buffer found)');
}

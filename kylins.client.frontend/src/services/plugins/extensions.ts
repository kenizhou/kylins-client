// Plugin extension contracts, modeled on Mailspring's MessageViewExtension
// (app/src/extensions/message-view-extension.ts) and ComposerExtension
// (app/src/extensions/composer-extension.ts), adapted to Kylins' plugin
// manager. These let features (tracker stripping, ICS hiding, send-time
// transforms, RSVP) plug into the viewer/composer WITHOUT forking the core
// components.
//
// See docs/superpowers/plans/2026-06-23-frontend-components-composer-viewer-calendar.md §7.1.

// Minimal message/draft/file shapes for extension hooks. Deliberately small
// and structural; widened/aligned with the full ported models in Phase 1
// (composer) and Phase 2 (viewer) without breaking these contracts.

export interface ExtensionMessage {
  id: string;
  accountId: string;
  /** Sanitized HTML body. `formatMessageBody` may mutate this in place. */
  body: string;
  subject?: string;
  fromAddress?: string;
  fromName?: string;
  /** Raw List-Unsubscribe header value, when present. */
  listUnsubscribe?: string;
}

export interface ExtensionFile {
  id: string;
  filename: string;
  mimeType: string;
  contentId?: string;
  size?: number;
  isInline?: boolean;
}

export interface ExtensionDraft {
  id: string;
  accountId: string;
  bodyHtml: string;
  subject?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  fromEmail?: string;
  threadId?: string;
}

// ---- MessageViewExtension: hooks run by the mail viewer ----

export interface FormatMessageBodyArgs {
  message: ExtensionMessage;
}

export interface RenderedMessageBodyIntoDocumentArgs {
  /** The iframe contentDocument, after the body has been written. */
  document: Document;
  message: ExtensionMessage;
  iframe: HTMLIFrameElement;
}

export interface FilterMessageFilesArgs {
  message: ExtensionMessage;
  files: ExtensionFile[];
}

export interface MessageViewExtension {
  readonly id: string;
  /** Mutate `message.body` (HTML string) before it is written into the iframe. */
  formatMessageBody?(args: FormatMessageBodyArgs): void;
  /** Mutate the live iframe DOM after the body has been written. */
  renderedMessageBodyIntoDocument?(args: RenderedMessageBodyIntoDocumentArgs): void;
  /** Filter/replace the attachment list shown for a message. Return the new list. */
  filterMessageFiles?(args: FilterMessageFilesArgs): ExtensionFile[] | void;
}

// ---- ComposerExtension: hooks run by the composer ----

export interface SendActionDef {
  id: string;
  label: string;
  isPrimary?: boolean;
  perform?: (draft: ExtensionDraft) => void | Promise<void>;
}

export interface ApplyTransformsForSendingArgs {
  draft: ExtensionDraft;
  /** The draft body's root DOM node; mutate this (not `draft.bodyHtml`). */
  draftBodyRootNode: HTMLElement;
}

export interface ComposerExtension {
  readonly id: string;
  /** Send actions to surface in the send-button dropdown. */
  sendActions?(draft: ExtensionDraft): SendActionDef[];
  /** Warnings to show before sending (empty body, unfilled template vars, …). */
  warningsForSending?(draft: ExtensionDraft): string[];
  /** Mutate a freshly-created draft before the editor mounts (signature, …). */
  prepareNewDraft?(draft: ExtensionDraft): void;
  /** Mutate the body DOM at send time (inline tracking, translation, …). */
  applyTransformsForSending?(args: ApplyTransformsForSendingArgs): void;
  /** Whether per-recipient body variants are needed (link/open tracking). */
  needsPerRecipientBodies?(draft: ExtensionDraft): boolean;
}

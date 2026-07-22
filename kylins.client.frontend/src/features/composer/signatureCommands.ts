// ProseMirror-native signature block operations. The signature lives in the
// editor as a dedicated `signature` node (see SignatureNode.ts) so it can be
// found, replaced, or removed atomically — replacing the old string-regex
// approach (`signaturePlacement.applySignatureAboveQuote`), which broke after
// any editor round-trip because ProseMirror discarded the unknown
// `<signature>` tag.
//
// Placement mirrors Mailspring's applySignature: the block sits just above the
// quoted original (before the "On … wrote:" attribution paragraph when there
// is one, else before the first top-level blockquote), or at the end of the
// body for a new compose.

import type { Editor } from '@tiptap/core';
import { DOMParser, type Node as PMNode } from '@tiptap/pm/model';
import { sanitizeHtml } from '@/utils/sanitize';

export interface SignatureRef {
  id: string;
  html: string;
}

/** Locate the `signature` node in the doc, if present. */
export function findSignatureNode(doc: PMNode): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null;
  doc.descendants((node, pos) => {
    if (node.type.name === 'signature') {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found;
}

/** The id of the signature currently in the doc, or null. This — not any
 *  store field — is the source of truth for "which signature is active". */
export function getActiveSignatureId(doc: PMNode): string | null {
  const found = findSignatureNode(doc);
  if (!found) return null;
  return (found.node.attrs.signatureId as string | null) ?? null;
}

/**
 * Find the insertion position for the signature: just above the quoted
 * original. The quote region starts at the reply attribution paragraph
 * ("On <date>, <sender> wrote:") when present, otherwise at the first
 * top-level blockquote (reply + forward quotes are both blockquotes — see
 * prepareBodyForQuoting). Returns null when the body has no quote (append at
 * the end instead).
 *
 * Note: the `gmail_quote` class does not survive TipTap parsing (StarterKit's
 * Blockquote carries no attributes), so detection is by node type and the
 * attribution text, not by HTML class.
 */
export function findQuoteInsertPos(doc: PMNode): number | null {
  let attributionPos: number | null = null;
  let blockquotePos: number | null = null;
  doc.forEach((child, offset) => {
    if (
      attributionPos === null &&
      child.type.name === 'paragraph' &&
      /\bwrote:\s*$/.test(child.textContent)
    ) {
      attributionPos = offset;
    }
    if (blockquotePos === null && child.type.name === 'blockquote') {
      blockquotePos = offset;
    }
  });
  return attributionPos ?? blockquotePos;
}

/** Parse signature body HTML into a `signature` node under the editor schema. */
function createSignatureNode(editor: Editor, signature: SignatureRef): PMNode | null {
  const wrapper = document.createElement('div');
  // The body is user-authored (Preferences signature editor) but sanitize
  // anyway — the node view re-injects it via dangerouslySetInnerHTML.
  wrapper.innerHTML = `<signature id="${signature.id}">${sanitizeHtml(signature.html)}</signature>`;
  const parsed = DOMParser.fromSchema(editor.schema).parse(wrapper);
  const node = parsed.firstChild;
  if (!node || node.type.name !== 'signature') return null;
  return node;
}

/**
 * Insert, replace, or remove the signature block as a single ProseMirror
 * transaction (so undo/redo treat a swap as one step). Pass `null` to remove.
 *
 * `addToHistory: false` is used for the automatic default-signature
 * application when a composer opens — the user shouldn't be able to "undo"
 * the signature they never asked to insert.
 */
export function setSignatureInEditor(
  editor: Editor,
  signature: SignatureRef | null,
  opts?: { addToHistory?: boolean },
): boolean {
  const { state, view } = editor;
  const existing = findSignatureNode(state.doc);
  if (!signature && !existing) return false;

  const tr = state.tr;
  if (existing) {
    tr.delete(existing.pos, existing.pos + existing.node.nodeSize);
  }
  if (signature) {
    const node = createSignatureNode(editor, signature);
    if (!node) return false;
    const insertPos = findQuoteInsertPos(tr.doc) ?? tr.doc.content.size;
    tr.insert(insertPos, node);
  }
  if (opts?.addToHistory === false) {
    tr.setMeta('addToHistory', false);
  }
  view.dispatch(tr);
  return true;
}

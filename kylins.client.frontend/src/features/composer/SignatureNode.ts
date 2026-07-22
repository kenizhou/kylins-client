// Custom TipTap node for the mail signature. The signature is a dedicated
// block in the composer document — parsed from and serialized back to the
// non-standard `<signature id="…">…</signature>` tag that the send pipeline
// unwraps via `stripSignature` (services/composer/buildSendDraft), so
// recipients never see the tag.
//
// The node has real parsed children (so the body round-trips through
// getHTML/setContent and drafts), but the React node view renders them as
// static HTML without a contentDOM — from the user's perspective it behaves
// as an atom: selectable and deletable as one unit, never editable inline.

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { SignatureNodeView } from './SignatureNodeView';

export const SignatureNode = Node.create({
  name: 'signature',

  group: 'block',
  content: 'block*',
  // Isolating keeps the user from backspacing into / merging with the block;
  // defining keeps it intact across edits at its boundary.
  isolating: true,
  defining: true,
  selectable: true,

  addAttributes() {
    return {
      signatureId: {
        default: null,
        parseHTML: (element) => element.getAttribute('id'),
        renderHTML: (attributes) =>
          attributes.signatureId ? { id: attributes.signatureId as string } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'signature' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['signature', mergeAttributes(HTMLAttributes), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SignatureNodeView);
  },
});

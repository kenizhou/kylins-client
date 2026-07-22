// React node view for the `signature` block. Renders the signature body as
// sanitized static HTML (no NodeViewContent), making the block an atom from
// the user's perspective: it can be selected and deleted as one unit, but not
// edited inline — Mailspring's "uneditable" block behavior. A hover remove
// button deletes the whole block.

import { useMemo } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { DOMSerializer } from '@tiptap/pm/model';
import { CloseIcon } from '@/components/icons';
import { sanitizeHtml } from '@/utils/sanitize';

export function SignatureNodeView({ node, editor, selected, deleteNode }: NodeViewProps) {
  // Serialize the node's parsed children back to HTML for display. The PM doc
  // is the source of truth, so this also stays correct for signatures restored
  // from drafts (where the children came from parseHTML, not an attribute).
  const html = useMemo(() => {
    const fragment = DOMSerializer.fromSchema(editor.schema).serializeFragment(node.content);
    const tmp = document.createElement('div');
    tmp.appendChild(fragment);
    return sanitizeHtml(tmp.innerHTML);
  }, [editor.schema, node.content]);

  return (
    <NodeViewWrapper
      className={`kylins-signature-node group relative my-1 rounded-md border px-1 ${
        selected
          ? 'border-[var(--primary)]'
          : 'border-transparent hover:border-[var(--border-subtle)]'
      }`}
      data-signature-id={(node.attrs.signatureId as string | null) ?? undefined}
      contentEditable={false}
    >
      {/* Sanitized above; the body is trusted user-authored signature HTML. */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          deleteNode();
        }}
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded border border-[var(--border)] bg-[var(--background)] text-[var(--muted-text)] opacity-0 transition-opacity hover:text-[var(--foreground)] focus-visible:opacity-100 group-hover:opacity-100"
        aria-label="Remove signature"
        title="Remove signature"
      >
        <CloseIcon size={12} />
      </button>
    </NodeViewWrapper>
  );
}

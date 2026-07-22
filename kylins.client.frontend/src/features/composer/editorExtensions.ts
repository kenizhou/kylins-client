// Shared TipTap extension set for the composer editors (modal Composer + inline
// reply/forward). Keeping one factory prevents the two editors from drifting,
// and — importantly — includes `Image` and `Table` nodes so the quoted
// original's <img>/<table> survive ProseMirror's schema filter when the quote is
// loaded into the editor. Without those nodes the editor silently drops images
// and tables from the quoted body.

import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import FontFamily from '@tiptap/extension-font-family';
import Placeholder from '@tiptap/extension-placeholder';
// TipTap v3 exports Table + TableRow/Cell/Header (and TableKit) all as named
// exports from @tiptap/extension-table; the per-part packages are just shims.
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { SignatureNode } from './SignatureNode';

/**
 * Build the composer editor extensions. `placeholder` is the only per-surface
 * difference (e.g. "Type your reply…" vs "Write your message…"); everything else
 * is shared. The return type is left to inference so Node/Mark extensions match
 * what `useEditor` expects (the same inline array shape the editors used before).
 */
export function buildComposerExtensions(placeholder: string) {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false } }),
    Placeholder.configure({ placeholder }),
    // allowBase64 so pasted/quoted data: images render; inline so images can sit
    // in a text line (matches the modal composer).
    Image.configure({ inline: true, allowBase64: true }),
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    FontFamily,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    // Dedicated signature block (see SignatureNode.ts). Shared so the modal
    // composer, inline reply, and preferences signature editor all parse and
    // serialize the `<signature>` tag the same way.
    SignatureNode,
  ];
}

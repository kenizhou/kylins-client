// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// TipTap formatting toolbar. StarterKit v3 already provides bold/italic/
// underline/strike/link/headings/lists/quote/code/history, so all toggles go
// through the editor chain. The AI-assist toggle is optional (rendered only
// when provided); full AI assist lands in Phase 6.

import { useRef } from 'react';
import type { Editor } from '@tiptap/react';

interface EditorToolbarProps {
  editor: Editor | null;
  /** Open the link dialog (owned by Composer, also triggered by Cmd/Ctrl+K). */
  onRequestLink: () => void;
  onToggleAiAssist?: () => void;
  aiAssistOpen?: boolean;
}

export function EditorToolbar({
  editor,
  onRequestLink,
  onToggleAiAssist,
  aiAssistOpen,
}: EditorToolbarProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);

  if (!editor) return null;

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      editor.chain().focus().setImage({ src: dataUrl }).run();
    };
    reader.readAsDataURL(file);
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const btn = (label: string, isActive: boolean, onClick: () => void, title?: string) => (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className={`rounded px-1.5 py-1 text-xs transition-colors hover:bg-[var(--hover)] ${
        isActive
          ? 'bg-[var(--selected)] font-semibold text-[var(--selected-text)]'
          : 'text-[var(--muted-text)]'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
      {btn(
        'B',
        editor.isActive('bold'),
        () => editor.chain().focus().toggleBold().run(),
        'Bold (Ctrl+B)',
      )}
      {btn(
        'I',
        editor.isActive('italic'),
        () => editor.chain().focus().toggleItalic().run(),
        'Italic (Ctrl+I)',
      )}
      {btn(
        'U',
        editor.isActive('underline'),
        () => editor.chain().focus().toggleUnderline().run(),
        'Underline (Ctrl+U)',
      )}
      {btn(
        'S̶',
        editor.isActive('strike'),
        () => editor.chain().focus().toggleStrike().run(),
        'Strikethrough',
      )}
      {btn('A̲', editor.isActive('highlight'), () => editor.chain().focus().toggleHighlight().run())}
      <input
        type="color"
        title="Text color"
        onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
        className="h-5 w-5 cursor-pointer rounded border border-[var(--border)] bg-transparent"
        aria-label="Text color"
      />
      <select
        defaultValue=""
        title="Font"
        aria-label="Font family"
        onChange={(e) => editor.chain().focus().setFontFamily(e.target.value).run()}
        className="rounded border border-[var(--border)] bg-transparent px-1 py-0.5 text-xs text-[var(--muted-text)]"
      >
        <option value="">Font</option>
        <option value="var(--font-ui)">Sans</option>
        <option value="var(--font-serif)">Serif</option>
        <option value="var(--font-mono)">Mono</option>
      </select>

      <div className="mx-1 h-4 w-px bg-[var(--border)]" />

      {btn('H1', editor.isActive('heading', { level: 1 }), () =>
        editor.chain().focus().toggleHeading({ level: 1 }).run(),
      )}
      {btn('H2', editor.isActive('heading', { level: 2 }), () =>
        editor.chain().focus().toggleHeading({ level: 2 }).run(),
      )}
      {btn('H3', editor.isActive('heading', { level: 3 }), () =>
        editor.chain().focus().toggleHeading({ level: 3 }).run(),
      )}

      <div className="mx-1 h-4 w-px bg-[var(--border)]" />

      {btn('• List', editor.isActive('bulletList'), () =>
        editor.chain().focus().toggleBulletList().run(),
      )}
      {btn('1. List', editor.isActive('orderedList'), () =>
        editor.chain().focus().toggleOrderedList().run(),
      )}
      {btn('Quote', editor.isActive('blockquote'), () =>
        editor.chain().focus().toggleBlockquote().run(),
      )}
      {btn('< > Code', editor.isActive('codeBlock'), () =>
        editor.chain().focus().toggleCodeBlock().run(),
      )}

      <div className="mx-1 h-4 w-px bg-[var(--border)]" />

      {btn('— Rule', false, () => editor.chain().focus().setHorizontalRule().run())}
      {btn(
        'Link',
        editor.isActive('link'),
        () => {
          if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
          } else {
            onRequestLink();
          }
        },
        'Insert / edit link',
      )}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageSelect}
      />
      <button
        type="button"
        title="Insert image"
        onClick={() => imageInputRef.current?.click()}
        className="rounded px-1.5 py-1 text-xs text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)]"
      >
        Image
      </button>

      <div className="flex-1" />

      {onToggleAiAssist && (
        <button
          type="button"
          onClick={onToggleAiAssist}
          title="AI Assist"
          className={`flex items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors hover:bg-[var(--hover)] ${
            aiAssistOpen
              ? 'bg-[var(--accent)] font-semibold text-[var(--selected-text)]'
              : 'text-[var(--muted-text)]'
          }`}
        >
          AI
        </button>
      )}

      {btn('Undo', false, () => editor.chain().focus().undo().run())}
      {btn('Redo', false, () => editor.chain().focus().redo().run())}
    </div>
  );
}

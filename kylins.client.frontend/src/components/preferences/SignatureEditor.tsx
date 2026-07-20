import { useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Checkbox } from 'react-aria-components';
import { buildComposerExtensions } from '@/features/composer/editorExtensions';
import { sanitizeHtml } from '@/utils/sanitize';
import {
  BoldIcon,
  ItalicIcon,
  UnderlineIcon,
  StrikethroughIcon,
  BulletListIcon,
  OrderedListIcon,
  LinkIcon,
  CodeBlockIcon,
  PreferencesSignaturesIcon,
} from '../icons';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { SegmentedControl } from '../ui/SegmentedControl';
import type { DbSignature, SignatureContext } from '@/services/db/signatures';

const CONTEXT_OPTIONS: { value: SignatureContext; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New mail' },
  { value: 'reply', label: 'Reply' },
  { value: 'forward', label: 'Forward' },
];

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex h-11 w-11 items-center justify-center rounded transition-colors ${
        active
          ? 'bg-[var(--selected)] text-[var(--selected-text)]'
          : 'text-[var(--muted-text)] hover:text-[var(--foreground)] hover:bg-[var(--hover)]'
      }`}
    >
      {children}
    </button>
  );
}

interface SignatureEditorProps {
  initial: DbSignature;
  onSave: (values: {
    name: string;
    bodyHtml: string;
    context: SignatureContext;
    isDefault: boolean;
  }) => void | Promise<void>;
  onCancel: () => void;
}

export function SignatureEditor({ initial, onSave, onCancel }: SignatureEditorProps) {
  const [name, setName] = useState(initial.name);
  const [context, setContext] = useState<SignatureContext>(initial.context);
  const [isDefault, setIsDefault] = useState(initial.is_default === 1);
  const [showSource, setShowSource] = useState(false);
  const [bodyHtml, setBodyHtml] = useState(initial.body_html);
  const [isSaving, setIsSaving] = useState(false);

  const editor = useEditor({
    extensions: buildComposerExtensions('Signature body…'),
    content: initial.body_html,
    onUpdate: ({ editor: ed }) => {
      setBodyHtml(ed.getHTML());
    },
    editorProps: {
      attributes: {
        class:
          'kylins-editor max-w-none px-3 py-2 min-h-[140px] focus:outline-none text-[var(--foreground)] text-sm',
      },
    },
  });

  async function handleSave() {
    if (!name.trim()) return;
    setIsSaving(true);
    try {
      await onSave({
        name: name.trim(),
        bodyHtml: showSource ? bodyHtml : (editor?.getHTML() ?? bodyHtml),
        context,
        isDefault,
      });
    } finally {
      setIsSaving(false);
    }
  }

  function toggleSource() {
    if (!editor) return;
    if (!showSource) {
      setBodyHtml(editor.getHTML());
    } else {
      editor.commands.setContent(bodyHtml, { emitUpdate: false });
    }
    setShowSource((v) => !v);
  }

  return (
    <div className="space-y-5">
      <PreferencesSectionCard
        title={initial.id === 'new' ? 'New signature' : 'Edit signature'}
        icon={PreferencesSignaturesIcon}
      >
        <div className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="sig-name" className="type-overline text-[var(--muted-text)]">
              Name
            </label>
            <input
              id="sig-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Work signature"
              className="h-11 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="type-overline text-[var(--muted-text)]">Use for</span>
            <SegmentedControl options={CONTEXT_OPTIONS} value={context} onChange={setContext} />
          </div>

          <Checkbox
            isSelected={isDefault}
            onChange={setIsDefault}
            className="flex min-h-11 items-start gap-3 py-2 cursor-pointer group rounded-md hover:bg-[color-mix(in_oklab,var(--surface),black_4%)] px-2 -mx-2 transition-colors"
          >
            {({ isSelected }) => (
              <>
                <div
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                    isSelected
                      ? 'border-primary bg-primary text-primary-fg'
                      : 'border-border bg-background'
                  }`}
                >
                  {isSelected && (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                      <path
                        d="M1.5 5.5L4 8l4-5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </div>
                <span className="text-sm text-[var(--foreground)]">
                  Use as default for this context
                </span>
              </>
            )}
          </Checkbox>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="type-overline text-[var(--muted-text)]">Body</span>
              <button type="button" onClick={toggleSource} className="kylins-link text-xs">
                {showSource ? 'Visual editor' : 'HTML source'}
              </button>
            </div>

            {showSource ? (
              <textarea
                value={bodyHtml}
                onChange={(e) => setBodyHtml(e.target.value)}
                className="w-full min-h-[160px] px-3 py-2 text-xs font-mono rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none resize-y"
              />
            ) : (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] overflow-hidden">
                <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-1.5">
                  <ToolbarButton
                    active={editor?.isActive('bold')}
                    onClick={() => editor?.chain().focus().toggleBold().run()}
                    title="Bold"
                  >
                    <BoldIcon size={14} />
                  </ToolbarButton>
                  <ToolbarButton
                    active={editor?.isActive('italic')}
                    onClick={() => editor?.chain().focus().toggleItalic().run()}
                    title="Italic"
                  >
                    <ItalicIcon size={14} />
                  </ToolbarButton>
                  <ToolbarButton
                    active={editor?.isActive('underline')}
                    onClick={() => editor?.chain().focus().toggleUnderline().run()}
                    title="Underline"
                  >
                    <UnderlineIcon size={14} />
                  </ToolbarButton>
                  <ToolbarButton
                    active={editor?.isActive('strike')}
                    onClick={() => editor?.chain().focus().toggleStrike().run()}
                    title="Strikethrough"
                  >
                    <StrikethroughIcon size={14} />
                  </ToolbarButton>
                  <div className="w-px h-4 bg-[var(--border)] mx-1" />
                  <ToolbarButton
                    active={editor?.isActive('bulletList')}
                    onClick={() => editor?.chain().focus().toggleBulletList().run()}
                    title="Bullet list"
                  >
                    <BulletListIcon size={14} />
                  </ToolbarButton>
                  <ToolbarButton
                    active={editor?.isActive('orderedList')}
                    onClick={() => editor?.chain().focus().toggleOrderedList().run()}
                    title="Numbered list"
                  >
                    <OrderedListIcon size={14} />
                  </ToolbarButton>
                  <div className="w-px h-4 bg-[var(--border)] mx-1" />
                  <ToolbarButton
                    active={editor?.isActive('link')}
                    onClick={() => {
                      const href = window.prompt('Enter URL');
                      if (href) editor?.chain().focus().setLink({ href }).run();
                    }}
                    title="Link"
                  >
                    <LinkIcon size={14} />
                  </ToolbarButton>
                  <ToolbarButton
                    active={editor?.isActive('codeBlock')}
                    onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
                    title="Code block"
                  >
                    <CodeBlockIcon size={14} />
                  </ToolbarButton>
                </div>
                <EditorContent editor={editor} />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="type-overline text-[var(--muted-text)]">Preview</span>
            <div
              className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] min-h-[80px]"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(bodyHtml) }}
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center justify-center h-11 px-4 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!name.trim() || isSaving}
              className="inline-flex items-center justify-center h-11 px-4 text-sm font-medium rounded-lg bg-[var(--primary)] text-[var(--primary-fg)] shadow-[var(--shadow-sm)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
            >
              {isSaving ? 'Saving…' : 'Save signature'}
            </button>
          </div>
        </div>
      </PreferencesSectionCard>
    </div>
  );
}

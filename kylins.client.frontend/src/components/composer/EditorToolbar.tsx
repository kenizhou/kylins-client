// Adapted from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Icon-based TipTap formatting toolbar inspired by the editor in
// cmmp.outlook.aichat.frontend. StarterKit v3 already provides
// bold/italic/underline/strike/link/headings/lists/quote/code/history, so all
// toggles go through the editor chain.

import { useRef } from 'react';
import type { Editor } from '@tiptap/react';
import {
  ToggleButton,
  Select,
  SelectValue,
  Popover,
  ListBox,
  ListBoxItem,
  Button,
} from 'react-aria-components';
import {
  BoldIcon,
  ItalicIcon,
  UnderlineIcon,
  StrikethroughIcon,
  FontIcon,
  HighlightIcon,
  BulletListIcon,
  OrderedListIcon,
  QuoteIcon,
  CodeBlockIcon,
  LinkIcon,
  ImageIcon,
  H1Icon,
  H2Icon,
  H3Icon,
  UndoIcon,
  RedoIcon,
} from '../icons';

interface EditorToolbarProps {
  editor: Editor | null;
  /** Open the link dialog (owned by Composer, also triggered by Cmd/Ctrl+K). */
  onRequestLink: () => void;
  onToggleAiAssist?: () => void;
  aiAssistOpen?: boolean;
}

function ToolbarButton({
  icon: Icon,
  active,
  disabled,
  onClick,
  title,
  'aria-label': ariaLabel,
}: {
  icon: typeof BoldIcon;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  'aria-label'?: string;
}) {
  return (
    <ToggleButton
      isSelected={active}
      onChange={onClick}
      isDisabled={disabled}
      aria-label={ariaLabel ?? title}
      className="flex h-11 w-11 items-center justify-center rounded-md transition-colors data-[selected]:bg-[var(--primary-muted)] data-[selected]:text-[var(--primary)] text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon size={16} />
    </ToggleButton>
  );
}

function ToolbarDivider() {
  return <div className="mx-1 h-4 w-px bg-[var(--border)]" />;
}

const FONT_OPTIONS = [
  { label: 'Sans', value: 'var(--font-ui)' },
  { label: 'Serif', value: 'var(--font-serif)' },
  { label: 'Mono', value: 'var(--font-mono)' },
];

function FontFamilySelect({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const current = FONT_OPTIONS.find((o) => editor.isActive('textStyle', { fontFamily: o.value }));

  return (
    <Select
      isDisabled={disabled}
      aria-label="Font family"
      selectedKey={current?.value ?? null}
      onSelectionChange={(key) => {
        const option = FONT_OPTIONS.find((o) => o.value === key);
        if (option) editor.chain().focus().setFontFamily(option.value).run();
      }}
      className="relative"
    >
      <Button className="flex h-11 min-w-11 items-center gap-1 rounded-md px-1.5 text-xs transition-colors data-[pressed]:bg-[var(--primary-muted)] data-[pressed]:text-[var(--primary)] text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <FontIcon size={15} />
        <SelectValue className="hidden sm:inline">
          {({ selectedText }) => <>{selectedText || 'Font'}</>}
        </SelectValue>
        <span className="hidden sm:inline text-[10px] opacity-70">▼</span>
      </Button>
      <Popover className="min-w-[100px] rounded-lg border border-[var(--border-subtle)] bg-[var(--background)] p-1 shadow-[var(--shadow-lg)]">
        <ListBox items={FONT_OPTIONS} className="outline-none" aria-label="Font family">
          {(option) => (
            <ListBoxItem
              id={option.value}
              textValue={option.label}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs outline-none hover:bg-[var(--primary-subtle)] focus-visible:bg-[var(--primary-subtle)] data-[selected]:bg-[var(--primary-muted)] data-[selected]:text-[var(--primary)] min-h-11"
              style={{ fontFamily: option.value }}
            >
              {option.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}

function ColorButton({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const color = editor.getAttributes('textStyle').color as string | undefined;

  return (
    <label
      title="Text color"
      className={`relative flex h-11 w-11 cursor-pointer items-center justify-center rounded-md transition-colors ${
        color
          ? 'bg-[var(--primary-muted)] text-[var(--primary)]'
          : 'text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)]'
      } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
    >
      <span className="flex flex-col items-center gap-0.5">
        <span className="text-xs font-semibold">A</span>
        <span
          className="h-0.5 w-3.5 rounded-full"
          style={{ backgroundColor: color || 'currentColor' }}
        />
      </span>
      <input
        ref={inputRef}
        type="color"
        disabled={disabled}
        onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
        className="absolute inset-0 opacity-0"
        aria-label="Text color"
      />
    </label>
  );
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

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--border)] bg-[var(--surface)] px-2 py-1">
      <ToolbarButton
        icon={UndoIcon}
        disabled={!editor.can().undo()}
        onClick={() => editor.chain().undo().run()}
        title="Undo (Ctrl+Z)"
        aria-label="Undo"
      />
      <ToolbarButton
        icon={RedoIcon}
        disabled={!editor.can().redo()}
        onClick={() => editor.chain().redo().run()}
        title="Redo (Ctrl+Y)"
        aria-label="Redo"
      />

      <ToolbarDivider />

      <ToolbarButton
        icon={H1Icon}
        active={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        title="Heading 1"
        aria-label="Heading 1"
      />
      <ToolbarButton
        icon={H2Icon}
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        title="Heading 2"
        aria-label="Heading 2"
      />
      <ToolbarButton
        icon={H3Icon}
        active={editor.isActive('heading', { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        title="Heading 3"
        aria-label="Heading 3"
      />
      <ToolbarButton
        icon={BoldIcon}
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold (Ctrl+B)"
        aria-label="Bold"
      />
      <ToolbarButton
        icon={ItalicIcon}
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic (Ctrl+I)"
        aria-label="Italic"
      />
      <ToolbarButton
        icon={UnderlineIcon}
        active={editor.isActive('underline')}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title="Underline (Ctrl+U)"
        aria-label="Underline"
      />
      <ToolbarButton
        icon={StrikethroughIcon}
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title="Strikethrough"
        aria-label="Strikethrough"
      />

      <ToolbarDivider />

      <ToolbarButton
        icon={HighlightIcon}
        active={editor.isActive('highlight')}
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        title="Highlight"
        aria-label="Highlight"
      />
      <ColorButton editor={editor} />
      <FontFamilySelect editor={editor} />

      <ToolbarDivider />

      <ToolbarButton
        icon={BulletListIcon}
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="Bullet list"
        aria-label="Bullet list"
      />
      <ToolbarButton
        icon={OrderedListIcon}
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="Numbered list"
        aria-label="Numbered list"
      />
      <ToolbarButton
        icon={QuoteIcon}
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title="Quote"
        aria-label="Quote"
      />
      <ToolbarButton
        icon={CodeBlockIcon}
        active={editor.isActive('codeBlock')}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        title="Code block"
        aria-label="Code block"
      />

      <ToolbarDivider />

      <ToolbarButton
        icon={LinkIcon}
        active={editor.isActive('link')}
        onClick={() => {
          if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
          } else {
            onRequestLink();
          }
        }}
        title="Insert link (Ctrl+K)"
        aria-label="Insert link"
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageSelect}
      />
      <ToolbarButton
        icon={ImageIcon}
        onClick={() => imageInputRef.current?.click()}
        title="Insert image"
        aria-label="Insert image"
      />

      <div className="flex-1" />

      {onToggleAiAssist && (
        <ToggleButton
          isSelected={aiAssistOpen}
          onChange={onToggleAiAssist}
          aria-label="AI Assist"
          className="flex h-11 min-w-11 items-center gap-1 rounded-md px-2 text-xs transition-colors data-[selected]:bg-[var(--primary-muted)] data-[selected]:font-medium data-[selected]:text-[var(--primary)] text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>AI</span>
        </ToggleButton>
      )}
    </div>
  );
}

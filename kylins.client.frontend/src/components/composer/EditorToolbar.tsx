// Adapted from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Icon-based TipTap formatting toolbar inspired by the editor in
// cmmp.outlook.aichat.frontend. StarterKit v3 already provides
// bold/italic/underline/strike/link/headings/lists/quote/code/history, so all
// toggles go through the editor chain.

import { useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  ToggleButton,
  Select,
  SelectValue,
  Popover,
  ListBox,
  ListBoxItem,
  Button,
  DialogTrigger,
  Menu,
  MenuItem,
} from 'react-aria-components';
import { useElementWidth } from '@/hooks/useElementWidth';
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
  UndoIcon,
  RedoIcon,
  MoreIcon,
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
  // react-aria ToggleButton doesn't forward `title` — wrap for a native tooltip.
  return (
    <span title={title} className="inline-flex">
      <ToggleButton
        isSelected={active}
        onChange={onClick}
        isDisabled={disabled}
        aria-label={ariaLabel ?? title}
        className="flex h-11 w-11 items-center justify-center rounded-md transition-colors data-[selected]:bg-[var(--primary-muted)] data-[selected]:text-[var(--primary)] text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon size={16} />
      </ToggleButton>
    </span>
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

const STYLE_OPTIONS = [
  { label: 'Normal', value: 'paragraph' },
  { label: 'Heading 1', value: 'h1' },
  { label: 'Heading 2', value: 'h2' },
  { label: 'Heading 3', value: 'h3' },
] as const;

/** Paragraph/heading picker — replaces the old H1/H2/H3 button trio. */
function StyleSelect({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const current = editor.isActive('heading', { level: 1 })
    ? 'h1'
    : editor.isActive('heading', { level: 2 })
      ? 'h2'
      : editor.isActive('heading', { level: 3 })
        ? 'h3'
        : 'paragraph';

  return (
    <Select
      isDisabled={disabled}
      aria-label="Paragraph style"
      selectedKey={current}
      onSelectionChange={(key) => {
        if (key === 'paragraph') {
          editor.chain().focus().setParagraph().run();
        } else {
          const level = Number(String(key).slice(1)) as 1 | 2 | 3;
          editor.chain().focus().toggleHeading({ level }).run();
        }
      }}
      className="relative"
    >
      <span title="Paragraph style" className="inline-flex">
        <Button
          aria-label="Paragraph style"
          className="flex h-11 min-w-11 items-center gap-1 rounded-md px-1.5 text-xs transition-colors data-[pressed]:bg-[var(--primary-muted)] data-[pressed]:text-[var(--primary)] text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <H1Icon size={15} />
          <SelectValue className="hidden sm:inline">
            {({ selectedText }) => <>{selectedText || 'Style'}</>}
          </SelectValue>
          <span className="hidden sm:inline text-[10px] opacity-70">▼</span>
        </Button>
      </span>
      <Popover className="min-w-[120px] rounded-lg border border-[var(--border-subtle)] bg-[var(--background)] p-1 shadow-[var(--shadow-lg)]">
        <ListBox items={STYLE_OPTIONS} className="outline-none" aria-label="Paragraph style">
          {(option) => (
            <ListBoxItem
              id={option.value}
              textValue={option.label}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs outline-none hover:bg-[var(--primary-subtle)] focus-visible:bg-[var(--primary-subtle)] data-[selected]:bg-[var(--primary-muted)] data-[selected]:text-[var(--primary)] min-h-9"
            >
              {option.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}

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
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs outline-none hover:bg-[var(--primary-subtle)] focus-visible:bg-[var(--primary-subtle)] data-[selected]:bg-[var(--primary-muted)] data-[selected]:text-[var(--primary)] min-h-9"
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
  const [overflowOpen, setOverflowOpen] = useState(false);
  const { ref: barRef, width: barWidth } = useElementWidth<HTMLDivElement>();
  const narrow = barWidth > 0 && barWidth < 900;
  const compact = barWidth > 0 && barWidth < 640;

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
    <div
      ref={barRef}
      className="mx-1 mt-1 flex flex-nowrap items-center gap-0.5 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] px-2 py-1 shadow-[var(--ribbon-elevation)] md:mx-2"
    >
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

      <StyleSelect editor={editor} />

      <ToolbarDivider />

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

      {!narrow && (
        <>
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
        </>
      )}

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

      {!compact && (
        <>
          <ToolbarDivider />

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
        </>
      )}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageSelect}
      />
      {!compact && (
        <ToolbarButton
          icon={ImageIcon}
          onClick={() => imageInputRef.current?.click()}
          title="Insert image"
          aria-label="Insert image"
        />
      )}

      {(narrow || compact) && (
        <DialogTrigger isOpen={overflowOpen} onOpenChange={setOverflowOpen}>
          <span title="More formatting" className="inline-flex">
            <Button
              aria-label="More formatting"
              className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--muted-text)] transition-colors hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              <MoreIcon size={16} />
            </Button>
          </span>
          <Popover className="min-w-[180px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg">
            <Menu aria-label="More formatting" className="outline-none">
              {narrow && (
                <MenuItem
                  id="highlight"
                  onAction={() => editor.chain().focus().toggleHighlight().run()}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                >
                  Highlight
                </MenuItem>
              )}
              {compact && (
                <>
                  <MenuItem
                    id="quote"
                    onAction={() => editor.chain().focus().toggleBlockquote().run()}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                  >
                    Quote
                  </MenuItem>
                  <MenuItem
                    id="code-block"
                    onAction={() => editor.chain().focus().toggleCodeBlock().run()}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                  >
                    Code block
                  </MenuItem>
                  <MenuItem
                    id="link"
                    onAction={() => {
                      if (editor.isActive('link')) {
                        editor.chain().focus().unsetLink().run();
                      } else {
                        onRequestLink();
                      }
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                  >
                    Insert link
                  </MenuItem>
                  <MenuItem
                    id="image"
                    onAction={() => imageInputRef.current?.click()}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--primary-subtle)]"
                  >
                    Insert image
                  </MenuItem>
                </>
              )}
            </Menu>
          </Popover>
        </DialogTrigger>
      )}

      <div className="flex-1" />

      {onToggleAiAssist && (
        <span title="AI Assist" className="inline-flex">
          <ToggleButton
            isSelected={aiAssistOpen}
            onChange={onToggleAiAssist}
            aria-label="AI Assist"
            className="flex h-11 min-w-11 items-center gap-1 rounded-md px-2 text-xs transition-colors data-[selected]:bg-[var(--primary-muted)] data-[selected]:font-medium data-[selected]:text-[var(--primary)] text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>AI</span>
          </ToggleButton>
        </span>
      )}
    </div>
  );
}

// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Canned-template picker. Inserts the template body at the cursor and, for a
// brand-new message with an empty subject, fills the subject too. Uses slice
// selectors (not whole-store destructuring) to avoid re-render storms.

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Editor } from '@tiptap/react';
import { useAccountStore } from '@/stores/accountStore';
import { useComposerStore } from '@/stores/composerStore';
import { getTemplatesForAccount, type DbTemplate } from '@/services/db/templates';
import { FileTextIcon } from '../icons';

interface TemplatePickerProps {
  editor: Editor | null;
}

export function TemplatePicker({ editor }: TemplatePickerProps) {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const mode = useComposerStore((s) => s.mode);
  const subject = useComposerStore((s) => s.subject);
  const setSubject = useComposerStore((s) => s.setSubject);
  const [templates, setTemplates] = useState<DbTemplate[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeAccountId) return;
    let cancelled = false;
    getTemplatesForAccount(activeAccountId).then((t) => {
      if (!cancelled) setTemplates(t);
    });
    return () => {
      cancelled = true;
    };
  }, [activeAccountId]);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const handleSelect = useCallback(
    (tmpl: DbTemplate) => {
      if (!editor) return;
      if (mode === 'new' && !subject && tmpl.subject) {
        setSubject(tmpl.subject);
      }
      editor.commands.insertContent(tmpl.body_html);
      setIsOpen(false);
    },
    [editor, mode, subject, setSubject],
  );

  if (templates.length === 0) return null;

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--muted-text)]"
      >
        <FileTextIcon size={12} />
        Templates
        <span className="text-[0.625rem]">▾</span>
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 z-10 mb-1 max-h-48 w-56 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--popover)] shadow-lg">
          {templates.map((tmpl) => (
            <button
              key={tmpl.id}
              onClick={() => handleSelect(tmpl)}
              className="w-full px-3 py-2 text-left transition-colors hover:bg-[var(--hover)]"
            >
              <div className="text-xs font-medium text-[var(--foreground)]">{tmpl.name}</div>
              {tmpl.subject && (
                <div className="truncate text-[0.625rem] text-[var(--muted-foreground)]">
                  {tmpl.subject}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Canned-template picker. Inserts the template body at the cursor and, for a
// brand-new message with an empty subject, fills the subject too. Uses slice
// selectors (not whole-store destructuring) to avoid re-render storms.

import { useState, useEffect, useCallback } from 'react';
import type { Editor } from '@tiptap/react';
import { useAccountStore } from '@/stores/accountStore';
import { useComposerStore } from '@/stores/composerStore';
import { getTemplatesForAccount, type DbTemplate } from '@/services/db/templates';
import { FileTextIcon } from '../icons';
import { MenuTrigger, Button, Popover, Menu, MenuItem } from 'react-aria-components';

interface TemplatePickerProps {
  editor: Editor | null;
}

export function TemplatePicker({ editor }: TemplatePickerProps) {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const mode = useComposerStore((s) => s.mode);
  const subject = useComposerStore((s) => s.subject);
  const setSubject = useComposerStore((s) => s.setSubject);
  const [templates, setTemplates] = useState<DbTemplate[]>([]);

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

  const handleSelect = useCallback(
    (tmpl: DbTemplate) => {
      if (!editor) return;
      if (mode === 'new' && !subject && tmpl.subject) {
        setSubject(tmpl.subject);
      }
      editor.commands.insertContent(tmpl.body_html);
    },
    [editor, mode, subject, setSubject],
  );

  if (templates.length === 0) return null;

  return (
    <MenuTrigger>
      <Button className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-muted-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <FileTextIcon size={12} />
        Templates
        <span aria-hidden="true" className="text-[0.625rem]">
          ▾
        </span>
      </Button>
      <Popover className="max-h-48 w-56 overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-popover shadow-[var(--shadow-lg)]">
        <Menu
          aria-label="Templates"
          items={templates}
          onAction={(key) => {
            const tmpl = templates.find((t) => t.id === key);
            if (tmpl) handleSelect(tmpl);
          }}
          className="py-1 outline-none"
        >
          {(tmpl) => (
            <MenuItem
              id={tmpl.id}
              textValue={tmpl.name}
              className="w-full px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none"
            >
              <div className="text-xs font-medium text-foreground">{tmpl.name}</div>
              {tmpl.subject && (
                <div className="truncate text-[0.625rem] text-muted-foreground">{tmpl.subject}</div>
              )}
            </MenuItem>
          )}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

import type { Editor } from '@tiptap/react';
import { useUIStore } from '@/stores/uiStore';
import { useAccountStore } from '@/stores/accountStore';
import { useComposerStore } from '@/stores/composerStore';
import { useComposerSignature } from '@/features/composer/useComposerSignature';
import { SignatureSelector } from '../SignatureSelector';
import { TemplatePicker } from '../TemplatePicker';
import { SpinnerIcon } from '../../icons';

export interface ComposerStatusBarProps {
  editor: Editor | null;
  wordCount: number;
  charCount: number;
  /** Draft-save state ("Saving…" / "Draft saved · HH:MM"), shown on the left. */
  draftLabel?: string | null;
  className?: string;
}

/**
 * Composer status bar (both windowed and inline modes). Left: draft-save
 * state + send progress. Right: live word stats and the signature/template
 * pickers. The account identity lives in the From row, so it is not
 * duplicated here.
 */
export function ComposerStatusBar({
  editor,
  wordCount,
  charCount,
  draftLabel,
  className,
}: ComposerStatusBarProps) {
  const sendProgress = useUIStore((s) => s.sendProgress);

  // Signature control lives here so both the modal and the pop-out composer
  // share it. The editor document is the source of truth; the store only
  // mirrors the active id for send/draft/pop-out persistence.
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const mode = useComposerStore((s) => s.mode);
  const storedSignatureId = useComposerStore((s) => s.signatureId);
  const setSignatureId = useComposerStore((s) => s.setSignatureId);
  const signature = useComposerSignature(editor, activeAccountId, mode, {
    initialSignatureId: storedSignatureId,
    onChange: setSignatureId,
  });

  return (
    <footer
      className={`flex h-[var(--status-h)] shrink-0 items-center justify-between border-t border-[var(--border-subtle)] bg-[var(--chrome)] px-3 text-xs text-[var(--muted-text)] ${className ?? ''}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        {draftLabel && <span className="italic">{draftLabel}</span>}
        {sendProgress.active && (
          <span
            className="inline-flex items-center gap-1.5 text-[var(--primary)]"
            title={sendProgress.message}
          >
            <SpinnerIcon size={12} />
            <span>{sendProgress.message || 'Sending…'}</span>
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="tabular-nums">
          {wordCount} words · {charCount} characters
        </span>
        <span className="mx-1 h-3 w-px bg-[var(--border-subtle)]" />
        <SignatureSelector
          signatures={signature.signatures}
          activeId={signature.activeId}
          onSelect={signature.setSignature}
          disabled={!signature.ready}
        />
        <TemplatePicker editor={editor} />
      </div>
    </footer>
  );
}

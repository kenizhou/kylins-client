import type { Editor } from '@tiptap/react';
import { useComposerStore } from '@/stores/composerStore';
import { useAccountStore } from '@/stores/accountStore';
import { useUIStore } from '@/stores/uiStore';
import { SignatureSelector } from '../SignatureSelector';
import { TemplatePicker } from '../TemplatePicker';
import { SpinnerIcon } from '../../icons';

export interface ComposerStatusBarProps {
  editor: Editor | null;
  wordCount: number;
  charCount: number;
}

/**
 * Main-window-style status bar for the composer pop-out. Left: identity +
 * draft + send state. Right: live word stats and the signature/template
 * pickers (relocated from the old panel footer).
 */
export function ComposerStatusBar({ editor, wordCount, charCount }: ComposerStatusBarProps) {
  const fromEmail = useComposerStore((s) => s.fromEmail);
  const isSaving = useComposerStore((s) => s.isSaving);
  const lastSavedAt = useComposerStore((s) => s.lastSavedAt);
  const activeAccount = useAccountStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const sendProgress = useUIStore((s) => s.sendProgress);

  const savedLabel = isSaving ? 'Saving...' : lastSavedAt ? 'Draft saved' : null;

  return (
    <footer className="flex h-[var(--status-h)] shrink-0 items-center justify-between border-t border-[var(--border-subtle)] bg-[var(--chrome)] px-3 text-xs text-[var(--muted-text)]">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate">{fromEmail ?? activeAccount?.email ?? 'No account'}</span>
        {savedLabel && (
          <span
            className={`italic transition-opacity duration-200 ${isSaving ? 'animate-pulse' : ''}`}
          >
            {savedLabel}
          </span>
        )}
        {sendProgress.active && (
          <span
            className="inline-flex items-center gap-1.5 text-[var(--primary)]"
            title={sendProgress.message}
          >
            <SpinnerIcon size={12} />
            <span>{sendProgress.message ?? 'Sending…'}</span>
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="tabular-nums">
          {wordCount} words · {charCount} characters
        </span>
        <span className="mx-1 h-3 w-px bg-[var(--border-subtle)]" />
        <SignatureSelector />
        <TemplatePicker editor={editor} />
      </div>
    </footer>
  );
}

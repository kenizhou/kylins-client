// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.

import { useComposerStore } from '@/stores/composerStore';
import { formatFileSize } from '@/utils/fileTypeHelpers';
import { CloseIcon } from '../icons';

export function AttachmentPicker() {
  const attachments = useComposerStore((s) => s.attachments);
  const removeAttachment = useComposerStore((s) => s.removeAttachment);

  const totalSize = attachments.reduce((sum, a) => sum + a.size, 0);

  return (
    <div className="px-4">
      <div className="flex flex-wrap items-center gap-2">
        {attachments.map((att) => (
          <div
            key={att.id}
            className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
          >
            <span className="max-w-[150px] truncate text-[var(--foreground)]">{att.filename}</span>
            <span className="text-[var(--muted-foreground)]">{formatFileSize(att.size)}</span>
            <button
              onClick={() => removeAttachment(att.id)}
              className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              aria-label={`Remove ${att.filename}`}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        ))}

        {attachments.length > 0 && (
          <span className="text-xs text-[var(--muted-foreground)]">
            {formatFileSize(totalSize)} total
          </span>
        )}
      </div>
    </div>
  );
}

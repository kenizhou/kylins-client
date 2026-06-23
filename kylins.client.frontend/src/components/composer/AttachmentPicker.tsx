// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.

import { useRef } from 'react';
import { useComposerStore, type ComposerAttachment } from '@/stores/composerStore';
import { readFileAsBase64 } from '@/utils/fileUtils';
import { formatFileSize } from '@/utils/fileTypeHelpers';
import { AttachmentIcon, CloseIcon } from '../icons';

const MAX_TOTAL_SIZE = 24 * 1024 * 1024; // 24MB

export function AttachmentPicker() {
  const inputRef = useRef<HTMLInputElement>(null);
  const attachments = useComposerStore((s) => s.attachments);
  const addAttachment = useComposerStore((s) => s.addAttachment);
  const removeAttachment = useComposerStore((s) => s.removeAttachment);

  const totalSize = attachments.reduce((sum, a) => sum + a.size, 0);

  const handleFiles = async (files: FileList) => {
    let runningTotal = totalSize;
    for (const file of Array.from(files)) {
      if (runningTotal + file.size > MAX_TOTAL_SIZE) {
        console.warn('Attachment size limit exceeded (24MB)');
        break;
      }
      const content = await readFileAsBase64(file);
      const attachment: ComposerAttachment = {
        id: crypto.randomUUID(),
        file,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        content,
      };
      addAttachment(attachment);
      runningTotal += file.size;
    }
    // Reset input so re-selecting the same file works.
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="px-4">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleFiles(e.target.files);
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex items-center gap-1 py-1 text-xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
          title="Attach files"
        >
          <AttachmentIcon size={14} />
          <span>Attach</span>
        </button>

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

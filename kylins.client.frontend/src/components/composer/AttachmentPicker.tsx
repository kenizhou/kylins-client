// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.

import { TagGroup, Tag, TagList, Label, Button } from 'react-aria-components';
import { useComposerStore } from '@/stores/composerStore';
import { formatFileSize } from '@/utils/fileTypeHelpers';
import { CloseIcon } from '../icons';

export function AttachmentPicker() {
  const attachments = useComposerStore((s) => s.attachments);
  const removeAttachment = useComposerStore((s) => s.removeAttachment);

  const totalSize = attachments.reduce((sum, a) => sum + a.size, 0);

  return (
    <div className="px-4">
      <TagGroup
        onRemove={(keys) => {
          for (const id of keys) removeAttachment(String(id));
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <Label className="sr-only">Attachments</Label>
        <TagList items={attachments} className="contents">
          {(att) => (
            <Tag
              id={att.id}
              textValue={att.filename}
              className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--foreground)] outline-none transition-colors hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-ring data-[selected]:bg-[var(--selected)] data-[selected]:text-[var(--selected-text)]"
            >
              <span className="max-w-[150px] truncate">{att.filename}</span>
              <span className="text-[var(--muted-foreground)]">{formatFileSize(att.size)}</span>
              <Button
                slot="remove"
                className="text-[var(--muted-foreground)] outline-none transition-colors hover:text-[var(--foreground)] focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={`Remove ${att.filename}`}
              >
                <CloseIcon size={12} />
              </Button>
            </Tag>
          )}
        </TagList>

        {attachments.length > 0 && (
          <span className="text-xs text-[var(--muted-foreground)]">
            {formatFileSize(totalSize)} total
          </span>
        )}
      </TagGroup>
    </div>
  );
}

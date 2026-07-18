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
    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
      <TagGroup
        onRemove={(keys) => {
          for (const id of keys) removeAttachment(String(id));
        }}
        className="contents"
      >
        <Label className="sr-only">Attachments</Label>
        <TagList items={attachments} className="contents">
          {(att) => (
            <Tag
              id={att.id}
              textValue={att.filename}
              className="inline-flex items-center gap-1.5 rounded-full bg-highlight px-2.5 py-1 text-xs text-highlight-text outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring data-[selected]:opacity-100"
            >
              <span className="max-w-[150px] truncate">{att.filename}</span>
              <span className="text-highlight-text/70">{formatFileSize(att.size)}</span>
              <Button
                slot="remove"
                className="text-highlight-text/70 outline-none transition-colors hover:text-highlight-text focus-visible:ring-1 focus-visible:ring-ring"
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

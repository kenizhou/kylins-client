// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Signature picker dropdown. Presentational: the parent drives it with the
// useComposerSignature hook, so `activeId` always reflects the signature node
// actually in the editor document (correct after swaps, the block's remove
// button, and undo/redo — Mailspring's currentSignatureIdSlate behavior).

import { Select, Button, Popover, ListBox, ListBoxItem, SelectValue } from 'react-aria-components';
import { CONTEXT_LABELS, type DbSignature } from '@/services/db/signatures';
import { CheckIcon } from '../icons';

interface SignatureSelectorProps {
  signatures: DbSignature[];
  /** Id of the signature currently in the editor doc (null = none). */
  activeId: string | null;
  /** Swap to the given signature id, or null for "No signature". */
  onSelect: (id: string | null) => void;
  /** Disabled while the initial default is being applied (prevents the async
   *  default application from clobbering a premature user choice). */
  disabled?: boolean;
}

export function SignatureSelector({
  signatures,
  activeId,
  onSelect,
  disabled,
}: SignatureSelectorProps) {
  if (signatures.length === 0) return null;

  return (
    <Select
      selectedKey={activeId ?? ''}
      onSelectionChange={(key) => onSelect(key === '' ? null : String(key))}
      aria-label="Signature"
      isDisabled={disabled}
      className="cursor-pointer rounded-lg border border-[var(--border-subtle)] bg-secondary px-1.5 py-0.5 text-[0.625rem] text-muted-text data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed"
    >
      <Button className="flex items-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <SelectValue />
        <span aria-hidden="true">▾</span>
      </Button>
      <Popover className="min-w-[--trigger-width] rounded-lg border border-[var(--border-subtle)] bg-popover shadow-[var(--shadow-lg)]">
        <ListBox className="py-1 outline-none">
          <ListBoxItem
            id=""
            textValue="No signature"
            className="cursor-pointer px-3 py-2 text-sm text-foreground outline-none hover:bg-hover selected:bg-selected selected:text-selected-text focus-visible:bg-hover focus-visible:outline-none"
          >
            {({ isSelected }) => (
              <span className="flex items-center justify-between gap-3">
                No signature
                {isSelected && <CheckIcon size={14} />}
              </span>
            )}
          </ListBoxItem>
          {signatures.map((sig) => (
            <ListBoxItem
              key={sig.id}
              id={sig.id}
              textValue={`${sig.name} (${CONTEXT_LABELS[sig.context]})`}
              className="cursor-pointer px-3 py-2 text-sm text-foreground outline-none hover:bg-hover selected:bg-selected selected:text-selected-text focus-visible:bg-hover focus-visible:outline-none"
            >
              {({ isSelected }) => (
                <span className="flex items-center justify-between gap-3">
                  <span>
                    {sig.name} ({CONTEXT_LABELS[sig.context]})
                  </span>
                  {isSelected && <CheckIcon size={14} />}
                </span>
              )}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

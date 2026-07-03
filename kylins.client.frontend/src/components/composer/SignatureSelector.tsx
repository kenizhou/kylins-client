// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Per-account signature picker. Selecting a signature writes its HTML into the
// composer store so it is appended to the outgoing message body on send.

import { useState, useEffect } from 'react';
import { useComposerStore } from '@/stores/composerStore';
import { useAccountStore } from '@/stores/accountStore';
import {
  getSignaturesForAccount,
  type DbSignature,
  CONTEXT_LABELS,
} from '@/services/db/signatures';
import { Select, Button, Popover, ListBox, ListBoxItem, SelectValue } from 'react-aria-components';

export function SignatureSelector() {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const isOpen = useComposerStore((s) => s.isOpen);
  const signatureId = useComposerStore((s) => s.signatureId);
  const setSignatureHtml = useComposerStore((s) => s.setSignatureHtml);
  const setSignatureId = useComposerStore((s) => s.setSignatureId);
  const [signatures, setSignatures] = useState<DbSignature[]>([]);

  useEffect(() => {
    if (!isOpen || !activeAccountId) return;
    let cancelled = false;
    getSignaturesForAccount(activeAccountId).then((sigs) => {
      if (!cancelled) setSignatures(sigs);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeAccountId]);

  if (signatures.length === 0) return null;

  const handleChange = (id: string) => {
    if (id === '') {
      setSignatureId(null);
      setSignatureHtml('');
      return;
    }
    const sig = signatures.find((s) => s.id === id);
    if (sig) {
      setSignatureId(sig.id);
      setSignatureHtml(sig.body_html);
    }
  };

  return (
    <Select
      selectedKey={signatureId ?? ''}
      onSelectionChange={(key) => handleChange(String(key))}
      aria-label="Signature"
      className="cursor-pointer rounded border border-border bg-secondary px-1.5 py-0.5 text-[0.625rem] text-muted-text"
    >
      <Button className="flex items-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <SelectValue />
        <span aria-hidden="true">▾</span>
      </Button>
      <Popover className="min-w-[--trigger-width] rounded border border-border bg-popover shadow-lg">
        <ListBox className="py-1 outline-none">
          <ListBoxItem
            id=""
            className="cursor-pointer px-3 py-2 text-sm text-foreground hover:bg-hover selected:bg-selected selected:text-selected-text focus-visible:outline-none"
          >
            No signature
          </ListBoxItem>
          {signatures.map((sig) => (
            <ListBoxItem
              key={sig.id}
              id={sig.id}
              className="cursor-pointer px-3 py-2 text-sm text-foreground hover:bg-hover selected:bg-selected selected:text-selected-text focus-visible:outline-none"
            >
              {sig.name} ({CONTEXT_LABELS[sig.context]})
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

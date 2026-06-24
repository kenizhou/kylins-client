// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Per-account signature picker. Selecting a signature writes its HTML into the
// composer store so it is appended to the outgoing message body on send.

import { useState, useEffect } from 'react';
import { useComposerStore } from '@/stores/composerStore';
import { useAccountStore } from '@/stores/accountStore';
import { getSignaturesForAccount, type DbSignature } from '@/services/db/signatures';

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
    <select
      value={signatureId ?? ''}
      onChange={(e) => handleChange(e.target.value)}
      className="rounded border border-[var(--border)] bg-[var(--secondary)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-text)]"
      aria-label="Signature"
    >
      <option value="">No signature</option>
      {signatures.map((sig) => (
        <option key={sig.id} value={sig.id}>
          {sig.name}
        </option>
      ))}
    </select>
  );
}

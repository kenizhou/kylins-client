// Shared signature controller for both composer surfaces (modal Composer via
// ComposerStatusBar, and InlineReply). It owns:
//   - loading the account's signatures,
//   - applying the context-appropriate default once when the composer opens
//     (skipped when the document already carries a signature node — e.g. a
//     reopened draft or a pop-out restore),
//   - tracking the ACTIVE signature from the ProseMirror document itself, so
//     the picker checkmark stays correct after swaps, remove-button deletes,
//     and undo/redo,
//   - swapping/removing the block via setSignatureInEditor.
//
// The consumer keeps only the active id (composerStore.signatureId for the
// modal composer, local state for the inline reply) for send/draft/pop-out
// persistence, synced through `onChange`.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { ComposerMode } from '@/stores/composerStore';
import {
  getDefaultSignature,
  getSignaturesForAccount,
  signatureContextForComposerMode,
  type DbSignature,
} from '@/services/db/signatures';
import { getActiveSignatureId, setSignatureInEditor } from './signatureCommands';

export interface ComposerSignatureApi {
  signatures: DbSignature[];
  /** Id of the signature node currently in the editor doc (null = none). */
  activeId: string | null;
  /** True once the initial (default/restored) signature has been applied. */
  ready: boolean;
  /** Swap to another signature, or pass null to remove it. One PM transaction. */
  setSignature: (id: string | null) => void;
}

interface UseComposerSignatureOptions {
  /**
   * Caller-requested signature, three-state:
   *  - `undefined` — no request; apply the account default for the context.
   *  - `null` — explicitly NO signature (user removed it before a draft save
   *    or pop-out); never re-add the default.
   *  - `string` — apply that signature (pop-out/draft restore).
   */
  initialSignatureId?: string | null;
  /** Fires whenever the active signature in the document changes. */
  onChange?: (id: string | null) => void;
}

export function useComposerSignature(
  editor: Editor | null,
  accountId: string | null,
  mode: ComposerMode,
  options: UseComposerSignatureOptions = {},
): ComposerSignatureApi {
  const [activeId, setActiveId] = useState<string | null>(() =>
    editor ? getActiveSignatureId(editor.state.doc) : null,
  );
  // Signatures are considered "loaded" only when the fetched list matches the
  // current account — a switch leaves signatures null until the refetch lands,
  // which holds back the initial-apply effect below.
  const [loadedFor, setLoadedFor] = useState<{
    accountId: string;
    sigs: DbSignature[];
  } | null>(null);
  const signatures = accountId && loadedFor?.accountId === accountId ? loadedFor.sigs : null;
  // "ready" is derived: the initial apply has completed for this account+mode.
  const applyKey = accountId ? `${accountId}:${mode}` : null;
  const [appliedFor, setAppliedFor] = useState<string | null>(null);
  const ready = applyKey !== null && appliedFor === applyKey;

  const onChangeRef = useRef(options.onChange);
  const initialSignatureIdRef = useRef(options.initialSignatureId);
  useEffect(() => {
    onChangeRef.current = options.onChange;
    initialSignatureIdRef.current = options.initialSignatureId;
  });

  // Load the account's signatures.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    getSignaturesForAccount(accountId)
      .then((sigs) => {
        if (!cancelled) setLoadedFor({ accountId, sigs: sigs ?? [] });
      })
      .catch((err) => {
        console.error('[useComposerSignature] failed to load signatures', err);
        if (!cancelled) setLoadedFor({ accountId, sigs: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Track the active signature from the document (swaps, remove button,
  // undo/redo all flow through transactions).
  useEffect(() => {
    if (!editor) return;
    const update = () => setActiveId(getActiveSignatureId(editor.state.doc));
    update();
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);

  // Mirror the active id to the caller — but only once ready. Before the
  // initial application, activeId is null (empty doc); firing onChange then
  // would write "explicitly no signature" into the caller's state and
  // suppress the very default we're about to apply.
  useEffect(() => {
    if (!ready) return;
    onChangeRef.current?.(activeId);
  }, [activeId, ready]);

  // Apply the initial signature once per account+mode. The document is
  // authoritative: a signature node already in the doc (restored draft /
  // pop-out) is kept — but only if it belongs to THIS account's signature
  // list; a foreign node means the user switched accounts mid-compose, so it
  // is dropped in favor of the new account's default.
  useEffect(() => {
    if (!editor || !accountId || signatures === null || ready || !applyKey) return;
    let cancelled = false;
    const key = applyKey;
    void (async () => {
      // Yield before touching state: React lint rules (and subtle render
      // ordering) disallow synchronous setState inside an effect body.
      await Promise.resolve();
      if (cancelled) return;

      const existingId = getActiveSignatureId(editor.state.doc);
      if (existingId && signatures.some((s) => s.id === existingId)) {
        setAppliedFor(key);
        return;
      }
      if (existingId) {
        setSignatureInEditor(editor, null, { addToHistory: false });
      }
      const requestedId = initialSignatureIdRef.current;
      let sig = requestedId ? (signatures.find((s) => s.id === requestedId) ?? null) : null;
      // Fall back to the account default when nothing was requested
      // (undefined) or the requested signature is gone from this account's
      // list (deleted, or belongs to the previous account after a switch).
      // Explicit `null` = user chose "No signature" — never re-add.
      if (!sig && requestedId !== null) {
        sig = await getDefaultSignature(accountId, signatureContextForComposerMode(mode));
      }
      if (cancelled) return;
      // Re-check after the await: the user may have picked/removed a signature
      // (or one may have landed via another effect) while the default loaded.
      if (sig && !getActiveSignatureId(editor.state.doc)) {
        // Not undoable: the user never explicitly inserted this signature.
        setSignatureInEditor(editor, { id: sig.id, html: sig.body_html }, { addToHistory: false });
      }
      setAppliedFor(key);
    })();
    return () => {
      cancelled = true;
    };
  }, [editor, accountId, signatures, ready, applyKey, mode]);

  const setSignature = useCallback(
    (id: string | null) => {
      if (!editor) return;
      if (id === null) {
        setSignatureInEditor(editor, null);
        return;
      }
      const sig = (signatures ?? []).find((s) => s.id === id);
      if (sig) {
        setSignatureInEditor(editor, { id: sig.id, html: sig.body_html });
      }
    },
    [editor, signatures],
  );

  return { signatures: signatures ?? [], activeId, ready, setSignature };
}

// Routes the compose ribbon / classification selector to whichever composer
// surface is actually live.
//
// Previously ComposeRibbon always read/wrote composerStore — but the docked
// inline composer never reads that store, so while an inline reply was open
// the ribbon's Encrypt/Sign/Importance/Tracking toggles mutated state nobody
// sent from (and the mutation leaked into the next modal compose session).
//
// Post drafting-flow redesign there are exactly two surfaces, each in its own
// window/JS context:
//   - the reading-pane dock (inlineComposerStore) — main window,
//   - the OS compose window (composerStore) — `compose-*` WebviewWindow.
// In the main window composerStore.isOpen is never true (the in-app modal was
// removed), so the inline branch drives the ribbon whenever the dock shows;
// in a compose window there is no inline session, so the composerStore branch
// always drives that window's ClassificationSelector.
//
// The hook returns the option fields + setters both stores share (the
// InlineDraftFields shape), plus a `supports` capability set so controls a
// surface can't honor are hidden rather than dead (e.g. Delay Delivery's
// dialog lives only in the compose window's Composer).

import { useComposerStore, type Importance } from '@/stores/composerStore';
import { useInlineComposerStore, useInlineComposerVisible } from '@/stores/inlineComposerStore';

export interface ComposerTargetCapabilities {
  /** Schedule/delay-delivery picker (OS compose window only). */
  delayDelivery: boolean;
}

export interface ComposerTarget {
  classificationId: string | null;
  isEncrypted: boolean;
  isSigned: boolean;
  importance: Importance;
  requestReadReceipt: boolean;
  requestDeliveryReceipt: boolean;
  deliverAt: number | null;
  preventCopy: boolean;
  setClassificationId: (v: string | null) => void;
  setIsEncrypted: (v: boolean) => void;
  setIsSigned: (v: boolean) => void;
  setImportance: (v: Importance) => void;
  setRequestReadReceipt: (v: boolean) => void;
  setRequestDeliveryReceipt: (v: boolean) => void;
  setPreventCopy: (v: boolean) => void;
  supports: ComposerTargetCapabilities;
}

export function useActiveComposerTarget(): ComposerTarget {
  const inlineVisible = useInlineComposerVisible();
  const session = useInlineComposerStore((s) => s.session);
  const modal = useComposerStore();

  // The inline branch drives the ribbon whenever the dock is visible. In the
  // main window composerStore.isOpen is never true (the in-app modal popup
  // was removed), so there is no competing foreground surface; in a compose
  // window there is no inline session, so the composerStore branch always
  // drives that window's selector.
  if (!modal.isOpen && inlineVisible && session) {
    // Zustand actions are stable — safe to read via getState().
    const actions = useInlineComposerStore.getState();
    return {
      classificationId: session.classificationId,
      isEncrypted: session.isEncrypted,
      isSigned: session.isSigned,
      importance: session.importance,
      requestReadReceipt: session.requestReadReceipt,
      requestDeliveryReceipt: session.requestDeliveryReceipt,
      deliverAt: session.deliverAt,
      preventCopy: session.preventCopy,
      setClassificationId: actions.setClassificationId,
      setIsEncrypted: actions.setIsEncrypted,
      setIsSigned: actions.setIsSigned,
      setImportance: actions.setImportance,
      setRequestReadReceipt: actions.setRequestReadReceipt,
      setRequestDeliveryReceipt: actions.setRequestDeliveryReceipt,
      setPreventCopy: actions.setPreventCopy,
      supports: { delayDelivery: false },
    };
  }

  return {
    classificationId: modal.classificationId,
    isEncrypted: modal.isEncrypted,
    isSigned: modal.isSigned,
    importance: modal.importance,
    requestReadReceipt: modal.requestReadReceipt,
    requestDeliveryReceipt: modal.requestDeliveryReceipt,
    deliverAt: modal.deliverAt,
    preventCopy: modal.preventCopy,
    setClassificationId: modal.setClassificationId,
    setIsEncrypted: modal.setIsEncrypted,
    setIsSigned: modal.setIsSigned,
    setImportance: modal.setImportance,
    setRequestReadReceipt: modal.setRequestReadReceipt,
    setRequestDeliveryReceipt: modal.setRequestDeliveryReceipt,
    setPreventCopy: modal.setPreventCopy,
    supports: { delayDelivery: true },
  };
}

// Tests for useComposerSignature: the three-state initialSignatureId contract
// (undefined = apply default / null = explicitly none), respect for a
// signature node already in the document (draft/pop-out restore), and
// replacement of a foreign signature after an account switch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { buildComposerExtensions } from '@/features/composer/editorExtensions';
import { useComposerSignature } from '@/features/composer/useComposerSignature';
import { getActiveSignatureId } from '@/features/composer/signatureCommands';
import { wireDefaultDbResults } from '@/test/mockInvoke';
import type { DbSignature } from '@/services/db/signatures';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

function sig(id: string, accountId: string, name = id): DbSignature {
  return {
    id,
    account_id: accountId,
    name,
    body_html: `<p>${name} body</p>`,
    is_default: 1,
    sort_order: 0,
    context: 'all',
  };
}

function seedDb(byAccount: Record<string, DbSignature[]>) {
  mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const accountId = args?.accountId as string;
    if (cmd === 'db_get_signatures_for_account') return byAccount[accountId] ?? [];
    if (cmd === 'db_get_default_signature') {
      return (byAccount[accountId] ?? []).find((s) => s.is_default === 1) ?? null;
    }
    return undefined;
  });
}

let editor: Editor | null = null;

function makeEditor(content = '<p>hi</p>'): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: buildComposerExtensions('test'),
    content,
  });
  return editor;
}

beforeEach(() => {
  wireDefaultDbResults(mockInvoke);
});

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('useComposerSignature', () => {
  it('applies the account default when nothing is requested (undefined)', async () => {
    seedDb({ a1: [sig('d1', 'a1')] });
    const ed = makeEditor();
    const { result } = renderHook(() => useComposerSignature(ed, 'a1', 'new'));

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(getActiveSignatureId(ed.state.doc)).toBe('d1');
    expect(ed.getHTML()).toContain('d1 body');
  });

  it('never re-adds the default when the user explicitly chose no signature (null)', async () => {
    seedDb({ a1: [sig('d1', 'a1')] });
    const ed = makeEditor();
    const { result } = renderHook(() =>
      useComposerSignature(ed, 'a1', 'new', { initialSignatureId: null }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(getActiveSignatureId(ed.state.doc)).toBeNull();
  });

  it('keeps a signature node already in the document (restored draft / pop-out)', async () => {
    seedDb({ a1: [sig('keep', 'a1'), sig('d1', 'a1')] });
    const ed = makeEditor('<p>draft</p><signature id="keep"><p>restored</p></signature>');
    const { result } = renderHook(() => useComposerSignature(ed, 'a1', 'new'));

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(getActiveSignatureId(ed.state.doc)).toBe('keep');
    expect(ed.getHTML()).not.toContain('d1 body');
  });

  it('applies the requested signature when it exists in the list', async () => {
    seedDb({ a1: [sig('req', 'a1'), sig('d1', 'a1')] });
    const ed = makeEditor();
    const { result } = renderHook(() =>
      useComposerSignature(ed, 'a1', 'new', { initialSignatureId: 'req' }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(getActiveSignatureId(ed.state.doc)).toBe('req');
  });

  it('replaces a foreign signature after an account switch', async () => {
    seedDb({ a1: [sig('d1', 'a1')], a2: [sig('d2', 'a2')] });
    const ed = makeEditor();
    const { result, rerender } = renderHook(
      ({ accountId }) => useComposerSignature(ed, accountId, 'new'),
      { initialProps: { accountId: 'a1' } },
    );

    await waitFor(() => expect(getActiveSignatureId(ed.state.doc)).toBe('d1'));

    rerender({ accountId: 'a2' });

    await waitFor(() => expect(getActiveSignatureId(ed.state.doc)).toBe('d2'));
    expect(ed.getHTML()).not.toContain('d1 body');
    expect(result.current.activeId).toBe('d2');
  });

  it('swaps the block and reports it through activeId', async () => {
    seedDb({ a1: [sig('d1', 'a1'), sig('other', 'a1')] });
    const ed = makeEditor();
    const { result } = renderHook(() => useComposerSignature(ed, 'a1', 'new'));

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.activeId).toBe('d1');

    result.current.setSignature('other');
    expect(getActiveSignatureId(ed.state.doc)).toBe('other');
    expect(ed.getHTML().match(/<signature /g)).toHaveLength(1);

    result.current.setSignature(null);
    expect(getActiveSignatureId(ed.state.doc)).toBeNull();
  });
});

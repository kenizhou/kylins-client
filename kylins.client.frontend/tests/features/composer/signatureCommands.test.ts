// Tests for the ProseMirror-native signature block operations. These run a
// real TipTap editor (core Editor, jsdom) with the production extension set,
// so parse/serialize round-trips of the `<signature>` tag are covered too.

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildComposerExtensions } from '@/features/composer/editorExtensions';
import {
  findQuoteInsertPos,
  getActiveSignatureId,
  setSignatureInEditor,
} from '@/features/composer/signatureCommands';
import { stripSignature } from '@/features/composer/signaturePlacement';

let editor: Editor | null = null;

function createEditor(content = '<p></p>'): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: buildComposerExtensions('test'),
    content,
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const REPLY_BODY =
  '<p>my reply</p>' +
  '<div class="gmail_quote_attribution">On Jun 24, 2026, Kevin wrote:</div>' +
  '<blockquote class="gmail_quote"><p>original message</p></blockquote>';

describe('setSignatureInEditor', () => {
  it('appends the signature at the end when there is no quote', () => {
    const ed = createEditor('<p>Hello</p>');
    setSignatureInEditor(ed, { id: 's1', html: '<p>regards</p>' });
    // Note: a trailing empty paragraph follows the signature — ProseMirror
    // keeps a textblock after a trailing isolating block so the cursor has
    // somewhere to go (same behavior as tables at doc end).
    expect(ed.getHTML()).toBe('<p>Hello</p><signature id="s1"><p>regards</p></signature><p></p>');
  });

  it('places the signature above the reply quote (before the attribution line)', () => {
    const ed = createEditor(REPLY_BODY);
    setSignatureInEditor(ed, { id: 's1', html: '<p>sig</p>' });
    const html = ed.getHTML();
    expect(html.indexOf('<signature id="s1">')).toBeGreaterThan(-1);
    expect(html.indexOf('<signature id="s1">')).toBeLessThan(html.indexOf('wrote:'));
    expect(html.indexOf('<signature id="s1">')).toBeLessThan(html.indexOf('<blockquote'));
  });

  it('places the signature above a forward quote (top-level blockquote)', () => {
    const ed = createEditor(
      '<p>note</p><blockquote class="gmail_quote"><p>Forwarded Message</p></blockquote>',
    );
    setSignatureInEditor(ed, { id: 's1', html: '<p>sig</p>' });
    const html = ed.getHTML();
    expect(html.indexOf('<signature id="s1">')).toBeLessThan(html.indexOf('<blockquote'));
  });

  it('replaces an existing signature without duplicating it', () => {
    const ed = createEditor(REPLY_BODY);
    setSignatureInEditor(ed, { id: 's1', html: '<p>one</p>' });
    setSignatureInEditor(ed, { id: 's2', html: '<p>two</p>' });
    const html = ed.getHTML();
    expect(html).not.toContain('id="s1"');
    expect(html).not.toContain('<p>one</p>');
    expect(html).toContain('<signature id="s2"><p>two</p></signature>');
    // Still exactly one signature block, still above the quote.
    expect(html.match(/<signature /g)).toHaveLength(1);
    expect(html.indexOf('<signature id="s2">')).toBeLessThan(html.indexOf('<blockquote'));
  });

  it('removes the signature when passed null', () => {
    const ed = createEditor('<p>Hello</p>');
    setSignatureInEditor(ed, { id: 's1', html: '<p>sig</p>' });
    setSignatureInEditor(ed, null);
    // The cursor textblock that followed the signature remains.
    expect(ed.getHTML()).toBe('<p>Hello</p><p></p>');
    expect(getActiveSignatureId(ed.state.doc)).toBeNull();
  });

  it('is a no-op when removing a signature that does not exist', () => {
    const ed = createEditor('<p>Hello</p>');
    expect(setSignatureInEditor(ed, null)).toBe(false);
    expect(ed.getHTML()).toBe('<p>Hello</p>');
  });
});

describe('getActiveSignatureId', () => {
  it('reads the signature id from the document after a swap', () => {
    const ed = createEditor('<p>Hello</p>');
    expect(getActiveSignatureId(ed.state.doc)).toBeNull();
    setSignatureInEditor(ed, { id: 's1', html: '<p>sig</p>' });
    expect(getActiveSignatureId(ed.state.doc)).toBe('s1');
  });

  it('recovers the id from a restored draft (tag parsed back into a node)', () => {
    const ed = createEditor(
      '<p>draft text</p><signature id="draft-sig"><p>saved sig</p></signature>',
    );
    expect(getActiveSignatureId(ed.state.doc)).toBe('draft-sig');
    // …and the tag survives serialization, so drafts keep round-tripping.
    expect(ed.getHTML()).toContain('<signature id="draft-sig"><p>saved sig</p></signature>');
  });
});

describe('findQuoteInsertPos', () => {
  it('returns null when the body has no quote', () => {
    const ed = createEditor('<p>Hello</p>');
    expect(findQuoteInsertPos(ed.state.doc)).toBeNull();
  });

  it('inserts at the very start when the quote is the first block (offset 0 = position 0)', () => {
    const ed = createEditor('<blockquote class="gmail_quote"><p>orig</p></blockquote>');
    setSignatureInEditor(ed, { id: 's1', html: '<p>sig</p>' });
    const html = ed.getHTML();
    expect(html.startsWith('<signature id="s1">')).toBe(true);
    expect(html.indexOf('<signature')).toBeLessThan(html.indexOf('<blockquote'));
  });
});

describe('stripSignature integration', () => {
  it('unwraps the editor output for send', () => {
    const ed = createEditor(REPLY_BODY);
    setSignatureInEditor(ed, { id: 's1', html: '<p>sig</p>' });
    const sent = stripSignature(ed.getHTML());
    expect(sent).not.toContain('<signature');
    expect(sent).toContain('<p>sig</p>');
    expect(sent).toContain('<blockquote');
  });
});

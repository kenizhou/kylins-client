import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Editor } from '@tiptap/react';

let toolbarWidth = 1200;
vi.mock('../../../src/hooks/useElementWidth', () => ({
  useElementWidth: () => ({ ref: { current: null }, width: toolbarWidth }),
}));

import { EditorToolbar } from '../../../src/components/composer/EditorToolbar';

function fakeEditor() {
  const calls: string[] = [];
  const chainable = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === 'run') return () => undefined;
        return () => {
          calls.push(prop);
          return chainable;
        };
      },
    },
  );
  return {
    calls,
    editor: {
      can: () => ({ undo: () => true, redo: () => true }),
      isActive: () => false,
      getAttributes: () => ({}),
      chain: () => chainable,
    } as unknown as Editor,
  };
}

beforeEach(() => {
  toolbarWidth = 1200;
});

describe('EditorToolbar', () => {
  it('renders as an inset single-row card (side margins, no full-bleed, no wrap)', () => {
    const { container } = render(
      <EditorToolbar editor={fakeEditor().editor} onRequestLink={() => {}} />,
    );
    const bar = container.firstElementChild!;
    expect(bar.className).toContain('mx-1');
    expect(bar.className).toContain('rounded-xl');
    expect(bar.className).toContain('flex-nowrap');
    expect(bar.className).not.toContain('flex-wrap');
  });

  it('keeps core actions and collapses extras into a More menu below 640px', () => {
    toolbarWidth = 500;
    render(<EditorToolbar editor={fakeEditor().editor} onRequestLink={() => {}} />);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Heading 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bullet list' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Insert image' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    expect(screen.getByRole('menuitem', { name: 'Heading 1' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Bullet list' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Insert link' })).toBeInTheDocument();
  });

  it('hides the font/highlight cluster below 900px (into the More menu)', () => {
    toolbarWidth = 800;
    render(<EditorToolbar editor={fakeEditor().editor} onRequestLink={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Highlight' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more/i })).toBeInTheDocument();
  });

  it('overflow menu items run editor commands', () => {
    toolbarWidth = 500;
    const { calls, editor } = fakeEditor();
    render(<EditorToolbar editor={editor} onRequestLink={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bullet list' }));
    expect(calls).toContain('toggleBulletList');
  });
});

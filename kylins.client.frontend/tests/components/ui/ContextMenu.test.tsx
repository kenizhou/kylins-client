import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ContextMenu } from '../../../src/components/ui/ContextMenu';

describe('ContextMenu', () => {
  it('renders non-separator item labels', () => {
    const { getByText } = render(
      <ContextMenu
        x={0}
        y={0}
        items={[
          { label: 'Sync this folder', onSelect: () => {} },
          { separator: true },
          { label: 'Rename Folder', onSelect: () => {} },
        ]}
        onClose={() => {}}
      />,
    );
    expect(getByText('Sync this folder')).toBeInTheDocument();
    expect(getByText('Rename Folder')).toBeInTheDocument();
  });

  it('calls onSelect and onClose when an enabled item is clicked', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const { getByText } = render(
      <ContextMenu x={0} y={0} items={[{ label: 'Go', onSelect }]} onClose={onClose} />,
    );
    fireEvent.click(getByText('Go'));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not fire onSelect/onClose for a disabled item', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const { getByText } = render(
      <ContextMenu
        x={0}
        y={0}
        items={[{ label: 'Nope', onSelect, disabled: true }]}
        onClose={onClose}
      />,
    );
    fireEvent.click(getByText('Nope'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={[]} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on an outside click', () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={[]} onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

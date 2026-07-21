import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CloseConfirmDialog } from '../../../../src/components/composer/window/CloseConfirmDialog';

function renderDialog(over: Partial<Parameters<typeof CloseConfirmDialog>[0]> = {}) {
  const props = {
    isOpen: true,
    onSaveDraft: vi.fn(),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  render(<CloseConfirmDialog {...props} />);
  return props;
}

describe('CloseConfirmDialog', () => {
  it('asks to save the draft', () => {
    renderDialog();
    expect(screen.getByText('Save this draft?')).toBeInTheDocument();
  });

  it('Save Draft invokes onSaveDraft', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }));
    expect(props.onSaveDraft).toHaveBeenCalledTimes(1);
    expect(props.onDiscard).not.toHaveBeenCalled();
  });

  it("Don't Save invokes onDiscard", () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: "Don't Save" }));
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
    expect(props.onSaveDraft).not.toHaveBeenCalled();
  });

  it('Cancel invokes onCancel without saving or discarding', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onSaveDraft).not.toHaveBeenCalled();
    expect(props.onDiscard).not.toHaveBeenCalled();
  });
});

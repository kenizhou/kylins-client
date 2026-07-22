import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ComposerActionsRow } from '../../../../src/components/composer/window/ComposerActionsRow';

function renderRow(over: Partial<Parameters<typeof ComposerActionsRow>[0]> = {}) {
  const props = {
    canSend: true,
    sending: false,
    onSend: vi.fn(),
    onDiscard: vi.fn(),
    onSchedule: vi.fn(),
    onAttach: vi.fn(),
    onSave: vi.fn(),
    onPrint: vi.fn(),
    ...over,
  };
  render(<ComposerActionsRow {...props} />);
  return props;
}

describe('ComposerActionsRow', () => {
  it('disables Send when there are no recipients', () => {
    renderRow({ canSend: false });
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
  });

  it('invokes the primary callbacks', () => {
    const props = renderRow();
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    fireEvent.click(screen.getByRole('button', { name: /attach files/i }));
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onAttach).toHaveBeenCalledTimes(1);
  });

  it('opens delivery options from the Send caret', () => {
    const props = renderRow();
    fireEvent.click(screen.getByRole('button', { name: /delivery options/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /deliver time/i }));
    expect(props.onSchedule).toHaveBeenCalledTimes(1);
  });

  it('invokes onSave and onPrint from the overflow menu', () => {
    const props = renderRow();
    // The popover closes on select — reopen for each item.
    fireEvent.click(screen.getByRole('button', { name: /more message options/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /save draft/i }));
    fireEvent.click(screen.getByRole('button', { name: /more message options/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^print$/i }));
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onPrint).toHaveBeenCalledTimes(1);
  });

  it('invokes onDiscard from the overflow menu', () => {
    const props = renderRow();
    fireEvent.click(screen.getByRole('button', { name: /more message options/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /discard/i }));
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
  });

  it('toggles Encrypt and Sign via pressed-state icon buttons', () => {
    renderRow();
    const encrypt = screen.getByRole('button', { name: /^encrypt$/i });
    const sign = screen.getByRole('button', { name: /^sign$/i });
    expect(encrypt).toHaveAttribute('aria-pressed', 'false');
    expect(sign).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(encrypt);
    fireEvent.click(sign);
    expect(encrypt).toHaveAttribute('aria-pressed', 'true');
    expect(sign).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a sending state and blocks all actions while sending', () => {
    renderRow({ sending: true });
    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /delivery options/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /attach files/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /more message options/i })).toBeDisabled();
  });
});

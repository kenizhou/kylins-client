import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useWindowSize, type WindowBreakpoint } from '../../src/hooks/useWindowSize';

function TestComponent() {
  const { width, height, breakpoint } = useWindowSize();
  return (
    <div data-testid="size">
      <span data-testid="width">{width}</span>
      <span data-testid="height">{height}</span>
      <span data-testid="breakpoint">{breakpoint}</span>
    </div>
  );
}

describe('useWindowSize', () => {
  let resizeHandlers: Array<(event: Event) => void> = [];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resizeHandlers = [];
    vi.stubGlobal('window', {
      innerWidth: 1280,
      innerHeight: 720,
      addEventListener: vi.fn((_type: string, handler: EventListener) => {
        resizeHandlers.push(handler as (event: Event) => void);
      }),
      removeEventListener: vi.fn((_type: string, handler: EventListener) => {
        resizeHandlers = resizeHandlers.filter((h) => h !== handler);
      }),
      setTimeout: (cb: () => void, ms?: number) => setTimeout(cb, ms),
      clearTimeout: (id: number) => clearTimeout(id),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('initializes from window dimensions', () => {
    render(<TestComponent />);
    expect(screen.getByTestId('width').textContent).toBe('1280');
    expect(screen.getByTestId('height').textContent).toBe('720');
    expect(screen.getByTestId('breakpoint').textContent).toBe('default');
  });

  it.each<[number, WindowBreakpoint]>([
    [375, 'compact'],
    [800, 'medium'],
    [1280, 'default'],
    [1600, 'wide'],
  ])('reports breakpoint %s as %s', (width, expected) => {
    vi.stubGlobal('window', {
      innerWidth: width,
      innerHeight: 800,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout: (cb: () => void, ms?: number) => setTimeout(cb, ms),
      clearTimeout: (id: number) => clearTimeout(id),
    });
    render(<TestComponent />);
    expect(screen.getByTestId('breakpoint').textContent).toBe(expected);
  });

  it('updates on window resize after debounce', () => {
    render(<TestComponent />);
    expect(screen.getByTestId('width').textContent).toBe('1280');

    vi.stubGlobal('window', {
      innerWidth: 500,
      innerHeight: 720,
      addEventListener: vi.fn((_type: string, handler: EventListener) => {
        resizeHandlers.push(handler as (event: Event) => void);
      }),
      removeEventListener: vi.fn(),
      setTimeout: (cb: () => void, ms?: number) => setTimeout(cb, ms),
      clearTimeout: (id: number) => clearTimeout(id),
    });

    act(() => {
      resizeHandlers.forEach((handler) => handler(new Event('resize')));
    });

    // Value does not update immediately because of debounce.
    expect(screen.getByTestId('width').textContent).toBe('1280');

    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(screen.getByTestId('width').textContent).toBe('500');
    expect(screen.getByTestId('breakpoint').textContent).toBe('compact');
  });
});

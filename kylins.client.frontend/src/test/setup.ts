import '@testing-library/jest-dom/vitest';
import { beforeAll } from 'vitest';

// react-resizable-panels (and other layout-aware components) rely on
// ResizeObserver, which jsdom does not provide.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof globalThis.ResizeObserver;
});

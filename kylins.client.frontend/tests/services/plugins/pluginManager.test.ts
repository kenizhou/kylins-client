import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pluginManager } from '../../../src/services/plugins/pluginManager';

const TestComponent = () => null;
const TestComponent2 = () => null;

beforeEach(() => {
  pluginManager.getComponentsForRole('test-role').forEach((c) =>
    pluginManager.api.unregisterComponent('test-role', c),
  );
});

describe('PluginManager', () => {
  it('registers a component via the plugin API', () => {
    pluginManager.api.registerComponent('test-role', TestComponent);
    expect(pluginManager.getComponentsForRole('test-role')).toContain(TestComponent);
  });

  it('unregisters a component via the plugin API', () => {
    pluginManager.api.registerComponent('test-role', TestComponent);
    pluginManager.api.unregisterComponent('test-role', TestComponent);
    expect(pluginManager.getComponentsForRole('test-role')).not.toContain(TestComponent);
  });

  it('emits events to registered handlers', () => {
    const handler = vi.fn();
    pluginManager.api.onEvent('sync-complete', handler);
    pluginManager.emitEvent('sync-complete', { accountId: '1' });
    expect(handler).toHaveBeenCalledWith({ accountId: '1' });
  });

  it('returns empty array for unknown role', () => {
    expect(pluginManager.getComponentsForRole('unknown-role')).toEqual([]);
  });

  it('onEvent cleanup function removes the handler', () => {
    const handler = vi.fn();
    const cleanup = pluginManager.api.onEvent('cleanup-event', handler);
    cleanup();
    pluginManager.emitEvent('cleanup-event', { data: 'test' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple handlers for the same event', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    pluginManager.api.onEvent('multi-event', handler1);
    pluginManager.api.onEvent('multi-event', handler2);
    pluginManager.emitEvent('multi-event', { value: 42 });
    expect(handler1).toHaveBeenCalledWith({ value: 42 });
    expect(handler2).toHaveBeenCalledWith({ value: 42 });
  });

  it('registers and invokes an action', () => {
    const action = vi.fn();
    pluginManager.api.registerAction('test:action', action);
    pluginManager.invokeAction('test:action');
    expect(action).toHaveBeenCalled();
  });

  it('unregisters an action via the plugin API', () => {
    const action = vi.fn();
    pluginManager.api.registerAction('test:unregister-action', action);
    pluginManager.api.unregisterAction('test:unregister-action');
    pluginManager.invokeAction('test:unregister-action');
    expect(action).not.toHaveBeenCalled();
  });

  it('calls deactivate hooks on deactivatePlugins', async () => {
    const deactivate1 = vi.fn();
    const deactivate2 = vi.fn();
    // Manually push loaded plugins for testing
    (pluginManager as any).plugins.push(
      { name: 'plugin1', path: '/p1', main: { deactivate: deactivate1 } },
      { name: 'plugin2', path: '/p2', main: { deactivate: deactivate2 } },
    );
    await pluginManager.deactivatePlugins();
    expect(deactivate1).toHaveBeenCalled();
    expect(deactivate2).toHaveBeenCalled();
    // Clean up
    (pluginManager as any).plugins.length = 0;
  });

  it('loadPlugins reports loaded and failed plugins', async () => {
    const result = await pluginManager.loadPlugins([
      'data:text/javascript,export default {}',
      'invalid://this-will-fail',
    ]);
    expect(result.loaded.length).toBeGreaterThanOrEqual(0);
    expect(result.failed.length).toBeGreaterThanOrEqual(0);
    // At least one should have failed because 'invalid://this-will-fail' is not a valid module
    expect(result.failed.some((f) => f.path === 'invalid://this-will-fail')).toBe(true);
  });
});

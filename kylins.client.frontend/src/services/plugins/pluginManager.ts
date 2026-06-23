import type { PluginAPI, LoadedPlugin, InjectedComponentType } from './pluginAPI';

export interface LoadPluginsResult {
  loaded: string[];
  failed: { path: string; error: unknown }[];
}

export class PluginManager {
  private plugins: LoadedPlugin[] = [];
  private components = new Map<string, Set<InjectedComponentType>>();
  private eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  private actions = new Map<string, () => void>();

  get api(): PluginAPI {
    return {
      registerComponent: (role, component) => {
        if (!this.components.has(role)) this.components.set(role, new Set());
        this.components.get(role)!.add(component);
        this.emitEvent('__registry_changed__', { role });
      },
      unregisterComponent: (role, component) => {
        this.components.get(role)?.delete(component);
        this.emitEvent('__registry_changed__', { role });
      },
      onEvent: (event, handler) => {
        if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
        this.eventHandlers.get(event)!.add(handler);
        return () => this.eventHandlers.get(event)?.delete(handler);
      },
      registerAction: (id, handler) => {
        this.actions.set(id, handler);
      },
      unregisterAction: (id) => {
        this.actions.delete(id);
      },
    };
  }

  async loadPlugins(pluginPaths: string[]): Promise<LoadPluginsResult> {
    const result: LoadPluginsResult = { loaded: [], failed: [] };
    for (const path of pluginPaths) {
      try {
        const mod = await import(/* @vite-ignore */ path);
        this.plugins.push({ name: path, path, main: mod });
        result.loaded.push(path);
      } catch (err) {
        console.error(`Failed to load plugin ${path}:`, err);
        result.failed.push({ path, error: err });
      }
    }
    return result;
  }

  async activatePlugins(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.main?.activate) {
        await plugin.main.activate(this.api);
      }
    }
  }

  async deactivatePlugins(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.main?.deactivate) {
        await plugin.main.deactivate();
      }
    }
  }

  getComponentsForRole(role: string): InjectedComponentType[] {
    return Array.from(this.components.get(role) ?? []);
  }

  invokeAction(id: string): void {
    const action = this.actions.get(id);
    if (action) {
      action();
    }
  }

  emitEvent(event: string, payload: unknown): void {
    for (const handler of this.eventHandlers.get(event) ?? []) {
      handler(payload);
    }
  }
}

export const pluginManager = new PluginManager();

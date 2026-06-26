import { invoke } from '@tauri-apps/api/core';
import { getSetting, setSetting } from '../settings';
import { SETTING_KEYS } from '../settingsKeys';
import type { PluginAPI, LoadedPlugin, InjectedComponentType } from './pluginAPI';
import type { ComposerExtension, MessageViewExtension } from './extensions';

export interface LoadPluginsResult {
  loaded: string[];
  failed: { path: string; error: unknown }[];
}

export class PluginManager {
  private plugins: LoadedPlugin[] = [];
  private components = new Map<string, Set<InjectedComponentType>>();
  private eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  private actions = new Map<string, () => void>();
  private messageViewExtensions: { ext: MessageViewExtension; priority: number }[] = [];
  private composerExtensions: { ext: ComposerExtension; priority: number }[] = [];

  async installPlugin(path: string): Promise<void> {
    const result = await this.loadPlugins([path]);
    if (result.failed.length > 0) {
      throw new Error(`Failed to load plugin at ${path}: ${result.failed[0]?.error}`);
    }
    await this.activatePlugins();
    await this.persistInstalledPaths();
  }

  async createPlugin(directory: string, name: string): Promise<void> {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const pluginDir = `${directory}/${safeName}`;
    const mainTs = `${pluginDir}/main.ts`;
    const pkgJson = `${pluginDir}/package.json`;

    const mainTemplate = `import type { PluginAPI } from '@kylins/plugin-api';

export function activate(api: PluginAPI) {
  console.log('[${safeName}] activated');
  // Example: register a component for the reading-pane footer
  // api.registerComponent('reading-pane:footer', () => null);
}

export function deactivate() {
  console.log('[${safeName}] deactivated');
}
`;
    const pkgTemplate = JSON.stringify(
      {
        name: safeName,
        version: '0.1.0',
        kylins: { plugin: true },
        main: './main.ts',
      },
      null,
      2,
    );

    await invoke('write_text_file', { path: mainTs, data: mainTemplate });
    await invoke('write_text_file', { path: pkgJson, data: pkgTemplate });
  }

  async loadInstalledPlugins(): Promise<void> {
    const raw = await getSetting(SETTING_KEYS.installedPluginPaths);
    const paths = raw ? (JSON.parse(raw) as string[]) : [];
    if (paths.length === 0) return;
    const result = await this.loadPlugins(paths);
    if (result.failed.length > 0) {
      console.error('Some installed plugins failed to load:', result.failed);
    }
    await this.activatePlugins();
  }

  private async persistInstalledPaths(): Promise<void> {
    const paths = this.plugins.map((p) => p.path);
    await setSetting(SETTING_KEYS.installedPluginPaths, JSON.stringify(paths));
  }

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
      registerMessageViewExtension: (ext, priority = 0) => {
        this.messageViewExtensions.push({ ext, priority });
        this.messageViewExtensions.sort((a, b) => b.priority - a.priority);
        this.emitEvent('__registry_changed__', { type: 'messageViewExtension' });
      },
      registerComposerExtension: (ext, priority = 0) => {
        this.composerExtensions.push({ ext, priority });
        this.composerExtensions.sort((a, b) => b.priority - a.priority);
        this.emitEvent('__registry_changed__', { type: 'composerExtension' });
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

  getMessageViewExtensions(): MessageViewExtension[] {
    return this.messageViewExtensions.map((e) => e.ext);
  }

  getComposerExtensions(): ComposerExtension[] {
    return this.composerExtensions.map((e) => e.ext);
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

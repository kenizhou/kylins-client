import type { ComponentType } from 'react';

export interface PluginAPI {
  registerComponent(role: string, component: ComponentType<any>): void;
  unregisterComponent(role: string, component: ComponentType<any>): void;
  onEvent(event: string, handler: (payload: unknown) => void): () => void;
  registerAction(id: string, handler: () => void): void;
  unregisterAction(id: string): void;
}

export interface LoadedPlugin {
  name: string;
  path: string;
  main?: {
    activate?: (api: PluginAPI) => void | Promise<void>;
    deactivate?: () => void | Promise<void>;
  };
}

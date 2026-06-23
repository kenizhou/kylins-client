import type { ComponentType } from 'react';

/**
 * A component registered into a plugin slot. Props are an arbitrary string-keyed
 * record so any slot can forward extra props to the injected component.
 */
export type InjectedComponentType = ComponentType<Record<string, unknown>>;

export interface PluginAPI {
  registerComponent(role: string, component: InjectedComponentType): void;
  unregisterComponent(role: string, component: InjectedComponentType): void;
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

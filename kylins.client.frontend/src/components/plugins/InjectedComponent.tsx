import React, { useEffect, useState } from 'react';
import { pluginManager } from '../../services/plugins/pluginManager';

interface InjectedComponentProps {
  role: string;
  fallback?: React.ComponentType | null;
  [key: string]: unknown;
}

export function InjectedComponent({ role, fallback: Fallback, ...props }: InjectedComponentProps) {
  const [components, setComponents] = useState(() => pluginManager.getComponentsForRole(role));

  useEffect(() => {
    return pluginManager.api.onEvent('__registry_changed__', () => {
      setComponents(pluginManager.getComponentsForRole(role));
    });
  }, [role]);

  if (components.length === 0) {
    return Fallback ? <Fallback /> : null;
  }

  const Component = components[0] as React.ComponentType<any>;
  return <Component {...props} />;
}

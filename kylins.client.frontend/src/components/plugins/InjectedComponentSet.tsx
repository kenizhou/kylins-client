import { useEffect, useState } from 'react';
import { pluginManager } from '../../services/plugins/pluginManager';

interface InjectedComponentSetProps {
  role: string;
  containersRequired?: boolean;
  [key: string]: unknown;
}

export function InjectedComponentSet({
  role,
  containersRequired = true,
  ...props
}: InjectedComponentSetProps) {
  const [components, setComponents] = useState(() => pluginManager.getComponentsForRole(role));

  useEffect(() => {
    return pluginManager.api.onEvent('__registry_changed__', () => {
      setComponents(pluginManager.getComponentsForRole(role));
    });
  }, [role]);

  return (
    <>
      {components.map((Component, index) =>
        containersRequired ? (
          <div
            key={Component.displayName || Component.name || String(index)}
            className="inline-flex"
          >
            <Component {...props} />
          </div>
        ) : (
          <Component key={Component.displayName || Component.name || String(index)} {...props} />
        ),
      )}
    </>
  );
}

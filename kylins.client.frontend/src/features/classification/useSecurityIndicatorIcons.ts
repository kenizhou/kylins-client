import { useEffect } from 'react';
import { useSecurityIndicatorIconStore } from './securityIndicatorIconStore';

export function useSecurityIndicatorIcons() {
  const store = useSecurityIndicatorIconStore();

  useEffect(() => {
    void store.load();
  }, [store]);

  return store;
}

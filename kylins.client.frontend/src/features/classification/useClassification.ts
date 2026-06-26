import { useEffect } from 'react';
import { useClassificationStore } from './classificationStore';

export function useClassification() {
  const store = useClassificationStore();

  useEffect(() => {
    void store.load();
  }, [store]);

  return store;
}

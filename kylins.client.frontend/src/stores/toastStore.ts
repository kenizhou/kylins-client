// Minimal global toast store. Auto-dismisses each toast after a few seconds.
// Rendered once via <Toaster /> (mounted in App.tsx). There was no central
// toast mechanism before this; the composer had its own one-off toast.

import { create } from 'zustand';

export type ToastType = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastState {
  toasts: Toast[];
  push: (message: string, type?: ToastType) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;
const DISMISS_MS = 3500;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, type = 'info') => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => get().dismiss(id), DISMISS_MS);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

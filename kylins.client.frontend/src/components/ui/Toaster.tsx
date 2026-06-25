// Renders the global toast stack (mounted once in App.tsx). Styled to match
// the composer's UndoSendToast.

import { useToastStore } from '../../stores/toastStore';

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[80] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={`composer-toast pointer-events-auto rounded-lg px-4 py-2.5 text-sm shadow-lg transition-colors ${
            t.type === 'error'
              ? 'bg-red-600 text-white'
              : t.type === 'success'
                ? 'bg-[var(--green)] text-white'
                : 'bg-[var(--foreground)] text-[var(--background)]'
          }`}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}

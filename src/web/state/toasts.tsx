import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconCheck, IconX, IconAlert } from '../components/icons.js';

export type ToastKind = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastsCtx {
  toast: (message: string, kind?: ToastKind) => void;
}

const Ctx = createContext<ToastsCtx>({ toast: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-4), { id, kind, message }]);
    setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
    }, kind === 'error' ? 6500 : 4200);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-[26rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => setToasts((l) => l.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const icon =
    toast.kind === 'success' ? (
      <IconCheck className="h-4 w-4 text-ok" />
    ) : toast.kind === 'error' ? (
      <IconAlert className="h-4 w-4 text-danger" />
    ) : null;

  return (
    <div
      role="status"
      className={`pointer-events-auto flex animate-rise items-start gap-2.5 rounded-xl border px-3.5 py-3 shadow-pop ${
        toast.kind === 'error' ? 'border-danger/40 bg-surface-1' : 'border-border bg-surface-1'
      }`}
    >
      <span className="mt-0.5 shrink-0">{icon ?? <span className="block h-4 w-1 rounded-full bg-accent" />}</span>
      <p className="flex-1 text-[13px] leading-snug text-ink">{toast.message}</p>
      <button
        onClick={onDismiss}
        className="shrink-0 rounded-md p-0.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
        aria-label="Dismiss"
      >
        <IconX className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function useToast(): ToastsCtx {
  return useContext(Ctx);
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";

export type ToastTone = "success" | "info" | "error";

export type ToastNotice = {
  id: number;
  key: string;
  title: string;
  message: string;
  tone: ToastTone;
};

type ToastInput = Omit<ToastNotice, "id">;

export function useToastQueue(autoDismissMs = 4200) {
  const [toasts, setToasts] = useState<ToastNotice[]>([]);
  const nextIdRef = useRef(0);
  const timersRef = useRef(new Map<number, number>());

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timersRef.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((input: ToastInput) => {
    const id = ++nextIdRef.current;
    const toast: ToastNotice = { ...input, id };
    setToasts((current) => [...current.filter((item) => item.key !== input.key), toast].slice(-3));
    const timer = window.setTimeout(() => dismissToast(id), autoDismissMs);
    timersRef.current.set(id, timer);
  }, [autoDismissMs, dismissToast]);

  useEffect(() => () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current.clear();
  }, []);

  return { toasts, pushToast, dismissToast };
}

function ToastIcon({ tone }: { tone: ToastTone }) {
  if (tone === "success") return <CheckCircle2 size={17} aria-hidden="true" />;
  if (tone === "error") return <TriangleAlert size={17} aria-hidden="true" />;
  return <Info size={17} aria-hidden="true" />;
}

export function ToastViewport({
  toasts,
  onDismiss
}: {
  toasts: ToastNotice[];
  onDismiss(id: number): void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="sc-toast-viewport" aria-label="Notifications">
      {toasts.map((toast) => (
        <section
          className={`sc-toast sc-toast--${toast.tone}`}
          key={toast.id}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="sc-toast__icon"><ToastIcon tone={toast.tone} /></span>
          <span className="sc-toast__content">
            <strong>{toast.title}</strong>
            <span>{toast.message}</span>
          </span>
          <button
            className="sc-toast__dismiss"
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label={`Dismiss ${toast.title} notification`}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </section>
      ))}
    </div>
  );
}

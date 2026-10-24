import { useEffect } from 'react';
import { CheckCircle2, Info, TriangleAlert, XCircle, X } from 'lucide-react';
import { cn } from '@/lib/cn';

export type ToastVariant = 'success' | 'info' | 'warning' | 'danger';

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  /** 自动关闭毫秒数；为 0 表示不自动关闭。 */
  durationMs?: number;
}

interface ToastViewportProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

const ICON_BY_VARIANT: Record<ToastVariant, typeof Info> = {
  success: CheckCircle2,
  info: Info,
  warning: TriangleAlert,
  danger: XCircle,
};

const ACCENT_BY_VARIANT: Record<ToastVariant, string> = {
  success: 'border-success/30 bg-success/10 text-success dark:text-success',
  info: 'border-primary/30 bg-accent-soft text-foreground',
  warning: 'border-warning/30 bg-warning/10 text-foreground',
  danger: 'border-danger/30 bg-danger/10 text-foreground',
};

/**
 * 应用反馈条；当前阶段由调用方维护列表，未接入全局 store。
 * 用于保存成功、导入完成等短暂提示，区别于 Dialog 的阻塞确认。
 */
export function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </div>
  );
}

interface ToastCardProps {
  toast: ToastItem;
  onDismiss: () => void;
}

function ToastCard({ toast, onDismiss }: ToastCardProps) {
  const Icon = ICON_BY_VARIANT[toast.variant];
  const duration = toast.durationMs ?? 3200;

  useEffect(() => {
    if (duration <= 0) return;
    const handle = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(handle);
  }, [duration, onDismiss]);

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border px-3.5 py-2.5 shadow-lg backdrop-blur',
        ACCENT_BY_VARIANT[toast.variant],
      )}
    >
      <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-5 text-foreground">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{toast.description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭提示"
        className="ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

import { type ReactNode } from 'react';
import { Dialog } from './Dialog';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const TONE_CLASSES: Record<NonNullable<ConfirmDialogProps['tone']>, string> = {
  danger: 'bg-rose-600 hover:bg-rose-700 focus:ring-rose-500',
  primary: 'bg-slate-900 hover:bg-slate-800 focus:ring-slate-500',
};

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  tone = 'primary',
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onCancel} title={title} size="sm">
      <div className="px-5 py-4 text-sm text-slate-600">{message}</div>
      <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={loading}
          className={`rounded-md px-3 py-1.5 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 ${TONE_CLASSES[tone]}`}
        >
          {loading ? '…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

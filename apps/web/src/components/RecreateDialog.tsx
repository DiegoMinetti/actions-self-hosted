import { type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Dialog } from './Dialog';
import { api, ApiError } from '../lib/api';
import { useToast } from './Toast';
import type { Runner } from '@actions-self-hosted/shared';

interface RecreateDialogProps {
  open: boolean;
  runner: Runner;
  onClose: () => void;
  onRecreated: (runner: Runner) => void;
}

/**
 * Dialog para recreate: el container se recrea automáticamente. La app
 * genera el registration token con el PAT asociado al runner (no se
 * pide token al user).
 */
export function RecreateDialog({
  open,
  runner,
  onClose,
  onRecreated,
}: RecreateDialogProps): ReactNode {
  const { showToast } = useToast();

  const recreateMutation = useMutation({
    mutationFn: () => api.recreateRunner(runner.id, {}),
    onSuccess: (updated) => {
      showToast(`Container de "${updated.name}" recreado`, 'success');
      onRecreated(updated);
      onClose();
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : String(err);
      showToast(`Error: ${message}`, 'error');
    },
  });

  return (
    <Dialog open={open} onClose={onClose} title={`Recrear container — ${runner.name}`} size="md">
      <div className="space-y-3 px-5 py-4 text-sm">
        <p className="text-slate-600">
          Vamos a <strong>borrar y recrear el container</strong>. El{' '}
          <strong>volumen se mantiene</strong>, así que si ya tiene credenciales se reusan; si no,
          el entrypoint del wrapper las genera con un token fresco de GitHub.
        </p>
        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
          <strong>El registration token se genera automáticamente</strong> con el PAT asociado a
          este runner. No necesitás pegar nada.
        </div>
        {!runner.githubPatId && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            <strong>⚠️ Este runner no tiene un PAT asociado.</strong> Andá a Settings → GitHub PATs
            y agregá uno, o asignale un PAT desde el panel de detalle del runner.
          </div>
        )}
        {recreateMutation.error && (
          <p className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {recreateMutation.error instanceof ApiError
              ? recreateMutation.error.message
              : String(recreateMutation.error)}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          disabled={recreateMutation.isPending}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => recreateMutation.mutate()}
          disabled={recreateMutation.isPending}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-1 disabled:opacity-50"
        >
          {recreateMutation.isPending ? 'Recreando…' : 'Recrear container'}
        </button>
      </div>
    </Dialog>
  );
}

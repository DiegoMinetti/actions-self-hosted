import { type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Dialog } from './Dialog';
import { api, ApiError } from '../lib/api';
import { useToast } from './Toast';
import type { Runner } from '@actions-self-hosted/shared';

interface RenewDialogProps {
  open: boolean;
  runner: Runner;
  onClose: () => void;
  onRenewed: (runner: Runner) => void;
}

/**
 * Dialog para renew: borra credenciales stale del volumen y re-registra
 * con un token fresco. La app genera el token con el PAT asociado.
 */
export function RenewDialog({ open, runner, onClose, onRenewed }: RenewDialogProps): ReactNode {
  const { showToast } = useToast();

  const renewMutation = useMutation({
    mutationFn: () => api.renewRunner(runner.id, {}),
    onSuccess: (updated) => {
      showToast(`Credenciales de "${updated.name}" renovadas`, 'success');
      onRenewed(updated);
      onClose();
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : String(err);
      showToast(`Error: ${message}`, 'error');
    },
  });

  return (
    <Dialog open={open} onClose={onClose} title={`Renovar credenciales — ${runner.name}`} size="md">
      <div className="space-y-3 px-5 py-4 text-sm">
        <p className="text-slate-600">
          Vamos a detener el container, borrar <code>.runner</code> y <code>.credentials</code> del
          volumen, y recrear el container con un nuevo registration token. Los datos del volumen se
          mantienen (caché de jobs, etc).
        </p>
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <strong>Cuándo hacerlo:</strong> si ves el error{' '}
          <code>Failed to create a session. The runner registration has been deleted</code> en los
          logs. Pasó porque el runner quedó offline mucho tiempo y GitHub borró la registration.
        </div>
        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
          <strong>El token se genera automáticamente</strong> con el PAT asociado a este runner.
        </div>
        {!runner.githubPatId && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            <strong>⚠️ Este runner no tiene un PAT asociado.</strong> Andá a Settings → GitHub PATs
            y agregá uno, o asignale un PAT desde el panel de detalle del runner.
          </div>
        )}
        {renewMutation.error && (
          <p className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {renewMutation.error instanceof ApiError
              ? renewMutation.error.message
              : String(renewMutation.error)}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          disabled={renewMutation.isPending}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => renewMutation.mutate()}
          disabled={renewMutation.isPending}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1 disabled:opacity-50"
        >
          {renewMutation.isPending ? 'Renovando…' : 'Renovar credenciales'}
        </button>
      </div>
    </Dialog>
  );
}

import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog } from './Dialog';
import { api, ApiError } from '../lib/api';
import { useToast } from './Toast';
import type { CreateRunnerRequest, Runner, RunnerScope } from '@actions-self-hosted/shared';

interface CreateRunnerDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (runner: Runner) => void;
}

const DEFAULT_LABELS = 'self-hosted,linux,x64';

export function CreateRunnerDialog({
  open,
  onClose,
  onCreated,
}: CreateRunnerDialogProps): ReactNode {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [name, setName] = useState('');
  const [scope, setScope] = useState<RunnerScope>('repo');
  const [target, setTarget] = useState('');
  const [labels, setLabels] = useState(DEFAULT_LABELS);
  const [runnerGroup, setRunnerGroup] = useState('Default');
  const [githubPatId, setGithubPatId] = useState<string>('');
  const [registrationToken, setRegistrationToken] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const patsQuery = useQuery({
    queryKey: ['pats'],
    queryFn: () => api.listPats(),
  });

  // Auto-selecciona el PAT que matchee el target.
  // Si el target es "owner/repo" y hay un PAT con ownerLogin == owner, lo elige.
  // Si el target es "org" y hay un PAT con orgLogin == org, lo elige.
  function autoSelectPat(targetValue: string, currentScope: RunnerScope): string {
    if (!patsQuery.data) return '';
    const pats = patsQuery.data.pats;
    if (currentScope === 'repo') {
      const owner = targetValue.split('/')[0];
      if (!owner) return '';
      return pats.find((p) => p.isPersonal && p.ownerLogin === owner)?.id ?? '';
    } else {
      return pats.find((p) => !p.isPersonal && p.orgLogin === targetValue)?.id ?? '';
    }
  }

  const createMutation = useMutation({
    mutationFn: (data: CreateRunnerRequest) => api.createRunner(data),
    onSuccess: (runner) => {
      showToast(`Runner "${runner.name}" creado`, 'success');
      queryClient.invalidateQueries({ queryKey: ['runners'] });
      onCreated(runner);
      handleClose();
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : String(err);
      showToast(`Error: ${message}`, 'error');
    },
  });

  function reset() {
    setName('');
    setScope('repo');
    setTarget('');
    setLabels(DEFAULT_LABELS);
    setRunnerGroup('Default');
    setRegistrationToken('');
    setFieldErrors({});
  }

  function handleClose() {
    if (createMutation.isPending) return;
    reset();
    onClose();
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(name)) {
      errs.name = 'kebab-case, 3-32 chars, solo [a-z0-9-]';
    }
    if (scope === 'repo') {
      if (!/^[^/\s]+\/[^/\s]+$/.test(target)) {
        errs.target = 'Formato esperado: owner/repo';
      }
    } else if (!/^[^/\s]+$/.test(target)) {
      errs.target = 'Formato esperado: org-name';
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    createMutation.mutate({
      name,
      scope,
      target,
      labels: labels
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      runnerGroup: runnerGroup.trim() || undefined,
      githubPatId: githubPatId || undefined,
      registrationToken: registrationToken.trim() || undefined,
    });
  }

  return (
    <Dialog open={open} onClose={handleClose} title="Nuevo runner" size="md">
      <form onSubmit={handleSubmit}>
        <div className="space-y-4 px-5 py-4">
          <Field
            label="Nombre"
            error={fieldErrors.name}
            hint="kebab-case, único. Ej: prod-misnumeros-1"
          >
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass(fieldErrors.name)}
              placeholder="prod-misnumeros-1"
              autoFocus
            />
          </Field>

          <Field label="Scope">
            <div className="flex gap-2">
              <ScopeButton
                active={scope === 'repo'}
                onClick={() => {
                  setScope('repo');
                  setGithubPatId(autoSelectPat(target, 'repo'));
                }}
              >
                Repo
              </ScopeButton>
              <ScopeButton
                active={scope === 'org'}
                onClick={() => {
                  setScope('org');
                  setGithubPatId(autoSelectPat(target, 'org'));
                }}
              >
                Organización
              </ScopeButton>
            </div>
          </Field>

          <Field
            label={scope === 'repo' ? 'Target (owner/repo)' : 'Target (org)'}
            error={fieldErrors.target}
            hint={scope === 'repo' ? 'Ej: diegominetti/mi-repo' : 'Ej: mi-organizacion'}
          >
            <input
              type="text"
              value={target}
              onChange={(e) => {
                const newTarget = e.target.value;
                setTarget(newTarget);
                setGithubPatId(autoSelectPat(newTarget, scope));
              }}
              className={inputClass(fieldErrors.target)}
              placeholder={scope === 'repo' ? 'owner/repo' : 'org-name'}
            />
          </Field>

          <Field label="Labels" hint="Comma-separated. Default: self-hosted,linux,x64">
            <input
              type="text"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              className={inputClass()}
              placeholder="self-hosted,linux,x64"
            />
          </Field>

          <Field
            label="Imagen"
            hint="Fija: actions-runner:2.336.0 (wrapper local con auto-configure)"
          >
            <input
              type="text"
              value="actions-runner:2.336.0"
              disabled
              className="w-full cursor-not-allowed rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-500"
            />
          </Field>

          <Field label="Runner group">
            <input
              type="text"
              value={runnerGroup}
              onChange={(e) => setRunnerGroup(e.target.value)}
              className={inputClass()}
            />
          </Field>

          <Field
            label="GitHub PAT"
            hint={
              patsQuery.data && patsQuery.data.pats.length > 0
                ? 'Auto-seleccionado por match con el target. Si no hay match, agregá uno en Settings.'
                : 'No hay PATs configurados. Agregá uno en Settings → GitHub PATs, o pegá un token fresco abajo.'
            }
          >
            {patsQuery.data && patsQuery.data.pats.length > 0 ? (
              <select
                value={githubPatId}
                onChange={(e) => setGithubPatId(e.target.value)}
                className={inputClass()}
              >
                <option value="">(auto: matchear por target)</option>
                {patsQuery.data.pats.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.isPersonal ? p.ownerLogin : p.orgLogin}) ***{p.tokenLast4}
                  </option>
                ))}
              </select>
            ) : (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                No hay PATs configurados.{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onClose();
                    // El user va a tener que ir a Settings manualmente por ahora.
                  }}
                  className="underline"
                >
                  Ir a Settings
                </a>
              </p>
            )}
          </Field>

          <Field
            label="Registration token (opcional)"
            hint="Si lo dejás vacío, la app lo genera automáticamente con el PAT seleccionado arriba. Útil solo si querés overridear (ej: tests)."
          >
            <input
              type="password"
              value={registrationToken}
              onChange={(e) => setRegistrationToken(e.target.value)}
              className={inputClass()}
              placeholder="(auto-generado)"
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={handleClose}
            disabled={createMutation.isPending}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-1 disabled:opacity-50"
          >
            {createMutation.isPending ? 'Creando…' : 'Crear runner'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function inputClass(error?: string): string {
  return `w-full rounded-md border px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 ${
    error
      ? 'border-rose-300 bg-rose-50 focus:border-rose-500 focus:ring-rose-200'
      : 'border-slate-300 bg-white focus:border-slate-500 focus:ring-slate-200'
  }`;
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700">{label}</label>
      <div className="mt-1">{children}</div>
      {error ? (
        <p className="mt-1 text-xs text-rose-600">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

function ScopeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? 'border-slate-900 bg-slate-900 text-white'
          : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  );
}

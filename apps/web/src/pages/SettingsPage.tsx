import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { GitHubPat } from '@actions-self-hosted/shared';

interface SettingsPageProps {
  onBack: () => void;
}

/**
 * Settings → GitHub PATs. CRUD de Personal Access Tokens.
 * Soporta N PATs (multi-cuenta, multi-org).
 */
export function SettingsPage({ onBack }: SettingsPageProps): ReactNode {
  const { showToast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GitHubPat | null>(null);

  const queryClient = useQueryClient();
  const patsQuery = useQuery({
    queryKey: ['pats'],
    queryFn: () => api.listPats(),
    refetchInterval: 5_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deletePat(id),
    onSuccess: () => {
      showToast('PAT borrado', 'success');
      queryClient.invalidateQueries({ queryKey: ['pats'] });
      setDeleteTarget(null);
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : String(err);
      showToast(`Error: ${message}`, 'error');
    },
  });

  return (
    <div>
      <button onClick={onBack} className="mb-4 text-sm text-slate-600 hover:text-slate-900">
        ← Volver al dashboard
      </button>

      <header className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
          <p className="mt-1 text-sm text-slate-500">
            Configuración global de la app. Acá gestionás los GitHub PATs que se usan para registrar
            runners y consultar el estado en GitHub.
          </p>
        </div>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">GitHub PATs</h2>
            <p className="mt-1 text-xs text-slate-500">
              Los PATs se almacenan encriptados (AES-256-GCM) en la DB local. El token plano nunca
              se expone al front: solo se usa server-side al generar registration tokens y al
              consultar el estado de los runners.
            </p>
          </div>
          <button
            onClick={() => setCreateOpen(true)}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Agregar PAT
          </button>
        </div>

        {patsQuery.isLoading && <p className="text-sm text-slate-500">Cargando…</p>}
        {patsQuery.isError && (
          <p className="text-sm text-rose-600">Error: {String(patsQuery.error)}</p>
        )}

        {patsQuery.data && patsQuery.data.pats.length === 0 && (
          <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
            <p className="text-sm text-slate-600">
              No hay PATs configurados. Agregá uno para poder crear runners desde el panel sin tener
              que generar registration tokens a mano.
            </p>
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-xs text-slate-500 underline hover:text-slate-700"
            >
              Generar PAT en GitHub →
            </a>
          </div>
        )}

        {patsQuery.data && patsQuery.data.pats.length > 0 && (
          <ul className="divide-y divide-slate-200">
            {patsQuery.data.pats.map((p) => (
              <PatRow
                key={p.id}
                pat={p}
                onTest={() => handleTest(p)}
                onDelete={() => setDeleteTarget(p)}
              />
            ))}
          </ul>
        )}
      </section>

      {createOpen && (
        <CreatePatDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['pats'] });
            setCreateOpen(false);
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title={`Borrar PAT "${deleteTarget?.name}"?`}
        message={
          <>
            Esto va a <strong>borrar el PAT de la DB</strong>. Los runners que lo usaban van a
            quedar sin PAT y vas a tener que asignarles otro (o este mismo, si lo regenerás en
            GitHub).
          </>
        }
        confirmLabel="Sí, borrar"
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );

  async function handleTest(p: GitHubPat) {
    try {
      const res = await api.testPat(p.id);
      showToast(`PAT OK: ${res.login} (scopes: ${res.scopes.join(', ') || 'none'})`, 'success');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      showToast(`PAT inválido: ${message}`, 'error');
    }
    queryClient.invalidateQueries({ queryKey: ['pats'] });
  }
}

function PatRow({
  pat,
  onTest,
  onDelete,
}: {
  pat: GitHubPat;
  onTest: () => void;
  onDelete: () => void;
}): ReactNode {
  const statusBadge =
    pat.lastTestOk === true
      ? { text: '✓ OK', className: 'bg-emerald-100 text-emerald-700' }
      : pat.lastTestOk === false
        ? { text: '✗ falla', className: 'bg-rose-100 text-rose-700' }
        : { text: 'no testeado', className: 'bg-slate-100 text-slate-600' };

  return (
    <li className="flex items-center gap-4 py-3">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-900">{pat.name}</span>
          <span
            className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${statusBadge.className}`}
          >
            {statusBadge.text}
          </span>
          {pat.isPersonal ? (
            <span className="text-xs text-slate-500">Personal</span>
          ) : (
            <span className="text-xs text-slate-500">Org</span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-slate-500">
          {pat.isPersonal ? `owner: ${pat.ownerLogin ?? '—'}` : `org: ${pat.orgLogin ?? '—'}`}
          {' · '}
          token: ***{pat.tokenLast4}
          {pat.githubUserLogin && ` · login: ${pat.githubUserLogin}`}
          {pat.lastUsedAt && ` · usado: ${formatRel(pat.lastUsedAt)}`}
        </div>
      </div>
      <button
        onClick={onTest}
        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        Test
      </button>
      <button
        onClick={onDelete}
        className="rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100"
      >
        Delete
      </button>
    </li>
  );
}

function CreatePatDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): ReactNode {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [isPersonal, setIsPersonal] = useState(true);
  const [ownerLogin, setOwnerLogin] = useState('');
  const [orgLogin, setOrgLogin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      api.createPat({
        name: name.trim(),
        token: token.trim(),
        isPersonal,
        ownerLogin: isPersonal ? ownerLogin.trim() : undefined,
        orgLogin: !isPersonal ? orgLogin.trim() : undefined,
      }),
    onSuccess: () => {
      showToast('PAT agregado', 'success');
      onCreated();
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : String(err);
      setError(message);
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Nombre requerido');
      return;
    }
    if (!token.trim()) {
      setError('Token requerido');
      return;
    }
    if (isPersonal && !ownerLogin.trim()) {
      setError('ownerLogin requerido para PAT personal');
      return;
    }
    if (!isPersonal && !orgLogin.trim()) {
      setError('orgLogin requerido para PAT de org');
      return;
    }
    createMutation.mutate();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl">
        <div className="border-b border-slate-200 px-5 py-3">
          <h2 className="text-base font-semibold text-slate-900">Nuevo PAT</h2>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="space-y-3 px-5 py-4 text-sm">
            <Field label="Nombre" hint="Para identificarlo, ej: 'Personal', 'Org MisNumeros'">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Personal"
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
                autoFocus
              />
            </Field>

            <Field
              label="Token"
              hint="Pegá el token que generaste en GitHub. Se encripta antes de guardarse."
            >
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_..."
                autoComplete="off"
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
              />
            </Field>

            <Field label="Tipo">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setIsPersonal(true)}
                  className={`flex-1 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                    isPersonal
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Personal (user)
                </button>
                <button
                  type="button"
                  onClick={() => setIsPersonal(false)}
                  className={`flex-1 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                    !isPersonal
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Organización
                </button>
              </div>
            </Field>

            {isPersonal ? (
              <Field label="Owner login" hint="Tu username de GitHub, ej: 'diegominetti'">
                <input
                  type="text"
                  value={ownerLogin}
                  onChange={(e) => setOwnerLogin(e.target.value)}
                  placeholder="diegominetti"
                  className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
                />
              </Field>
            ) : (
              <Field label="Org login" hint="Slug de la org, ej: 'mi-organizacion'">
                <input
                  type="text"
                  value={orgLogin}
                  onChange={(e) => setOrgLogin(e.target.value)}
                  placeholder="mi-organizacion"
                  className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
                />
              </Field>
            )}

            {error && (
              <p className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={createMutation.isPending}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {createMutation.isPending ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700">{label}</label>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'hace segundos';
  if (ms < 3_600_000) return `hace ${Math.floor(ms / 60_000)}min`;
  if (ms < 86_400_000) return `hace ${Math.floor(ms / 3_600_000)}h`;
  return `hace ${Math.floor(ms / 86_400_000)}d`;
}

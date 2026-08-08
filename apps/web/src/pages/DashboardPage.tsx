import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { CreateRunnerDialog } from '../components/CreateRunnerDialog';
import { formatRelativeTime } from '../lib/format';
import type { Runner } from '@actions-self-hosted/shared';

interface DashboardPageProps {
  onSelectRunner: (id: string) => void;
}

export function DashboardPage({ onSelectRunner }: DashboardPageProps): ReactNode {
  const [createOpen, setCreateOpen] = useState(false);

  const runnersQuery = useQuery({
    queryKey: ['runners'],
    queryFn: api.listRunners,
    refetchInterval: 5_000,
  });

  const dockerQuery = useQuery({
    queryKey: ['docker'],
    queryFn: api.docker,
    refetchInterval: 10_000,
  });

  const runners = runnersQuery.data?.runners ?? [];
  const counts = countByStatus(runners);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Runners</h1>
          <p className="mt-1 text-sm text-slate-500">
            {runners.length} runner{runners.length === 1 ? '' : 's'} registrado
            {runners.length === 1 ? '' : 's'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
        >
          + Nuevo runner
        </button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Running" value={counts.running} tone="success" />
        <Stat label="Idle" value={counts.idle} tone="info" />
        <Stat label="Busy" value={counts.busy} tone="warning" />
        <Stat label="Offline" value={counts.offline} tone="neutral" />
        <Stat label="Errors" value={counts.error} tone="danger" />
      </div>

      <DockerBanner info={dockerQuery.data} loading={dockerQuery.isLoading} />

      {runnersQuery.isLoading && (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Cargando…
        </div>
      )}

      {runnersQuery.isError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          ❌ Error cargando runners:{' '}
          {runnersQuery.error instanceof ApiError
            ? runnersQuery.error.message
            : String(runnersQuery.error)}
        </div>
      )}

      {runnersQuery.isSuccess && runners.length === 0 && (
        <div className="rounded-lg border-2 border-dashed border-slate-300 bg-white p-10 text-center">
          <h2 className="text-sm font-semibold text-slate-700">Sin runners todavía</h2>
          <p className="mt-1 text-sm text-slate-500">
            Empezá creando el primero. Vas a necesitar un registration token fresco de GitHub.
          </p>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            + Nuevo runner
          </button>
        </div>
      )}

      {runnersQuery.isSuccess && runners.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>Nombre</Th>
                <Th>Target</Th>
                <Th>Status</Th>
                <Th>GitHub</Th>
                <Th>Container</Th>
                <Th>Creado</Th>
                <Th>Actividad</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {runners.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => onSelectRunner(r.id)}
                  className="cursor-pointer hover:bg-slate-50"
                >
                  <Td>
                    <div className="font-medium text-slate-900">{r.name}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {r.labels.slice(0, 3).join(' · ')}
                      {r.labels.length > 3 && ` +${r.labels.length - 3}`}
                    </div>
                  </Td>
                  <Td>
                    <div className="text-sm text-slate-700">
                      {r.scope === 'repo' ? '🔒 repo' : '🏢 org'}
                    </div>
                    <div className="text-xs text-slate-500">{r.targetSlug}</div>
                  </Td>
                  <Td>
                    <StatusBadge runner={r} />
                  </Td>
                  <Td>
                    <GitHubStatusBadge status={r.githubStatus} />
                  </Td>
                  <Td>
                    <code className="text-xs text-slate-500">{r.containerName}</code>
                  </Td>
                  <Td>
                    <div className="text-xs text-slate-500">{formatRelativeTime(r.createdAt)}</div>
                  </Td>
                  <Td>
                    <div className="text-xs text-slate-500">{formatRelativeTime(r.lastSeenAt)}</div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateRunnerDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(runner) => {
          // Pre-emptively silence the unused warning; toast already shown in mutation
          void runner;
          setCreateOpen(false);
        }}
      />
    </div>
  );
}

function countByStatus(runners: Runner[]) {
  return runners.reduce(
    (acc, r) => {
      if (r.status === 'error') acc.error++;
      // GitHub status (de la API de GitHub, refrescado cada 30s)
      if (r.githubStatus === 'busy') acc.busy++;
      else if (r.githubStatus === 'idle') acc.idle++;
      else if (r.githubStatus === 'offline') acc.offline++;
      // Container status (local)
      if (r.status === 'running' && r.containerState === 'running') acc.running++;
      return acc;
    },
    { running: 0, stopped: 0, stale: 0, error: 0, idle: 0, busy: 0, offline: 0 },
  );
}

function GitHubStatusBadge({ status }: { status: Runner['githubStatus'] }): ReactNode {
  const map: Record<Runner['githubStatus'], { text: string; className: string; icon: string }> = {
    busy: { text: 'Busy', className: 'bg-amber-100 text-amber-800', icon: '⚙' },
    idle: { text: 'Idle', className: 'bg-sky-100 text-sky-800', icon: '◯' },
    offline: { text: 'Offline', className: 'bg-slate-200 text-slate-700', icon: '○' },
    unknown: { text: '—', className: 'bg-slate-100 text-slate-500', icon: '?' },
  };
  const m = map[status];
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${m.className}`}
      title={`Estado en GitHub: ${m.text}`}
    >
      {m.icon} {m.text}
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info';
}): ReactNode {
  const toneClass: Record<typeof tone, string> = {
    success: 'text-emerald-700',
    warning: 'text-amber-700',
    danger: 'text-rose-700',
    neutral: 'text-slate-700',
    info: 'text-sky-700',
  };
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass[tone]}`}>{value}</div>
    </div>
  );
}

function DockerBanner({
  info,
  loading,
}: {
  info: ReturnType<typeof api.docker> extends Promise<infer T> ? T | undefined : never;
  loading: boolean;
}): ReactNode {
  if (loading) {
    return (
      <div className="mb-6 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        Chequeando Docker daemon…
      </div>
    );
  }
  if (!info) return null;
  if (!info.available) {
    return (
      <div className="mb-6 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
        ❌ Docker daemon no disponible: {info.error ?? 'unknown'}
      </div>
    );
  }
  return (
    <div className="mb-6 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
      🐳 Docker {info.version} · {info.os ?? 'unknown'} · {info.arch ?? '?'} ·{' '}
      {info.containers?.running ?? 0} running / {info.containers?.total ?? 0} total
    </div>
  );
}

function Th({ children }: { children: ReactNode }): ReactNode {
  return (
    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </th>
  );
}

function Td({ children }: { children: ReactNode }): ReactNode {
  return <td className="whitespace-nowrap px-4 py-3 text-sm">{children}</td>;
}

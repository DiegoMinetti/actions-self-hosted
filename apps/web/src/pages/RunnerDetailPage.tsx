import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { StatusBadge } from '../components/StatusBadge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { RenewDialog } from '../components/RenewDialog';
import { RecreateDialog } from '../components/RecreateDialog';
import { formatAbsoluteTime, formatRelativeTime, eventTone } from '../lib/format';
import type { Runner, RunnerEvent } from '@actions-self-hosted/shared';

interface RunnerDetailPageProps {
  runnerId: string;
  onBack: () => void;
}

export function RunnerDetailPage({ runnerId, onBack }: RunnerDetailPageProps): ReactNode {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const [recreateOpen, setRecreateOpen] = useState(false);

  const runnerQuery = useQuery({
    queryKey: ['runner', runnerId],
    queryFn: () => api.getRunner(runnerId),
    refetchInterval: 4_000,
  });

  const eventsQuery = useQuery({
    queryKey: ['runner-events', runnerId],
    queryFn: () => api.getRunnerEvents(runnerId),
    refetchInterval: 5_000,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['runner', runnerId] });
    queryClient.invalidateQueries({ queryKey: ['runner-events', runnerId] });
    queryClient.invalidateQueries({ queryKey: ['runners'] });
  }

  const action = useMutation({
    mutationFn: async (fn: () => Promise<Runner>) => fn(),
    onSuccess: (runner) => {
      queryClient.setQueryData(['runner', runnerId], runner);
      invalidate();
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : String(err);
      showToast(`Error: ${message}`, 'error');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteRunner(runnerId),
    onSuccess: () => {
      showToast('Runner borrado', 'success');
      queryClient.invalidateQueries({ queryKey: ['runners'] });
      onBack();
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : String(err);
      showToast(`Error: ${message}`, 'error');
    },
  });

  if (runnerQuery.isLoading) {
    return <div className="text-sm text-slate-500">Cargando…</div>;
  }
  if (runnerQuery.isError || !runnerQuery.data) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
        ❌{' '}
        {runnerQuery.error instanceof ApiError ? runnerQuery.error.message : 'Runner no encontrado'}
        <button onClick={onBack} className="ml-2 underline">
          Volver
        </button>
      </div>
    );
  }

  const runner = runnerQuery.data;
  const isRunning = runner.containerState === 'running';
  const isStopped = runner.containerState === 'exited';

  return (
    <div>
      <button onClick={onBack} className="mb-4 text-sm text-slate-600 hover:text-slate-900">
        ← Volver al dashboard
      </button>

      <header className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-slate-900">{runner.name}</h1>
            <StatusBadge runner={runner} />
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {runner.scope === 'repo' ? '🔒 Repo' : '🏢 Org'} · {runner.target}
          </p>
        </div>

        <div className="flex gap-2">
          <ActionButton
            label="Start"
            onClick={() => action.mutate(() => api.startRunner(runnerId))}
            disabled={isRunning || action.isPending}
            tone="success"
          />
          <ActionButton
            label="Stop"
            onClick={() => action.mutate(() => api.stopRunner(runnerId))}
            disabled={isStopped || action.isPending}
          />
          <ActionButton
            label="Restart"
            onClick={() => action.mutate(() => api.restartRunner(runnerId))}
            disabled={action.isPending}
          />
          <ActionButton label="Renew creds" onClick={() => setRenewOpen(true)} tone="warning" />
          <ActionButton label="Recreate" onClick={() => setRecreateOpen(true)} tone="info" />
          <ActionButton label="Delete" onClick={() => setDeleteOpen(true)} tone="danger" />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Información">
          <Row label="ID" value={<code className="text-xs">{runner.id}</code>} />
          <Row label="Scope" value={runner.scope} />
          <Row label="Target" value={runner.target} />
          <Row label="Target slug" value={runner.targetSlug} />
          <Row label="Labels" value={runner.labels.join(', ') || '—'} />
          <Row label="Imagen" value={<code className="text-xs">{runner.image}</code>} />
          <Row label="Container" value={<code className="text-xs">{runner.containerName}</code>} />
          <Row label="Volumen" value={<code className="text-xs">{runner.volumeName}</code>} />
          <Row label="Status lógico" value={runner.status} />
          <Row label="Container state" value={runner.containerState} />
          {runner.lastError && (
            <Row
              label="Último error"
              value={<span className="text-rose-700">{runner.lastError}</span>}
            />
          )}
          <Row label="Creado" value={formatAbsoluteTime(runner.createdAt)} />
          <Row label="Última actividad" value={formatRelativeTime(runner.lastSeenAt)} />
        </Section>

        <Section title="Eventos">
          {eventsQuery.isLoading && <p className="text-sm text-slate-500">Cargando…</p>}
          {eventsQuery.data && eventsQuery.data.events.length === 0 && (
            <p className="text-sm text-slate-500">Sin eventos todavía.</p>
          )}
          {eventsQuery.data && eventsQuery.data.events.length > 0 && (
            <ul className="space-y-2">
              {eventsQuery.data.events.map((ev) => (
                <li key={ev.id} className="flex items-start gap-2 text-sm">
                  <EventBadge type={ev.type} />
                  <div className="flex-1">
                    <div className="text-slate-700">{ev.message}</div>
                    <div className="text-xs text-slate-500">
                      {formatRelativeTime(ev.createdAt)} · {formatAbsoluteTime(ev.createdAt)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        title={`Borrar ${runner.name}?`}
        message={
          <>
            Esto va a <strong>detener el container</strong>, <strong>borrar el volumen</strong> y
            eliminar el registro. <strong>No se puede deshacer</strong>.
          </>
        }
        confirmLabel="Sí, borrar"
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
        onCancel={() => setDeleteOpen(false)}
      />

      <RenewDialog
        open={renewOpen}
        runner={runner}
        onClose={() => setRenewOpen(false)}
        onRenewed={() => {
          invalidate();
        }}
      />

      <RecreateDialog
        open={recreateOpen}
        runner={runner}
        onClose={() => setRecreateOpen(false)}
        onRecreated={() => {
          invalidate();
        }}
      />
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  tone = 'neutral',
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}): ReactNode {
  const toneClass: Record<typeof tone, string> = {
    neutral: 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
    success: 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
    warning: 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100',
    danger: 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100',
    info: 'border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${toneClass[tone]}`}
    >
      {label}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      <div className="space-y-2 text-sm">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="flex items-start gap-3">
      <dt className="w-32 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="flex-1 text-slate-800">{value}</dd>
    </div>
  );
}

const EVENT_TONE: Record<RunnerEvent['type'], string> = {
  created: 'bg-emerald-100 text-emerald-700',
  started: 'bg-emerald-100 text-emerald-700',
  renewed: 'bg-amber-100 text-amber-700',
  stopped: 'bg-slate-100 text-slate-700',
  restarted: 'bg-sky-100 text-sky-700',
  deleted: 'bg-rose-100 text-rose-700',
  error: 'bg-rose-100 text-rose-700',
  info: 'bg-slate-100 text-slate-700',
};

function EventBadge({ type }: { type: RunnerEvent['type'] }): ReactNode {
  const tone = eventTone(type);
  void tone; // silence unused
  return (
    <span
      className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-xs font-medium uppercase ${EVENT_TONE[type]}`}
    >
      {type}
    </span>
  );
}

import type { Runner, RunnerEvent } from '@actions-self-hosted/shared';

/**
 * Helpers de formato compartidos por la UI.
 */

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const now = Date.now();
  const diffSec = Math.round((now - date.getTime()) / 1000);
  if (diffSec < 60) return `hace ${diffSec}s`;
  if (diffSec < 3600) return `hace ${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `hace ${Math.floor(diffSec / 3600)}h`;
  return `hace ${Math.floor(diffSec / 86400)}d`;
}

export function formatAbsoluteTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export type StatusVisual = {
  label: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' | 'pulse';
};

export function statusVisual(runner: Runner): StatusVisual {
  if (runner.status === 'running' && runner.containerState === 'running') {
    return { label: 'Running', tone: 'success' };
  }
  if (runner.status === 'stopped' || runner.containerState === 'exited') {
    return { label: 'Stopped', tone: 'neutral' };
  }
  if (runner.status === 'creating' || runner.status === 'starting') {
    return { label: runner.status === 'creating' ? 'Creating' : 'Starting', tone: 'pulse' };
  }
  if (runner.status === 'stale') {
    return { label: 'Stale creds', tone: 'warning' };
  }
  if (runner.status === 'error') {
    return { label: 'Error', tone: 'danger' };
  }
  return { label: runner.status, tone: 'neutral' };
}

export function eventTone(type: RunnerEvent['type']): 'success' | 'warning' | 'danger' | 'info' {
  switch (type) {
    case 'created':
    case 'started':
    case 'renewed':
      return 'success';
    case 'stopped':
    case 'deleted':
      return 'info';
    case 'restarted':
      return 'info';
    case 'error':
      return 'danger';
    default:
      return 'info';
  }
}

import type { ReactNode } from 'react';
import { statusVisual } from '../lib/format';
import type { Runner } from '@actions-self-hosted/shared';

const TONE_CLASSES: Record<string, string> = {
  success: 'bg-emerald-100 text-emerald-800 ring-emerald-600/20',
  warning: 'bg-amber-100 text-amber-800 ring-amber-600/20',
  danger: 'bg-rose-100 text-rose-800 ring-rose-600/20',
  neutral: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  info: 'bg-sky-100 text-sky-800 ring-sky-600/20',
  pulse: 'bg-amber-100 text-amber-800 ring-amber-600/20',
};

export function StatusBadge({ runner }: { runner: Runner }): ReactNode {
  const visual = statusVisual(runner);
  const cls = TONE_CLASSES[visual.tone] ?? TONE_CLASSES.neutral;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${cls}`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          visual.tone === 'success'
            ? 'bg-emerald-500'
            : visual.tone === 'danger'
              ? 'bg-rose-500'
              : visual.tone === 'warning'
                ? 'bg-amber-500'
                : visual.tone === 'pulse'
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-slate-400'
        }`}
      />
      {visual.label}
    </span>
  );
}

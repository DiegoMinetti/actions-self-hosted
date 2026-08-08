import { useState, type ReactNode } from 'react';
import { DashboardPage } from './pages/DashboardPage';
import { RunnerDetailPage } from './pages/RunnerDetailPage';
import { SettingsPage } from './pages/SettingsPage';

type View = { type: 'dashboard' } | { type: 'runner'; id: string } | { type: 'settings' };

export default function App(): ReactNode {
  const [view, setView] = useState<View>({ type: 'dashboard' });

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <button
            onClick={() => setView({ type: 'dashboard' })}
            className="text-left"
            aria-label="Volver al dashboard"
          >
            <h1 className="text-lg font-semibold text-slate-900">Actions Self-Hosted</h1>
            <p className="text-xs text-slate-500">Panel local · Sprint 3</p>
          </button>
          {view.type === 'dashboard' && (
            <button
              onClick={() => setView({ type: 'settings' })}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              ⚙ Settings
            </button>
          )}
          {view.type === 'runner' && (
            <button
              onClick={() => setView({ type: 'dashboard' })}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              ← Dashboard
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {view.type === 'dashboard' && (
          <DashboardPage onSelectRunner={(id) => setView({ type: 'runner', id })} />
        )}
        {view.type === 'runner' && (
          <RunnerDetailPage runnerId={view.id} onBack={() => setView({ type: 'dashboard' })} />
        )}
        {view.type === 'settings' && <SettingsPage onBack={() => setView({ type: 'dashboard' })} />}
      </main>
    </div>
  );
}

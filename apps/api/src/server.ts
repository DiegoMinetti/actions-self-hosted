import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';
import { runMigrations } from './db/migrations.js';
import { closeDatabase } from './db/database.js';
import healthRouter from './routes/health.js';
import runnersRouter from './routes/runners.js';
import dockerRouter from './routes/docker.js';
import patsRouter from './routes/pats.js';
import { RunnersRepo } from './db/runners-repo.js';
import { GitHubService } from './services/github-service.js';
import { basicAuth, authEnabled } from './auth.js';
import { RUNNER_IMAGE } from './runner-image.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Correr migraciones al levantar (idempotente).
runMigrations();

const app = express();

// Middlewares globales
app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  }),
);

// Health check — FUERA de la auth: los healthchecks de Docker y los
// monitors no mandan credenciales.
app.use('/health', healthRouter);
app.use('/api/health', healthRouter);

// Auth básica. Si PANEL_USER/PANEL_PASSWORD están vacíos queda deshabilitada
// (dev). En producción hay que setearlas: la API expone el socket Docker, así
// que sin auth cualquiera que alcance el puerto puede crear containers
// privilegiados en el host.
app.use(basicAuth);

// API v1
app.use('/api/runners', runnersRouter);
app.use('/api/docker', dockerRouter);
app.use('/api/pats', patsRouter);

// --- Servir frontend estático en producción ---
// En dev el frontend se sirve por Vite (en :5173 con proxy a :3000).
// En prod el API sirve el bundle compilado desde apps/web/dist.
const webDistPath = resolve(__dirname, '../../web/dist');
if (env.NODE_ENV === 'production' && existsSync(webDistPath)) {
  app.use(express.static(webDistPath));
  // SPA fallback: cualquier GET que no sea /api/* devuelve index.html
  app.get(/^(?!\/api\/|\/health).*/, (_req, res) => {
    res.sendFile(resolve(webDistPath, 'index.html'));
  });
  console.log(`[api] serving web bundle from ${webDistPath}`);
}

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'NotFound',
    message: `Ruta ${req.method} ${req.path} no existe`,
  });
});

// Error handler global
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[api] unhandled error:', err);
  res.status(500).json({
    error: 'InternalServerError',
    message: err.message || 'Error inesperado del servidor',
  });
});

const server = app.listen(env.API_PORT, () => {
  console.log(`[api] listening on http://localhost:${env.API_PORT}`);
  console.log(`[api] env=${env.NODE_ENV}  cors=${env.CORS_ORIGIN}`);
  console.log(`[api] runner image=${RUNNER_IMAGE}`);
  if (authEnabled()) {
    console.log(`[api] auth básica habilitada (usuario "${env.PANEL_USER}")`);
  } else if (env.NODE_ENV === 'production') {
    console.warn(
      '\n⚠️  PANEL_USER / PANEL_PASSWORD sin definir: la API y el panel están SIN AUTH.\n' +
        '   La API expone el socket Docker, así que cualquiera que alcance el\n' +
        '   puerto puede crear containers privilegiados en el host.\n',
    );
  }
  if (env.NODE_ENV === 'production') {
    console.log(`[api] web UI: http://localhost:${env.API_PORT}`);
  }
});

// Graceful shutdown
const shutdown = (signal: string) => {
  console.log(`[api] received ${signal}, shutting down...`);
  server.close(() => {
    closeDatabase();
    console.log('[api] http server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[api] forced exit after 5s');
    process.exit(1);
  }, 5000);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- Background: poll de GitHub status cada 30s ---
// Para cada runner con github_pat_id configurado, consulta el estado
// idle/busy/offline en la API de GitHub y lo actualiza en la DB.
// El front lee ese estado desde la DB (no consulta GitHub directo).
const SYNC_INTERVAL_MS = 30_000;
let syncing = false;
async function syncAllRunnerStatuses(): Promise<void> {
  if (syncing) return; // evitar solapamiento si un sync tarda más de 30s
  syncing = true;
  try {
    const runners = RunnersRepo.list();
    for (const r of runners) {
      if (!r.githubPatId) continue;
      try {
        const { githubStatus } = await GitHubService.syncRunnerStatus(r.id);
        RunnersRepo.setGithubStatus(r.id, githubStatus);
      } catch (err) {
        // No tirar el sync entero por un runner individual. Loguear y seguir.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[sync] runner ${r.name} (${r.id}): ${msg}`);
      }
    }
  } finally {
    syncing = false;
  }
}

// Primer sync al arranque (sin esperar el interval)
syncAllRunnerStatuses().catch((err) => console.warn('[sync] initial sync failed:', err));
setInterval(() => {
  syncAllRunnerStatuses().catch((err) => console.warn('[sync] tick failed:', err));
}, SYNC_INTERVAL_MS);
console.log(`[sync] background GitHub status sync started (every ${SYNC_INTERVAL_MS / 1000}s)`);

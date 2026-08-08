import { Router, type Router as RouterType } from 'express';
import type { HealthResponse } from '@actions-self-hosted/shared';

const router: RouterType = Router();

const startedAt = Date.now();

/**
 * GET /api/health
 * Liveness/readiness probe. En Sprint 0 solo devuelve estado del proceso.
 * En Sprint 1 va a chequear además conexión a SQLite y al socket de Docker.
 */
router.get('/', (_req, res) => {
  const body: HealthResponse = {
    status: 'ok',
    version: '0.1.0',
    uptime: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  };
  res.json(body);
});

export default router;

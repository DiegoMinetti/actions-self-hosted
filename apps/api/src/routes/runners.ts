import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import type { CreateRunnerRequest, ListRunnersResponse } from '@actions-self-hosted/shared';
import { RunnerService } from '../services/runner-service.js';
import { RunnersRepo } from '../db/runners-repo.js';
import { importExistingContainer } from '../services/import-service.js';

const router: RouterType = Router();

// --- Schemas ---

// `image` NO es aceptado: la app usa una imagen wrapper fija
// (la que resuelve RUNNER_VERSION en el service) y no se puede cambiar
// desde el body. Si el user manda `image`, zod lo rechaza.
//
// `registrationToken` es opcional: si no se pasa, la app lo genera
// automáticamente con el `githubPatId` (o con el PAT que matchee
// el target por ownerLogin/orgLogin).
const createRunnerSchema = z
  .object({
    name: z.string().min(3).max(32),
    scope: z.enum(['repo', 'org']),
    target: z.string().min(1),
    labels: z.array(z.string()).optional(),
    githubPatId: z.string().uuid().optional(),
    registrationToken: z.string().min(1).optional(),
    runnerGroup: z.string().optional(),
    restartPolicy: z.enum(['always', 'unless-stopped', 'on-failure', 'no']).optional(),
  })
  .strict();

const renewRunnerSchema = z.object({
  registrationToken: z.string().min(1).optional(),
});

// PATCH: solo campos editables. `image` NO se puede cambiar (la imagen
// está fijada en DEFAULT_IMAGE del service).
const updateRunnerSchema = z
  .object({
    labels: z.array(z.string().min(1)).min(1).optional(),
    runnerGroup: z.string().min(1).optional(),
    restartPolicy: z.enum(['always', 'unless-stopped', 'on-failure', 'no']).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Patch vacío: tenés que pasar al menos un campo',
  });

const importSchema = z.object({
  containerName: z.string().min(1, 'containerName es requerido'),
  scope: z.enum(['repo', 'org']),
  target: z.string().min(1, 'target es requerido'),
});

const idParamSchema = z.object({ id: z.string().uuid() });

// --- Helpers ---

function handleError(res: import('express').Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api] error:', message);
  res.status(400).json({
    error: 'BadRequest',
    message,
  });
}

// --- Routes ---

/**
 * GET /api/runners
 * Lista todos los runners. Refresca el status desde Docker (best-effort).
 */
router.get('/', async (_req, res) => {
  const runners = RunnersRepo.list();
  // Refrescar status en background (no bloquea la respuesta)
  for (const r of runners) {
    RunnerService.refreshStatus(r.id).catch(() => {
      // ignore
    });
  }
  const response: ListRunnersResponse = { runners, total: runners.length };
  res.json(response);
});

/**
 * GET /api/runners/:id
 * Detalle de un runner.
 */
router.get('/:id', async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) return handleError(res, 'ID inválido');
  const runner = await RunnerService.refreshStatus(parsed.data.id);
  if (!runner) {
    return res.status(404).json({ error: 'NotFound', message: 'Runner no existe' });
  }
  res.json(runner);
});

/**
 * GET /api/runners/:id/events
 * Eventos de actividad del runner.
 */
router.get('/:id/events', (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) return handleError(res, 'ID inválido');
  const events = RunnersRepo.listEvents(parsed.data.id);
  res.json({ events });
});

/**
 * POST /api/runners
 * Crea un runner.
 */
router.post('/', async (req, res) => {
  const parsed = createRunnerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Input inválido',
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const input = parsed.data satisfies CreateRunnerRequest;
    const runner = await RunnerService.create(input);
    res.status(201).json(runner);
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * POST /api/runners/:id/start
 */
router.post('/:id/start', async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) return handleError(res, 'ID inválido');
  try {
    const runner = await RunnerService.start(parsed.data.id);
    res.json(runner);
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * POST /api/runners/:id/stop
 */
router.post('/:id/stop', async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) return handleError(res, 'ID inválido');
  try {
    const runner = await RunnerService.stop(parsed.data.id);
    res.json(runner);
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * POST /api/runners/:id/restart
 */
router.post('/:id/restart', async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) return handleError(res, 'ID inválido');
  try {
    const runner = await RunnerService.restart(parsed.data.id);
    res.json(runner);
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * POST /api/runners/:id/renew
 * Body: { registrationToken: string }
 * Re-registra credenciales.
 */
router.post('/:id/renew', async (req, res) => {
  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) return handleError(res, 'ID inválido');
  const parsedBody = renewRunnerSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Input inválido',
      details: parsedBody.error.flatten().fieldErrors,
    });
  }
  try {
    const runner = await RunnerService.renew(
      parsedParams.data.id,
      parsedBody.data.registrationToken,
    );
    res.json(runner);
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * POST /api/runners/:id/recreate
 * Body: { registrationToken: string }
 *
 * Recrea el container de un runner existente (mismo nombre, misma imagen,
 * mismo volumen) con un RUNNER_TOKEN fresco. NO borra credenciales del
 * volumen — usar `/renew` si las credenciales en disco están stale.
 *
 * Pensado para runners en estado `error` con `lastError: "Container X
 * no existe"`: el container se borró/dañó pero el registro en la DB
 * y el volumen siguen vivos. Esta ruta evita tener que Delete + crear
 * de nuevo con un nombre distinto.
 */
router.post('/:id/recreate', async (req, res) => {
  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) return handleError(res, 'ID inválido');
  const parsedBody = renewRunnerSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Input inválido',
      details: parsedBody.error.flatten().fieldErrors,
    });
  }
  try {
    const runner = await RunnerService.recreate(
      parsedParams.data.id,
      parsedBody.data.registrationToken,
    );
    res.json(runner);
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * PATCH /api/runners/:id
 * Body: { image?, labels?, runnerGroup?, restartPolicy? }
 *
 * Aplica un patch parcial al registro. NO toca el container de Docker:
 * los cambios aplican cuando se recree el container con `/recreate`
 * o `/renew`. Útil para migrar runners viejos a la imagen nueva sin
 * tener que Delete + crear de nuevo.
 */
router.patch('/:id', async (req, res) => {
  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) return handleError(res, 'ID inválido');
  const parsedBody = updateRunnerSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Input inválido',
      details: parsedBody.error.flatten().fieldErrors,
    });
  }
  try {
    const runner = await RunnerService.update(parsedParams.data.id, parsedBody.data);
    res.json(runner);
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * DELETE /api/runners/:id
 */
router.delete('/:id', async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) return handleError(res, 'ID inválido');
  try {
    await RunnerService.delete(parsed.data.id);
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * POST /api/runners/import-existing
 * Body: { containerName, scope, target }
 *
 * Importa un container Docker ya existente a la DB de la app.
 * NO lo detiene, NO lo recrea, NO cambia credenciales.
 */
router.post('/import-existing', async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Input inválido',
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const result = await importExistingContainer(parsed.data);
    res.status(201).json(result);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;

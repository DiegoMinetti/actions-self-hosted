import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { RunnersRepo } from '../db/runners-repo.js';
import { GitHubService, GitHubApiError } from '../services/github-service.js';

const router: RouterType = Router();

// --- Schemas ---

const createPatSchema = z
  .object({
    name: z.string().min(1).max(100),
    token: z.string().min(20, 'Token demasiado corto (mínimo 20 chars)'),
    isPersonal: z.boolean().default(true),
    ownerLogin: z.string().min(1).optional(),
    orgLogin: z.string().min(1).optional(),
  })
  .refine((data) => data.isPersonal || !!data.orgLogin, {
    message: 'Para un PAT de org, orgLogin es requerido',
    path: ['orgLogin'],
  })
  .refine((data) => !data.isPersonal || !!data.ownerLogin, {
    message: 'Para un PAT personal, ownerLogin es requerido',
    path: ['ownerLogin'],
  });

const idParamSchema = z.object({ id: z.string().uuid() });

// --- Routes ---

/** GET /api/pats — lista todos los PATs (sin el token plano, solo metadata). */
router.get('/', (_req, res) => {
  const pats = RunnersRepo.listPats();
  res.json({ pats, total: pats.length });
});

/** POST /api/pats — crea un PAT. Lo encripta antes de guardarlo. */
router.post('/', async (req, res) => {
  const parsed = createPatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Input inválido',
      details: parsed.error.flatten().fieldErrors,
    });
  }
  try {
    const pat = RunnersRepo.createPat(parsed.data);
    // No devolvemos el `token` (no está en el type GitHubPat de todos modos).
    res.status(201).json(pat);
  } catch (err) {
    handleError(res, err);
  }
});

/** DELETE /api/pats/:id — borra un PAT. Si hay runners usándolo, su github_pat_id queda null. */
router.delete('/:id', async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) return handleError(res, 'ID inválido');
  const pat = RunnersRepo.findPatById(parsed.data.id);
  if (!pat) return handleError(res, `PAT ${parsed.data.id} no existe`, 404);
  RunnersRepo.deletePat(parsed.data.id);
  res.status(204).send();
});

/** POST /api/pats/:id/test — valida el token contra GitHub y guarda el resultado. */
router.post('/:id/test', async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) return handleError(res, 'ID inválido');
  const pat = RunnersRepo.findPatById(parsed.data.id);
  if (!pat) return handleError(res, `PAT ${parsed.data.id} no existe`, 404);
  const token = RunnersRepo.getPatToken(parsed.data.id);
  if (!token) return handleError(res, 'No se pudo desencriptar el token', 500);
  try {
    const result = await GitHubService.testPat(token);
    RunnersRepo.setPatTestResult(parsed.data.id, true, result.login, result.scopes);
    res.json({ ok: true, login: result.login, scopes: result.scopes });
  } catch (err) {
    if (err instanceof GitHubApiError) {
      RunnersRepo.setPatTestResult(parsed.data.id, false, null, []);
      return res.status(401).json({
        error: 'GitHubAuthFailed',
        message: err.message,
        githubStatus: err.status,
      });
    }
    handleError(res, err);
  }
});

/**
 * POST /api/pats/:id/generate-runner-token
 * Body: { scope: 'repo' | 'org', target: 'owner/repo' | 'org-name' }
 *
 * Genera un registration token usando el PAT. Usado internamente por
 * RunnerService cuando crea/recrea/renueva un runner, pero también
 * expuesto al front para que pueda mostrar el token al user antes de
 * enviarlo a la API.
 */
router.post('/:id/generate-runner-token', async (req, res) => {
  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) return handleError(res, 'ID inválido');

  const parsedBody = z
    .object({
      scope: z.enum(['repo', 'org']),
      target: z.string().min(1),
    })
    .safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Input inválido',
      details: parsedBody.error.flatten().fieldErrors,
    });
  }

  const pat = RunnersRepo.findPatById(parsedParams.data.id);
  if (!pat) return handleError(res, `PAT ${parsedParams.data.id} no existe`, 404);

  const token = RunnersRepo.getPatToken(parsedParams.data.id);
  if (!token) return handleError(res, 'No se pudo desencriptar el token', 500);

  try {
    const registrationToken = await GitHubService.generateRunnerToken({
      token,
      scope: parsedBody.data.scope,
      target: parsedBody.data.target,
    });
    RunnersRepo.touchPatUsed(parsedParams.data.id);
    res.json({ token: registrationToken });
  } catch (err) {
    if (err instanceof GitHubApiError) {
      const status = err.status === 401 || err.status === 403 ? 401 : 502;
      return res.status(status).json({
        error: 'GitHubApiError',
        message: err.message,
        githubStatus: err.status,
        retryAfter: err.retryAfter,
      });
    }
    handleError(res, err);
  }
});

function handleError(res: import('express').Response, err: unknown, status = 400): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api/pats] error:', message);
  res.status(status).json({ error: 'BadRequest', message });
}

export default router;

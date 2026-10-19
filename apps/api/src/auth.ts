import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from './env.js';

/**
 * Auth básica HTTP para proteger el panel y la API.
 *
 * Por qué importa: la API tiene el socket Docker montado, así que cualquiera
 * que llegue al puerto puede crear containers privilegiados en el host. Con
 * auth, el acceso queda detrás de una credencial.
 *
 * - Si `PANEL_USER` / `PANEL_PASSWORD` están vacíos, la auth queda
 *   DESHABILITADA (útil en dev; en producción el panel no debería quedar
 *   abierto — la API expone el socket Docker).
 * - La comparación es timing-safe (evita filtrar el password por tiempo de
 *   respuesta).
 * - `/health` y `/api/health` quedan FUERA de la auth: los healthchecks de
 *   Docker y los monitors no mandan credenciales.
 */

const REALM = 'actions-self-hosted';

function unauthorized(res: Response): void {
  res.setHeader('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
  res.status(401).json({
    error: 'Unauthorized',
    message: 'Credenciales inválidas o ausentes',
  });
}

/**
 * Compara dos strings en tiempo constante.
 * `timingSafeEqual` exige el mismo largo, así que cuando difieren se hace
 * una comparación descartable para no filtrar el largo por timing.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Devuelve true si la auth está configurada y hay que aplicarla. */
export function authEnabled(): boolean {
  return Boolean(env.PANEL_USER && env.PANEL_PASSWORD);
}

export function basicAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authEnabled()) return next();

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) {
    return unauthorized(res);
  }

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    return unauthorized(res);
  }

  const sep = decoded.indexOf(':');
  if (sep < 0) return unauthorized(res);

  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  if (!safeEqual(user, env.PANEL_USER ?? '') || !safeEqual(pass, env.PANEL_PASSWORD ?? '')) {
    return unauthorized(res);
  }

  return next();
}

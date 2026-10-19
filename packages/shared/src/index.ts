/**
 * Tipos compartidos entre API y Web.
 * Sprint 1: agregamos Runner, RunnerStatus, eventos y request/response DTOs.
 */

// =============================================================
// Health
// =============================================================

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthResponse {
  status: HealthStatus;
  version: string;
  uptime: number;
  timestamp: string;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

// =============================================================
// Runner domain
// =============================================================

/**
 * Status lógico del runner (estado del container + estado de credenciales).
 * - creating: el container se está creando
 * - starting: docker start en curso
 * - running: container up (puede estar Idle, Busy u Offline en GitHub)
 * - stopped: container stopped
 * - stale: credenciales de GitHub expiraron, hay que renovar
 * - error: fallo de Docker o de red
 * - unknown: no pudimos determinar
 */
export type RunnerStatus =
  'creating' | 'starting' | 'running' | 'stopped' | 'stale' | 'error' | 'unknown';

/**
 * Tipo de scope del runner en GitHub.
 * - repo: ligado a un repo específico
 * - org: a nivel organización (corre en todos los repos de la org)
 */
export type RunnerScope = 'repo' | 'org';

export interface Runner {
  id: string;
  name: string;
  scope: RunnerScope;
  /** URL completa del repo (e.g. "https://github.com/owner/repo") o de la org. */
  target: string;
  /** Para scope=repo, "owner/repo". Para scope=org, "org". */
  targetSlug: string;
  labels: string[];
  /**
   * Imagen Docker a usar. Es fija para todos los runners: la app la
   * resuelve desde RUNNER_VERSION / RUNNER_IMAGE (ver
   * `apps/api/src/runner-image.ts`).
   */
  image: string;
  /** Nombre del container en Docker. */
  containerName: string;
  /** Nombre del volumen nombrado donde persisten .runner/.credentials. */
  volumeName: string;
  status: RunnerStatus;
  /** Estado de container de Docker (separado del status lógico de credenciales). */
  containerState:
    'created' | 'running' | 'exited' | 'paused' | 'restarting' | 'removing' | 'dead' | 'unknown';
  lastError: string | null;
  /** ID del GitHub PAT usado para gestionar este runner (null = sin PAT asociado). */
  githubPatId: string | null;
  /** ID que GitHub asignó al runner (se setea después del primer sync con la API). */
  githubRunnerId: string | null;
  /** Estado observado en GitHub (idle/busy/offline/unknown). */
  githubStatus: 'idle' | 'busy' | 'offline' | 'unknown';
  githubStatusCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
}

/**
 * GitHub PAT (Personal Access Token) persistido y encriptado en la DB.
 * Soporta N PATs por app (multi-cuenta). El `token` nunca se devuelve
 * al front — solo el `tokenLast4` para identificar visualmente.
 */
export interface GitHubPat {
  id: string;
  /** Nombre legible para identificar el PAT (ej: "Personal", "Org MisNumeros"). */
  name: string;
  /** true si es un PAT de user, false si es de org. */
  isPersonal: boolean;
  /** Login del owner (para PATs personales de user, ej: "DiegoMinetti"). */
  ownerLogin: string | null;
  /** Login de la org (para PATs de org, ej: "mi-organizacion"). */
  orgLogin: string | null;
  /** Login del user autenticado, devuelto por `GET /user` con este PAT. */
  githubUserLogin: string | null;
  /** Scopes del token (devueltos por la API de GitHub). */
  scopes: string[];
  /** Últimos 4 chars del PAT, para mostrar en UI sin exponer el secret. */
  tokenLast4: string;
  lastUsedAt: string | null;
  lastTestedAt: string | null;
  /** Resultado del último test: true=ok, false=falla, null=nunca testeado. */
  lastTestOk: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunnerEvent {
  id: number;
  runnerId: string;
  type: 'created' | 'started' | 'stopped' | 'restarted' | 'renewed' | 'deleted' | 'error' | 'info';
  message: string;
  createdAt: string;
}

// =============================================================
// API DTOs
// =============================================================

/**
 * Body de POST /api/runners.
 *
 * Si se pasa `githubPatId`, la app genera el registration token
 * automáticamente con ese PAT. Si no se pasa, se busca un PAT que
 * matchee el target por `ownerLogin` o `orgLogin`.
 *
 * `registrationToken` se mantiene como override manual (útil para tests
 * o para casos donde el user ya tiene un token fresco a mano).
 */
export interface CreateRunnerRequest {
  name: string;
  scope: RunnerScope;
  /** Para repo: "owner/repo". Para org: "org-name". */
  target: string;
  labels?: string[];
  /** ID del GitHub PAT a usar. Si no se pasa, auto-selección por target. */
  githubPatId?: string;
  /** Token de registration fresco de GitHub (override manual, opcional). */
  registrationToken?: string;
  /** Runner group (opcional). Default "Default". */
  runnerGroup?: string;
  /** Restart policy de Docker. Default "unless-stopped". */
  restartPolicy?: 'always' | 'unless-stopped' | 'on-failure' | 'no';
}

/**
 * Body de POST /api/runners/:id/recreate y /api/runners/:id/renew.
 *
 * `registrationToken` es opcional: si no se pasa, la app lo genera
 * automáticamente con el PAT asociado al runner.
 */
export interface RenewRunnerRequest {
  /** Token fresco para re-registrar (override manual, opcional). */
  registrationToken?: string;
}

export interface ListRunnersResponse {
  runners: Runner[];
  total: number;
}

export interface DockerInfo {
  available: boolean;
  version?: string;
  apiVersion?: string;
  os?: string;
  arch?: string;
  /** Tag de la imagen del runner que usa la app (derivado de RUNNER_VERSION). */
  runnerImage?: string;
  containers?: {
    total: number;
    running: number;
    stopped: number;
  };
  error?: string;
}

import { RunnersRepo } from '../db/runners-repo.js';

/**
 * GitHubService: capa de integración con la API REST de GitHub.
 *
 * Auth: usa un Personal Access Token (PAT) provisto por el caller. Los
 * PATs se persisten encriptados en la DB (ver crypto.ts) y se desencriptan
 * solo cuando hay que hacer una llamada (server-side).
 *
 * Rate limit: 5000 req/h para PATs autenticados. Si GitHub responde 429,
 * exponemos el header `Retry-After` en el error que tiremos.
 */

const GITHUB_API = 'https://api.github.com';

export class GitHubApiError extends Error {
  status: number;
  retryAfter: number | null;
  constructor(message: string, status: number, retryAfter: number | null) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const GitHubService = {
  /**
   * Verifica que un PAT sirve. Llama a `GET /user` y devuelve info
   * del user autenticado + scopes. NO persiste nada en la DB (eso lo
   * hace el caller con RunnersRepo.setPatTestResult).
   */
  async testPat(token: string): Promise<{ login: string; scopes: string[] }> {
    const res = await fetch(`${GITHUB_API}/user`, {
      headers: githubHeaders(token),
    });
    if (!res.ok) {
      throw await apiError(res, 'testPat');
    }
    const user = (await res.json()) as { login: string };
    const scopes = parseScopes(res.headers.get('x-oauth-scopes'));
    return { login: user.login, scopes };
  },

  /**
   * Genera un registration token para registrar un runner nuevo.
   * Endpoint: `POST /repos/{owner}/{repo}/actions/runners/registration-token`
   * (para scope=repo) o `POST /orgs/{org}/actions/runners/registration-token`
   * (para scope=org).
   *
   * El token devuelto es single-use y vale ~1h.
   */
  async generateRunnerToken(args: {
    token: string;
    scope: 'repo' | 'org';
    target: string; // "owner/repo" o "org"
  }): Promise<string> {
    const url =
      args.scope === 'repo'
        ? `${GITHUB_API}/repos/${args.target}/actions/runners/registration-token`
        : `${GITHUB_API}/orgs/${args.target}/actions/runners/registration-token`;

    const res = await fetch(url, {
      method: 'POST',
      headers: githubHeaders(args.token),
    });
    if (!res.ok) {
      throw await apiError(res, 'generateRunnerToken');
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    if (!body.token) {
      throw new Error('GitHub devolvió 200 OK pero sin token en el body');
    }
    return body.token;
  },

  /**
   * Devuelve el estado de un runner: `busy` (ejecutando job) o `idle`
   * (conectado pero sin job). Más el `status` (online/offline) para
   * distinguir "conectado pero no trabajando" de "no se puede conectar".
   *
   * Endpoint: `GET /repos/{owner}/{repo}/actions/runners/{runner_id}` o
   * `GET /orgs/{org}/actions/runners/{runner_id}`.
   */
  async getRunnerStatus(args: {
    token: string;
    scope: 'repo' | 'org';
    target: string;
    runnerId: number | string;
  }): Promise<{ busy: boolean; online: boolean; status: string }> {
    const url =
      args.scope === 'repo'
        ? `${GITHUB_API}/repos/${args.target}/actions/runners/${args.runnerId}`
        : `${GITHUB_API}/orgs/${args.target}/actions/runners/${args.runnerId}`;
    const res = await fetch(url, {
      headers: githubHeaders(args.token),
    });
    if (res.status === 404) {
      // El runner no está registrado en GitHub (puede haber sido removido
      // manualmente o el token no tiene acceso). Devolvemos status unknown.
      return { busy: false, online: false, status: 'not_found' };
    }
    if (!res.ok) {
      throw await apiError(res, 'getRunnerStatus');
    }
    const body = (await res.json()) as { busy: boolean; status: string };
    return { busy: body.busy, online: body.status === 'online', status: body.status };
  },

  /**
   * Lista los runners registrados en GitHub para un target. Útil para
   * encontrar el `github_runner_id` de un runner que acabamos de crear
   * (por nombre, no por ID).
   */
  async listRunners(args: { token: string; scope: 'repo' | 'org'; target: string }): Promise<
    Array<{
      id: number;
      name: string;
      busy: boolean;
      status: string;
    }>
  > {
    const url =
      args.scope === 'repo'
        ? `${GITHUB_API}/repos/${args.target}/actions/runners`
        : `${GITHUB_API}/orgs/${args.target}/actions/runners`;
    const res = await fetch(url, {
      headers: githubHeaders(args.token),
    });
    if (!res.ok) {
      throw await apiError(res, 'listRunners');
    }
    const body = (await res.json()) as {
      runners: Array<{ id: number; name: string; busy: boolean; status: string }>;
    };
    return body.runners;
  },

  /**
   * Helper de alto nivel: dado un runner_id interno (UUID de la app),
   * busca el PAT asociado, lee su target, y consulta el estado en GitHub.
   * Devuelve `null` si no hay PAT o si GitHub no conoce al runner.
   */
  async syncRunnerStatus(internalRunnerId: string): Promise<{
    githubStatus: 'idle' | 'busy' | 'offline' | 'unknown';
    githubRunnerId: string | null;
  }> {
    const runner = RunnersRepo.findById(internalRunnerId);
    if (!runner) return { githubStatus: 'unknown', githubRunnerId: null };

    if (!runner.githubPatId) {
      return { githubStatus: 'unknown', githubRunnerId: runner.githubRunnerId };
    }
    const pat = RunnersRepo.findPatById(runner.githubPatId);
    if (!pat) {
      return { githubStatus: 'unknown', githubRunnerId: runner.githubRunnerId };
    }
    const patToken = RunnersRepo.getPatToken(pat.id);
    if (!patToken) {
      return { githubStatus: 'unknown', githubRunnerId: runner.githubRunnerId };
    }

    // Si no tenemos el github_runner_id todavía, intentamos encontrarlo
    // por nombre en la lista de runners de GitHub.
    let ghRunnerId = runner.githubRunnerId;
    if (!ghRunnerId) {
      const runners = await this.listRunners({
        token: patToken,
        scope: runner.scope,
        target: runner.targetSlug,
      });
      const match = runners.find((r) => r.name === runner.name);
      if (match) {
        ghRunnerId = String(match.id);
        RunnersRepo.setGithubRunnerId(runner.id, ghRunnerId);
      } else {
        // El runner no se registró en GitHub (puede estar todavía
        // configurándose, o el registro falló). Marcamos unknown.
        return { githubStatus: 'unknown', githubRunnerId: null };
      }
    }

    const status = await this.getRunnerStatus({
      token: patToken,
      scope: runner.scope,
      target: runner.targetSlug,
      runnerId: ghRunnerId,
    });

    RunnersRepo.touchPatUsed(pat.id);

    const ghStatus: 'idle' | 'busy' | 'offline' | 'unknown' = !status.online
      ? 'offline'
      : status.busy
        ? 'busy'
        : 'idle';

    return { githubStatus: ghStatus, githubRunnerId: ghRunnerId };
  },
};

// --- helpers internos ---

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'actions-self-hosted-panel',
  };
}

function parseScopes(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function apiError(res: Response, op: string): Promise<GitHubApiError> {
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    // ignore
  }
  const retryAfterHeader = res.headers.get('retry-after');
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : null;
  return new GitHubApiError(
    `GitHub API error in ${op}: ${res.status} ${res.statusText} - ${bodyText.slice(0, 200)}`,
    res.status,
    retryAfter,
  );
}

import type { RunnerScope } from '@actions-self-hosted/shared';

/**
 * Cliente para la API de GitHub (Actions self-hosted runners).
 *
 * NO usamos el token de registration para autenticación general.
 * Cada llamada de alta/renew recibe un token fresco del usuario, lo usa, y lo descarta.
 *
 * API docs:
 *   - Listar runners de un repo: GET /repos/{owner}/{repo}/actions/runners
 *   - Listar runners de una org: GET /orgs/{org}/actions/runners
 *   - Generar registration token repo: POST /repos/{owner}/{repo}/actions/runners/registration-token
 *   - Generar registration token org:  POST /orgs/{org}/actions/runners/registration-token
 *   - Eliminar runner repo: DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}
 *   - Eliminar runner org:  DELETE /orgs/{org}/actions/runners/{runner_id}
 *
 * El RUNNER registration NO se hace via API REST — el container del runner
 * lo hace internamente al arrancar, usando RUNNER_TOKEN + RUNNER_REPO_URL/ORG_URL.
 * Nuestra app solo:
 *   1) Verifica que el runner está registrado (GET .../actions/runners) leyendo la lista
 *   2) Lo elimina de GitHub cuando el user borra el runner en la app
 */

const API_BASE = 'https://api.github.com';

interface GitHubRunner {
  id: number;
  name: string;
  os: string;
  status: 'online' | 'offline' | 'idle' | 'busy';
  busy: boolean;
  labels: Array<{ name: string; type?: string }>;
}

export interface RegistrationTokenResponse {
  token: string;
  expires_at: string;
}

/**
 * Token de registration que el USER nos pasa.
 * (En este sprint NO generamos tokens nosotros — los pedimos al user.
 *  Se podría automatizar con un PAT con scope "admin:org" / "repo", Sprint 2+).
 */
export interface UserCredentials {
  /** Personal Access Token del user, scope "repo" (para repo) o "admin:org" (para org). */
  pat: string;
  registrationToken: string;
}

export const GitHub = {
  /**
   * Lista los runners registrados en GitHub. Útil para verificar que el
   * nuestro está online y para importar los existentes (Sprint 3).
   */
  async listRunners(scope: RunnerScope, target: string, pat: string): Promise<GitHubRunner[]> {
    const url =
      scope === 'repo'
        ? `${API_BASE}/repos/${target}/actions/runners?per_page=100`
        : `${API_BASE}/orgs/${target}/actions/runners?per_page=100`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `GitHub listRunners failed: ${res.status} ${res.statusText} - ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as { runners: GitHubRunner[] };
    return json.runners;
  },

  /**
   * Elimina un runner de GitHub por su ID numérico.
   * El ID de GitHub es distinto del ID de nuestro DB.
   */
  async removeRunner(
    scope: RunnerScope,
    target: string,
    runnerId: number,
    pat: string,
  ): Promise<void> {
    const url =
      scope === 'repo'
        ? `${API_BASE}/repos/${target}/actions/runners/${runnerId}`
        : `${API_BASE}/orgs/${target}/actions/runners/${runnerId}`;

    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok && res.status !== 204) {
      const body = await res.text();
      throw new Error(
        `GitHub removeRunner failed: ${res.status} ${res.statusText} - ${body.slice(0, 200)}`,
      );
    }
  },

  /**
   * Devuelve un token fresco de registration para re-registrar credenciales.
   * Útil para renew (Sprint 1) o para el wizard de alta (Sprint 2).
   */
  async generateRegistrationToken(
    scope: RunnerScope,
    target: string,
    pat: string,
  ): Promise<RegistrationTokenResponse> {
    const url =
      scope === 'repo'
        ? `${API_BASE}/repos/${target}/actions/runners/registration-token`
        : `${API_BASE}/orgs/${target}/actions/runners/registration-token`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `GitHub generateRegistrationToken failed: ${res.status} - ${body.slice(0, 200)}`,
      );
    }
    return (await res.json()) as RegistrationTokenResponse;
  },
};

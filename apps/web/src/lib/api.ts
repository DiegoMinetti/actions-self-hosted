import type {
  CreateRunnerRequest,
  DockerInfo,
  GitHubPat,
  HealthResponse,
  ListRunnersResponse,
  RenewRunnerRequest,
  Runner,
  RunnerEvent,
} from '@actions-self-hosted/shared';

/**
 * Cliente HTTP de la API.
 * Usa rutas relativas — en dev el proxy de Vite redirige a la API,
 * en prod el server estático sirve el bundle.
 */

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let body: { message?: string; details?: unknown } = {};
    try {
      body = (await res.json()) as { message?: string; details?: unknown };
    } catch {
      // body wasn't JSON
    }
    throw new ApiError(body.message ?? `HTTP ${res.status} en ${path}`, res.status, body.details);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;

  return (await res.json()) as T;
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),

  docker: () => request<DockerInfo>('/api/docker'),

  // Runners
  listRunners: () => request<ListRunnersResponse>('/api/runners'),
  getRunner: (id: string) => request<Runner>(`/api/runners/${id}`),
  getRunnerEvents: (id: string) => request<{ events: RunnerEvent[] }>(`/api/runners/${id}/events`),
  createRunner: (data: CreateRunnerRequest) =>
    request<Runner>('/api/runners', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  startRunner: (id: string) => request<Runner>(`/api/runners/${id}/start`, { method: 'POST' }),
  stopRunner: (id: string) => request<Runner>(`/api/runners/${id}/stop`, { method: 'POST' }),
  restartRunner: (id: string) => request<Runner>(`/api/runners/${id}/restart`, { method: 'POST' }),
  renewRunner: (id: string, data: RenewRunnerRequest) =>
    request<Runner>(`/api/runners/${id}/renew`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  recreateRunner: (id: string, data: RenewRunnerRequest) =>
    request<Runner>(`/api/runners/${id}/recreate`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateRunner: (
    id: string,
    patch: {
      labels?: string[];
      runnerGroup?: string;
      restartPolicy?: 'always' | 'unless-stopped' | 'on-failure' | 'no';
    },
  ) =>
    request<Runner>(`/api/runners/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteRunner: (id: string) => request<void>(`/api/runners/${id}`, { method: 'DELETE' }),

  // GitHub PATs
  listPats: () => request<{ pats: GitHubPat[]; total: number }>('/api/pats'),
  createPat: (data: {
    name: string;
    token: string;
    isPersonal: boolean;
    ownerLogin?: string;
    orgLogin?: string;
  }) =>
    request<GitHubPat>('/api/pats', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deletePat: (id: string) => request<void>(`/api/pats/${id}`, { method: 'DELETE' }),
  testPat: (id: string) =>
    request<{ ok: boolean; login: string; scopes: string[] }>(`/api/pats/${id}/test`, {
      method: 'POST',
    }),
  generateRunnerToken: (id: string, scope: 'repo' | 'org', target: string) =>
    request<{ token: string }>(`/api/pats/${id}/generate-runner-token`, {
      method: 'POST',
      body: JSON.stringify({ scope, target }),
    }),
};

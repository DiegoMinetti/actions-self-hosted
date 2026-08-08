import { randomUUID } from 'node:crypto';
import { prepare } from './database.js';
import type {
  CreateRunnerRequest,
  GitHubPat,
  Runner,
  RunnerEvent,
  RunnerScope,
  RunnerStatus,
} from '@actions-self-hosted/shared';
import { encrypt, decrypt } from '../crypto.js';

/**
 * Repository: capa de acceso a datos para runners.
 * Aísla SQL del resto de la app. Si cambia el schema, cambia solo acá.
 *
 * Importante: NO guardamos el registrationToken (es single-use, vale 1h).
 * Solo lo usamos para registrar en GitHub; después lo descartamos.
 */

interface RunnerRow {
  id: string;
  name: string;
  scope: RunnerScope;
  target: string;
  target_slug: string;
  labels: string;
  image: string;
  container_name: string;
  volume_name: string;
  status: RunnerStatus;
  container_state: Runner['containerState'];
  last_error: string | null;
  runner_group: string;
  restart_policy: NonNullable<CreateRunnerRequest['restartPolicy']>;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  github_pat_id: string | null;
  github_runner_id: string | null;
  github_status: Runner['githubStatus'];
  github_status_checked_at: string | null;
}

function rowToRunner(row: RunnerRow): Runner {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    target: row.target,
    targetSlug: row.target_slug,
    labels: JSON.parse(row.labels) as string[],
    image: row.image,
    containerName: row.container_name,
    volumeName: row.volume_name,
    status: row.status,
    containerState: row.container_state,
    lastError: row.last_error,
    githubPatId: row.github_pat_id,
    githubRunnerId: row.github_runner_id,
    githubStatus: row.github_status ?? 'unknown',
    githubStatusCheckedAt: row.github_status_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

export const RunnersRepo = {
  list(): Runner[] {
    const rows = prepare(
      'SELECT * FROM runners ORDER BY created_at DESC',
    ).all() as unknown as RunnerRow[];
    return rows.map(rowToRunner);
  },

  count(): number {
    const row = prepare('SELECT COUNT(*) as c FROM runners').get() as unknown as { c: number };
    return row.c;
  },

  findById(id: string): Runner | null {
    const row = prepare('SELECT * FROM runners WHERE id = ?').get(id) as unknown as
      RunnerRow | undefined;
    return row ? rowToRunner(row) : null;
  },

  findByName(name: string): Runner | null {
    const row = prepare('SELECT * FROM runners WHERE name = ?').get(name) as unknown as
      RunnerRow | undefined;
    return row ? rowToRunner(row) : null;
  },

  findByContainerName(containerName: string): Runner | null {
    const row = prepare('SELECT * FROM runners WHERE container_name = ?').get(
      containerName,
    ) as unknown as RunnerRow | undefined;
    return row ? rowToRunner(row) : null;
  },

  /**
   * Crea el registro del runner en DB. El container de Docker se crea afuera.
   * Devuelve el Runner con id, containerName, volumeName generados.
   *
   * `githubPatId` es opcional: si no se pasa, queda NULL. El background
   * sync va a buscar el PAT que matchee el target después.
   */
  create(
    data: {
      name: string;
      scope: RunnerScope;
      target: string;
      targetSlug: string;
      labels: string[];
      image: string;
      containerName: string;
      volumeName: string;
      githubPatId?: string | null;
    },
    runnerGroup: string,
    restartPolicy: CreateRunnerRequest['restartPolicy'],
  ): Runner {
    const id = randomUUID();
    const now = new Date().toISOString();
    prepare(
      `INSERT INTO runners
        (id, name, scope, target, target_slug, labels, image,
         container_name, volume_name, status, container_state,
         runner_group, restart_policy, created_at, updated_at,
         github_pat_id, github_runner_id, github_status, github_status_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', 'unknown', ?, ?, ?, ?,
               ?, NULL, 'unknown', NULL)`,
    ).run(
      id,
      data.name,
      data.scope,
      data.target,
      data.targetSlug,
      JSON.stringify(data.labels),
      data.image,
      data.containerName,
      data.volumeName,
      runnerGroup,
      restartPolicy ?? 'unless-stopped',
      now,
      now,
      data.githubPatId ?? null,
    );
    const created = this.findById(id);
    if (!created) throw new Error('Failed to read back created runner');
    return created;
  },

  updateStatus(
    id: string,
    status: RunnerStatus,
    containerState: Runner['containerState'],
    lastError: string | null = null,
  ): void {
    prepare(
      `UPDATE runners
       SET status = ?, container_state = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(status, containerState, lastError, new Date().toISOString(), id);
  },

  touchLastSeen(id: string): void {
    prepare('UPDATE runners SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      new Date().toISOString(),
      id,
    );
  },

  setError(id: string, message: string): void {
    prepare(
      `UPDATE runners
       SET status = 'error', last_error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(message, new Date().toISOString(), id);
  },

  delete(id: string): void {
    prepare('DELETE FROM runners WHERE id = ?').run(id);
  },

  // ---- GitHub integration ----

  /** Actualiza el `github_runner_id` que GitHub asignó al runner. */
  setGithubRunnerId(id: string, githubRunnerId: string | null): void {
    prepare('UPDATE runners SET github_runner_id = ?, updated_at = ? WHERE id = ?').run(
      githubRunnerId,
      new Date().toISOString(),
      id,
    );
  },

  /** Actualiza el status observado en GitHub (idle/busy/offline/unknown). */
  setGithubStatus(id: string, status: 'idle' | 'busy' | 'offline' | 'unknown'): void {
    prepare(
      'UPDATE runners SET github_status = ?, github_status_checked_at = ?, updated_at = ? WHERE id = ?',
    ).run(status, new Date().toISOString(), new Date().toISOString(), id);
  },

  /**
   * Aplica un patch parcial al registro. Solo los campos provistos
   * se actualizan. Los demás quedan intactos. El `updated_at` se
   * refresca automáticamente.
   *
   * NO se puede cambiar `id`, `name`, `container_name`, `volume_name`,
   * `scope`, `target`, `target_slug` ni `created_at` por este método
   * (son estructurales; para esos casos borrar y crear de nuevo).
   */
  update(
    id: string,
    patch: {
      image?: string;
      labels?: string[];
      runnerGroup?: string;
      restartPolicy?: CreateRunnerRequest['restartPolicy'];
      githubPatId?: string | null;
    },
  ): Runner | null {
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.image !== undefined) {
      setClauses.push('image = ?');
      values.push(patch.image);
    }
    if (patch.labels !== undefined) {
      setClauses.push('labels = ?');
      values.push(JSON.stringify(patch.labels));
    }
    if (patch.runnerGroup !== undefined) {
      setClauses.push('runner_group = ?');
      values.push(patch.runnerGroup);
    }
    if (patch.restartPolicy !== undefined) {
      setClauses.push('restart_policy = ?');
      values.push(patch.restartPolicy);
    }
    if (patch.githubPatId !== undefined) {
      setClauses.push('github_pat_id = ?');
      values.push(patch.githubPatId);
    }
    if (setClauses.length === 0) {
      return this.findById(id);
    }
    setClauses.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    prepare(`UPDATE runners SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    return this.findById(id);
  },

  // ---- Events ----

  addEvent(runnerId: string, type: RunnerEvent['type'], message: string): void {
    prepare(
      'INSERT INTO runner_events (runner_id, type, message, created_at) VALUES (?, ?, ?, ?)',
    ).run(runnerId, type, message, new Date().toISOString());
  },

  listEvents(runnerId: string, limit = 100): RunnerEvent[] {
    const rows = prepare(
      'SELECT * FROM runner_events WHERE runner_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(runnerId, limit) as unknown as Array<{
      id: number;
      runner_id: string;
      type: RunnerEvent['type'];
      message: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      runnerId: r.runner_id,
      type: r.type,
      message: r.message,
      createdAt: r.created_at,
    }));
  },

  // ============================================================
  // GitHub PATs (multi-cuenta, encriptados en DB)
  // ============================================================

  listPats(): GitHubPat[] {
    const rows = prepare(
      'SELECT * FROM github_pats ORDER BY created_at DESC',
    ).all() as unknown as GitHubPatRow[];
    return rows.map(rowToPat);
  },

  findPatById(id: string): GitHubPat | null {
    const row = prepare('SELECT * FROM github_pats WHERE id = ?').get(id) as
      GitHubPatRow | undefined;
    return row ? rowToPat(row) : null;
  },

  /** Crea un PAT. El token se encripta antes de guardarse. */
  createPat(input: {
    name: string;
    token: string;
    isPersonal: boolean;
    ownerLogin?: string | null;
    orgLogin?: string | null;
  }): GitHubPat {
    const id = randomUUID();
    const now = new Date().toISOString();
    const tokenLast4 = input.token.slice(-4);
    prepare(
      `INSERT INTO github_pats
        (id, name, encrypted_token, token_last4, is_personal,
         owner_login, org_login, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      encrypt(input.token),
      tokenLast4,
      input.isPersonal ? 1 : 0,
      input.ownerLogin ?? null,
      input.orgLogin ?? null,
      now,
      now,
    );
    const created = this.findPatById(id);
    if (!created) throw new Error('Failed to read back created PAT');
    return created;
  },

  deletePat(id: string): void {
    prepare('DELETE FROM github_pats WHERE id = ?').run(id);
  },

  /** Actualiza el resultado del último test del PAT. */
  setPatTestResult(
    id: string,
    ok: boolean,
    githubUserLogin: string | null,
    scopes: string[],
  ): void {
    prepare(
      `UPDATE github_pats
       SET last_tested_at = ?, last_test_ok = ?, github_user_login = ?, scopes = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      new Date().toISOString(),
      ok ? 1 : 0,
      githubUserLogin,
      JSON.stringify(scopes),
      new Date().toISOString(),
      id,
    );
  },

  /** Actualiza el last_used_at. */
  touchPatUsed(id: string): void {
    prepare('UPDATE github_pats SET last_used_at = ?, updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      new Date().toISOString(),
      id,
    );
  },

  /**
   * Devuelve el token PLAIN de un PAT (desencriptado). Solo lo usa el
   * GitHubService en el server. NO exponer al front.
   */
  getPatToken(id: string): string | null {
    const row = prepare('SELECT encrypted_token FROM github_pats WHERE id = ?').get(id) as
      { encrypted_token: string } | undefined;
    if (!row) return null;
    try {
      return decrypt(row.encrypted_token);
    } catch {
      return null;
    }
  },

  /** Busca un PAT que matchee el target (por owner_login o org_login). */
  findPatForTarget(scope: 'repo' | 'org', targetSlug: string): GitHubPat | null {
    // targetSlug es "owner/repo" para scope=repo o "org" para scope=org.
    let owner: string | null = null;
    let org: string | null = null;
    if (scope === 'repo') {
      const parts = targetSlug.split('/');
      owner = parts[0] ?? null;
    } else {
      org = targetSlug;
    }
    if (!owner && !org) return null;
    // Preferimos match exacto: owner_login == owner (para repo) o
    // org_login == org. Si no hay match, no devolvemos nada (no queremos
    // usar un PAT genérico que no matchee el target).
    const candidates = this.listPats();
    return (
      candidates.find((p) => {
        if (scope === 'repo') return p.ownerLogin === owner;
        return p.orgLogin === org;
      }) ?? null
    );
  },
};

interface GitHubPatRow {
  id: string;
  name: string;
  encrypted_token: string;
  token_last4: string;
  is_personal: number;
  owner_login: string | null;
  org_login: string | null;
  github_user_login: string | null;
  scopes: string | null;
  last_used_at: string | null;
  last_tested_at: string | null;
  last_test_ok: number | null;
  created_at: string;
  updated_at: string;
}

function rowToPat(row: GitHubPatRow): GitHubPat {
  return {
    id: row.id,
    name: row.name,
    isPersonal: row.is_personal === 1,
    ownerLogin: row.owner_login,
    orgLogin: row.org_login,
    githubUserLogin: row.github_user_login,
    scopes: row.scopes ? (JSON.parse(row.scopes) as string[]) : [],
    tokenLast4: row.token_last4,
    lastUsedAt: row.last_used_at,
    lastTestedAt: row.last_tested_at,
    lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

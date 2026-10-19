import type Dockerode from 'dockerode';
import type { Runner, RunnerScope } from '@actions-self-hosted/shared';
import { RunnersRepo } from '../db/runners-repo.js';
import { getDocker, pingDocker } from '../docker/client.js';
import { inspectContainer, mapContainerState } from '../docker/containers.js';
import { RUNNER_IMAGE } from '../runner-image.js';

// Imagen que usa la app. Se importa con la imagen real del container
// existente solo para registro/debug, pero al recrear/renovar siempre se
// usa RUNNER_IMAGE (ver runner-image.ts).
const APP_DEFAULT_IMAGE = RUNNER_IMAGE;

export interface ImportExistingArgs {
  /** Container name real (e.g. "github-runner-misnumeros-1"). */
  containerName: string;
  scope: RunnerScope;
  /** owner/repo u org-name. */
  target: string;
}

export interface ImportExistingResult {
  runner: Runner;
  /** Datos extraídos del inspect (para debug / log). */
  extracted: {
    image: string;
    labels: string[];
    volumeName: string;
    containerState: Runner['containerState'];
    restartPolicy: string;
  };
}

/**
 * Importa un container Docker YA EXISTENTE a la DB de la app.
 * NO lo detiene, NO lo recrea, NO cambia credenciales.
 * Solo registra en DB para que la app lo pueda manipular.
 *
 * Saca del `docker inspect`:
 *   - image
 *   - env var RUNNER_LABELS
 *   - mount de tipo volume en /runner-data (o /home/runner en el layout viejo)
 *   - container state
 *   - restart policy
 *
 * El "name" del runner (en GitHub) sale del env var RUNNER_NAME, NO del container name.
 * El container name y volume name quedan como están (NO se renombran).
 */
export async function importExistingContainer(
  args: ImportExistingArgs,
): Promise<ImportExistingResult> {
  if (!(await pingDocker())) {
    throw new Error('Docker daemon no disponible');
  }

  // 1) Verificar que el container existe
  const docker = getDocker();
  const container = docker.getContainer(args.containerName);
  let info: Dockerode.ContainerInspectInfo;
  try {
    info = await container.inspect();
  } catch {
    throw new Error(`Container "${args.containerName}" no existe`);
  }

  // 2) Verificar que no esté ya importado
  const existing = RunnersRepo.findByContainerName(args.containerName);
  if (existing) {
    throw new Error(
      `Container "${args.containerName}" ya está importado (runner "${existing.name}")`,
    );
  }

  // 3) Sacar datos del inspect
  const envList = info.Config?.Env ?? [];
  const envMap = new Map<string, string>();
  for (const e of envList) {
    const idx = e.indexOf('=');
    if (idx > 0) envMap.set(e.slice(0, idx), e.slice(idx + 1));
  }

  const runnerName = envMap.get('RUNNER_NAME');
  if (!runnerName) {
    throw new Error(
      `Container "${args.containerName}" no tiene env var RUNNER_NAME. ¿Es un runner de actions?`,
    );
  }

  const labelsStr = envMap.get('RUNNER_LABELS') ?? '';
  const labels = labelsStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Buscar el mount de tipo volume donde la app persiste las credenciales.
  // El layout actual monta en /runner-data; /home/runner es el layout viejo
  // (pre-2.338.0), donde el volumen pisaba los binarios del runner.
  const mounts = info.Mounts ?? [];
  const dataMount =
    mounts.find((m) => m.Destination === '/runner-data' && m.Type === 'volume') ??
    mounts.find((m) => m.Destination === '/home/runner' && m.Type === 'volume');
  if (!dataMount?.Name) {
    throw new Error(
      `Container "${args.containerName}" no tiene un volumen montado en /runner-data`,
    );
  }
  const volumeName = dataMount.Name;

  const imageReal = info.Config?.Image ?? 'unknown';
  // La imagen del registro se setea a la default de la app. El campo
  // "image" guardado en DB es informativo/histórico; el flujo de
  // recreate/renew usa siempre APP_DEFAULT_IMAGE.
  const image = APP_DEFAULT_IMAGE;
  const containerState = mapContainerState(info);
  const restartPolicy = info.HostConfig?.RestartPolicy?.Name ?? 'no';

  // 4) Validar scope + target
  if (args.scope === 'repo' && !/^[^/\s]+\/[^/\s]+$/.test(args.target)) {
    throw new Error(`Target inválido para repo: "${args.target}". Esperado "owner/repo".`);
  }
  if (args.scope === 'org' && !/^[^/\s]+$/.test(args.target)) {
    throw new Error(`Target inválido para org: "${args.target}". Esperado "org-name".`);
  }

  // 5) Validar que el name no esté duplicado
  if (RunnersRepo.findByName(runnerName)) {
    throw new Error(`Ya existe un runner con el name "${runnerName}"`);
  }

  // 6) Crear registro en DB
  const targetUrl = `https://github.com/${args.target}`;
  const runner = RunnersRepo.create(
    {
      name: runnerName,
      scope: args.scope,
      target: targetUrl,
      targetSlug: args.target,
      labels,
      image,
      containerName: args.containerName,
      volumeName,
    },
    'Default',
    restartPolicy as 'always' | 'unless-stopped' | 'on-failure' | 'no',
  );
  RunnersRepo.addEvent(
    runner.id,
    'info',
    `Importado desde container existente "${args.containerName}" (image real: ${imageReal}, state: ${containerState})`,
  );

  // 7) Refrescar status real
  const updated = await refreshImportedStatus(runner.id, args.containerName);

  return {
    runner: updated ?? runner,
    extracted: {
      image: imageReal,
      labels,
      volumeName,
      containerState,
      restartPolicy,
    },
  };
}

async function refreshImportedStatus(
  runnerId: string,
  containerName: string,
): Promise<Runner | null> {
  const info = await inspectContainer(containerName);
  const state = mapContainerState(info);
  const isRunning = state === 'running';
  const status: Runner['status'] = isRunning
    ? 'running'
    : state === 'exited'
      ? 'stopped'
      : 'unknown';
  RunnersRepo.updateStatus(runnerId, status, state, null);
  if (isRunning) {
    RunnersRepo.touchLastSeen(runnerId);
  }
  return RunnersRepo.findById(runnerId);
}

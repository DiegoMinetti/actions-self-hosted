import type Dockerode from 'dockerode';
import { getDocker } from './client.js';
import { env } from '../env.js';
import type { Runner } from '@actions-self-hosted/shared';

/**
 * Helpers para manejar containers de runners.
 *
 * Convenciones de nombres:
 *   - Container name: `actions-runner-<name>`
 *   - Volume name:    `actions-runner-<name>-home`
 *
 * Si un runner queda offline mucho tiempo, GitHub borra la registration y el
 * container entra en loop de "Failed to create a session". En ese caso el
 * service layer llama a `wipeVolumeCredentials()` y re-registra.
 */

export type RestartPolicy = 'always' | 'unless-stopped' | 'on-failure' | 'no';

export interface CreateRunnerContainerArgs {
  containerName: string;
  volumeName: string;
  image: string;
  name: string;
  scope: 'repo' | 'org';
  /** URL completa del repo u org. Para repo: https://github.com/owner/repo. Para org: https://github.com/org. */
  target: string;
  labels: string[];
  runnerGroup: string;
  registrationToken: string;
  restartPolicy: RestartPolicy;
}

/**
 * Crea el container. Precondición: el volumen ya debe existir.
 *
 * Env vars que pasamos al container (las lee el entrypoint de
 * `docker/runner/entrypoint.sh`, que a su vez llama al `config.sh` oficial):
 *   RUNNER_NAME: nombre único del runner
 *   RUNNER_TOKEN: registration token (single-use)
 *   RUNNER_REPO_URL: URL del repo (si scope=repo)
 *   RUNNER_ORG_URL: URL de la org (si scope=org)
 *   RUNNER_LABELS: comma-separated
 *   RUNNER_GROUP: nombre del grupo (default: Default)
 *   RUNNER_ALLOW_RUNASROOT: 1 (porque el container corre como root por default)
 */
export async function createRunnerContainer(opts: CreateRunnerContainerArgs): Promise<void> {
  const docker = getDocker();
  const envVars = [
    `RUNNER_NAME=${opts.name}`,
    `RUNNER_TOKEN=${opts.registrationToken}`,
    opts.scope === 'repo' ? `RUNNER_REPO_URL=${opts.target}` : `RUNNER_ORG_URL=${opts.target}`,
    `RUNNER_LABELS=${opts.labels.join(',')}`,
    `RUNNER_GROUP=${opts.runnerGroup}`,
    // actions/runner corre como root dentro del container; necesario para escribir en /home/runner.
    'RUNNER_ALLOW_RUNASROOT=1',
  ];

  // Socket Docker: en Mac/Linux es /var/run/docker.sock del host.
  // En Windows la cosa es distinta (named pipe). El service layer lo decide.
  const dockerSocketBind = process.platform === 'win32' ? null : '/var/run/docker.sock';

  const hostConfig: Dockerode.HostConfig = {
    RestartPolicy: { Name: opts.restartPolicy },
    Init: true,
    AutoRemove: false,
    Binds: [
      // Volumen nombrado → persiste SOLO las credenciales del runner
      // (`.runner` + `.credentials`) en /runner-data.
      //
      // El work dir `/home/runner` NO se monta a propósito. Ahí viven los
      // binarios (`bin/`, `externals/`, `config.sh`, `run.sh`) y si el volumen
      // persistente los pisa, el container queda congelado en la versión con la
      // que se creó el volumen: el tag de la imagen deja de reflejar la
      // versión real del runner. Reproducido con un volumen creado con la
      // 2.328.0 que seguía sirviendo los binarios de 2.328.0 después de
      // correr la imagen 2.338.0.
      //
      // Con este layout los binarios vienen SIEMPRE de la imagen oficial y el
      // volumen guarda solo unos pocos KB de credenciales.
      // Ver `docker/runner/Dockerfile.runner`.
      `${opts.volumeName}:/runner-data`,
      // Socket Docker → para que el runner pueda buildear imágenes dentro de jobs.
      ...(dockerSocketBind ? [`${dockerSocketBind}:/var/run/docker.sock`] : []),
    ],
    // Mismas caps que el setup de MisNumeros (github-runner-misnumeros).
    // Sin DAC_OVERRIDE + CHOWN, corriendo como UID 1000 no podemos acceder
    // a archivos del volumen que quedaron propiedad de UID 1001 de runs
    // anteriores (`.credentials`, `.runner`). El listener falla con
    // `UnauthorizedAccessException: Access to the path '...' is denied` y el
    // container entra en loop de restart. cap_drop ALL + cap_add específicas
    // minimiza la superficie de ataque comparado con correr como root.
    CapDrop: ['ALL'],
    CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETUID', 'KILL'],
    SecurityOpt: ['no-new-privileges:true'],
  };

  // En Mac con Docker Desktop el socket queda como GID 0 adentro del
  // container (no GID 1 como en Linux "normal"). El user `runner` de la
  // imagen oficial (UID 1001, grupo `docker` GID 123) no entra en GID 0,
  // entonces `docker ps` y `docker buildx create` fallan con
  // "permission denied while trying to connect to the docker API".
  // Solución: correr como `1001:0` — el UID 1001 (`runner`) es dueño de
  // los archivos que escribe (las credenciales del volumen) y GID 0 le da
  // acceso al socket. Alternativa sería `1000:0` pero ahí los volúmenes
  // viejos con archivos UID 1001 no se pueden escribir sin chmod previo.
  // En Linux nativo (socket GID 1) también funciona porque GID 0 incluye
  // acceso a GID 1.
  const runAsUser = '1001:0';

  // Labels que agruparán este container en Docker Desktop bajo el header
  // `actions-self-hosted` (o el COMPOSE_PROJECT_NAME configurado).
  const labels: Record<string, string> = {
    'com.docker.compose.project': env.COMPOSE_PROJECT_NAME,
    'com.docker.compose.service': `runner-${opts.name}`,
    'managed-by': 'actions-self-hosted-app',
  };

  const existing = await findContainerByName(opts.containerName);
  if (existing) {
    throw new Error(`Container ${opts.containerName} ya existe`);
  }

  // Algunas imágenes del runner (notablemente `ghcr.io/actions/actions-runner:*`
  // en versiones recientes, Q1 2025+) dejaron de traer ENTRYPOINT configurado
  // en el Dockerfile: solo traen `CMD ["/bin/bash"]`. Cuando Docker arranca
  // un container desde esa imagen sin un comando explícito, queda idle en bash
  // y el listener del runner nunca se inicia (los logs muestran
  // "To run a command as administrator..." que viene del script run.sh
  // cuando algo lo invoca en un contexto raro).
  //
  // La imagen oficial `ghcr.io/actions/actions-runner:*` (y cualquier otra
  // imagen sin ENTRYPOINT) arrancaría el container en bash idle, con el
  // listener sin ejecutar. Para esas imágenes inyectamos
  // `Cmd: ['/home/runner/run.sh']` explícitamente.
  //
  // La imagen que usa la app (`actions-self-hosted-runner:<version>`) es un
  // wrapper sobre la oficial que YA trae ENTRYPOINT propio, así que acá
  // `Cmd` queda undefined y se respeta el entrypoint de la imagen.
  const cmd = await resolveImageCmd(opts.image);

  await docker.createContainer({
    name: opts.containerName,
    Image: opts.image,
    Env: envVars,
    HostConfig: hostConfig,
    Labels: labels,
    User: runAsUser,
    ...(cmd ? { Cmd: cmd } : {}),
    // TTY para que el entrypoint no se cierre.
    Tty: true,
    OpenStdin: true,
  });
}

/**
 * Asegura que el volumen nombrado existe. Si no existe, lo crea con los
 * labels del project de compose para que aparezca agrupado en Docker Desktop.
 */
export async function ensureVolume(volumeName: string): Promise<void> {
  const docker = getDocker();
  const list = await docker.listVolumes();
  const exists = (list.Volumes ?? []).some((v) => v.Name === volumeName);
  if (!exists) {
    await docker.createVolume({
      Name: volumeName,
      Labels: {
        'com.docker.compose.project': env.COMPOSE_PROJECT_NAME,
        'managed-by': 'actions-self-hosted-app',
      },
    });
  }
}

export async function removeVolume(volumeName: string): Promise<void> {
  const docker = getDocker();
  try {
    await docker.getVolume(volumeName).remove();
  } catch (err) {
    // Si no existe, no es error.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('No such volume') && !msg.includes('not found')) {
      throw err;
    }
  }
}

export async function startContainer(containerName: string): Promise<void> {
  const container = await getContainerByName(containerName);
  await container.start();
}

export async function stopContainer(containerName: string, timeout = 30): Promise<void> {
  const container = await getContainerByName(containerName);
  await container.stop({ t: timeout });
}

export async function restartContainer(containerName: string): Promise<void> {
  const container = await getContainerByName(containerName);
  await container.restart();
}

export async function removeContainer(containerName: string, force = false): Promise<void> {
  const container = await getContainerByNameOrNull(containerName);
  if (!container) return;
  if (force) {
    await container.remove({ force: true, v: true });
  } else {
    await container.remove({ v: true });
  }
}

export async function inspectContainer(
  containerName: string,
): Promise<Dockerode.ContainerInspectInfo | null> {
  const container = await getContainerByNameOrNull(containerName);
  if (!container) return null;
  return container.inspect();
}

export function mapContainerState(
  info: Dockerode.ContainerInspectInfo | null,
): Runner['containerState'] {
  if (!info) return 'unknown';
  const s = info.State?.Status;
  switch (s) {
    case 'created':
      return 'created';
    case 'running':
      return 'running';
    case 'exited':
      return 'exited';
    case 'paused':
      return 'paused';
    case 'restarting':
      return 'restarting';
    case 'removing':
      return 'removing';
    case 'dead':
      return 'dead';
    default:
      return 'unknown';
  }
}

// --- helpers internos ---

async function getContainerByName(name: string): Promise<Dockerode.Container> {
  const container = await getContainerByNameOrNull(name);
  if (!container) throw new Error(`Container ${name} no existe`);
  return container;
}

async function getContainerByNameOrNull(name: string): Promise<Dockerode.Container | null> {
  const docker = getDocker();
  const container = docker.getContainer(name);
  try {
    await container.inspect();
    return container;
  } catch {
    return null;
  }
}

async function findContainerByName(name: string): Promise<boolean> {
  return (await getContainerByNameOrNull(name)) !== null;
}

/**
 * Devuelve el `Cmd` a pasarle a `createContainer` para que el container
 * arranque el listener del runner. Devuelve `undefined` si la imagen ya
 * tiene un ENTRYPOINT propio (caso de la imagen que usa la app:
 * `actions-self-hosted-runner:<version>`).
 *
 * Si la imagen no se puede inspeccionar devolvemos `undefined`: en ese caso
 * el `createContainer` va a fallar igual con "No such image", así que
 * inyectar un Cmd aparte no aporta nada y podría pisar el entrypoint
 * correcto de la imagen.
 */
async function resolveImageCmd(image: string): Promise<string[] | undefined> {
  try {
    const docker = getDocker();
    const info = await docker.getImage(image).inspect();
    const entrypoint = info.Config?.Entrypoint;
    if (entrypoint && entrypoint.length > 0) {
      return undefined; // la imagen ya arranca sola
    }
    return ['/home/runner/run.sh'];
  } catch {
    return undefined;
  }
}

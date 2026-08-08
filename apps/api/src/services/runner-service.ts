import type { CreateRunnerRequest, Runner } from '@actions-self-hosted/shared';
import { RunnersRepo } from '../db/runners-repo.js';
import {
  createRunnerContainer,
  ensureVolume,
  inspectContainer,
  mapContainerState,
  removeContainer,
  removeVolume,
  restartContainer,
  startContainer,
  stopContainer,
} from '../docker/containers.js';
import { getDocker } from '../docker/client.js';
import { GitHubService } from './github-service.js';

/**
 * Helper: garantiza que la imagen está disponible en el daemon local
 * antes de crear el container.
 *
 * `docker.createContainer` NO hace pull automático: si la imagen no está
 * local, falla con un 404 opaco ("No such image: ..."). El caso típico
 * es que el user elige la imagen default `ghcr.io/actions/actions-runner:latest`
 * y nunca la pull-eó.
 *
 * Para imágenes LOCALES (sin registry prefix, como `actions-runner:2.336.0`
 * que buildeamos con `docker/runner/build.sh`), `docker.pull` no sirve:
 * Docker no chequea el cache local en `pull`, va derecho a Docker Hub y
 * falla con "pull access denied" porque la imagen no existe ahí. Por eso
 * primero inspeccionamos con `getImage().inspect()` y skipeamos el pull
 * si la imagen ya está local.
 *
 * Si la imagen no está, intenta el pull. Si el pull falla (registry
 * caído, sin red, etc.) tira error claro en vez del genérico 404 del
 * createContainer.
 */
async function ensureImage(image: string): Promise<void> {
  const docker = getDocker();

  // 1) Si la imagen ya está en el daemon, no hacer nada.
  try {
    await docker.getImage(image).inspect();
    return; // local cache hit
  } catch {
    // No está local, seguimos con el pull.
  }

  // 2) No está local, intentar pull. Sigue el progreso vía modem.followProgress
  //    porque dockerode expone el pull como un stream.
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (pullErr: unknown, stream: NodeJS.ReadableStream) => {
      if (pullErr) {
        reject(pullErr);
        return;
      }
      docker.modem.followProgress(
        stream,
        (followErr: unknown) => {
          if (followErr) reject(followErr);
          else resolve();
        },
        () => {
          // progress event — silencioso
        },
      );
    });
  });
}

const DEFAULT_IMAGE = 'actions-runner:2.336.0';
const DEFAULT_GROUP = 'Default';
const DEFAULT_LABELS = ['self-hosted', 'linux', 'x64'];
const DEFAULT_RESTART_POLICY = 'unless-stopped';

/**
 * Service layer: orquesta DB + Docker.
 * Las routes HTTP solo validan input y delegan a este service.
 *
 * Convenciones:
 *   - containerName: `actions-runner-<name>`
 *   - volumeName:    `actions-runner-<name>-home`
 *   - name: kebab-case, único. El user lo elige.
 */

function deriveTargetUrl(scope: CreateRunnerRequest['scope'], target: string): string {
  return scope === 'repo' ? `https://github.com/${target}` : `https://github.com/${target}`;
}

function validateRunnerName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(name)) {
    throw new Error(
      `Nombre inválido: "${name}". Usá kebab-case, 3-32 chars, solo [a-z0-9-], no empieza/termina con guión.`,
    );
  }
}

function validateTarget(scope: CreateRunnerRequest['scope'], target: string): void {
  if (scope === 'repo') {
    if (!/^[^/\s]+\/[^/\s]+$/.test(target)) {
      throw new Error(`Target inválido para repo: "${target}". Esperado "owner/repo".`);
    }
  } else {
    if (!/^[^/\s]+$/.test(target)) {
      throw new Error(`Target inválido para org: "${target}". Esperado "org-name".`);
    }
  }
}

export const RunnerService = {
  /**
   * Crea un runner: registro en DB, volumen Docker, container, y lo deja corriendo.
   * El container se registra solo en GitHub al arrancar (el entrypoint lo hace
   * usando RUNNER_TOKEN + RUNNER_REPO_URL).
   */
  async create(input: CreateRunnerRequest): Promise<Runner> {
    // 1) Validaciones
    validateRunnerName(input.name);
    validateTarget(input.scope, input.target);

    if (RunnersRepo.findByName(input.name)) {
      throw new Error(`Ya existe un runner con el nombre "${input.name}"`);
    }
    if (RunnersRepo.findByContainerName(`actions-runner-${input.name}`)) {
      throw new Error(`Ya existe un container con nombre "actions-runner-${input.name}"`);
    }

    // 2) Calcular nombres y defaults. La imagen es FIJA: siempre
    //    DEFAULT_IMAGE. El user no la puede elegir al crear.
    const containerName = `actions-runner-${input.name}`;
    const volumeName = `actions-runner-${input.name}-home`;
    const labels = input.labels?.length ? input.labels : DEFAULT_LABELS;
    const image = DEFAULT_IMAGE;
    const runnerGroup = input.runnerGroup ?? DEFAULT_GROUP;
    const restartPolicy = input.restartPolicy ?? DEFAULT_RESTART_POLICY;
    const targetUrl = deriveTargetUrl(input.scope, input.target);

    // 3) Resolver el registration token.
    //    Prioridad: registrationToken explícito del body > PAT del body >
    //    PAT auto-seleccionado por match de target. Si no hay ninguno,
    //    error claro.
    let registrationToken = input.registrationToken;
    let githubPatId: string | null = input.githubPatId ?? null;

    if (!registrationToken) {
      if (!githubPatId) {
        const pat = RunnersRepo.findPatForTarget(input.scope, input.target);
        if (!pat) {
          throw new Error(
            `No hay un GitHub PAT configurado para ${input.target}. ` +
              'Agregá uno en Settings → GitHub PATs, o pasá `githubPatId` en el body.',
          );
        }
        githubPatId = pat.id;
      }
      const pat = RunnersRepo.findPatById(githubPatId);
      if (!pat) {
        throw new Error(`GitHub PAT ${githubPatId} no existe`);
      }
      const patToken = RunnersRepo.getPatToken(githubPatId);
      if (!patToken) {
        throw new Error(`No se pudo desencriptar el PAT ${githubPatId}`);
      }
      registrationToken = await GitHubService.generateRunnerToken({
        token: patToken,
        scope: input.scope,
        target: input.target,
      });
      RunnersRepo.touchPatUsed(githubPatId);
    }

    // 4) Crear registro en DB primero (status=creating)
    const runner = RunnersRepo.create(
      {
        name: input.name,
        scope: input.scope,
        target: targetUrl,
        targetSlug: input.target,
        labels,
        image,
        containerName,
        volumeName,
        githubPatId,
      },
      runnerGroup,
      restartPolicy,
    );
    RunnersRepo.addEvent(runner.id, 'created', `Runner ${input.name} registrado en DB`);

    try {
      // 5) Volumen + container. Pull primero para evitar el 404 opaco de
      //    `createContainer` cuando la imagen no está en el daemon.
      await ensureVolume(volumeName);
      await ensureImage(image);
      await createRunnerContainer({
        containerName,
        volumeName,
        image,
        name: input.name,
        scope: input.scope,
        target: targetUrl,
        labels,
        runnerGroup,
        registrationToken,
        restartPolicy,
      });
      RunnersRepo.addEvent(runner.id, 'info', `Container ${containerName} creado`);

      // 6) Arrancar
      await startContainer(containerName);
      RunnersRepo.addEvent(runner.id, 'started', `Container ${containerName} arrancado`);
      RunnersRepo.touchLastSeen(runner.id);

      // 7) Refrescar estado real
      const updated = await this.refreshStatus(runner.id);
      return updated ?? runner;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      RunnersRepo.setError(runner.id, message);
      RunnersRepo.addEvent(runner.id, 'error', `Fallo creando runner: ${message}`);
      throw err;
    }
  },

  async start(id: string): Promise<Runner> {
    const runner = this.mustFind(id);
    await startContainer(runner.containerName);
    RunnersRepo.addEvent(id, 'started', 'Container started');
    return (await this.refreshStatus(id)) ?? runner;
  },

  async stop(id: string): Promise<Runner> {
    const runner = this.mustFind(id);
    await stopContainer(runner.containerName);
    RunnersRepo.addEvent(id, 'stopped', 'Container stopped');
    return (await this.refreshStatus(id)) ?? runner;
  },

  async restart(id: string): Promise<Runner> {
    const runner = this.mustFind(id);
    await restartContainer(runner.containerName);
    RunnersRepo.addEvent(id, 'restarted', 'Container restarted');
    return (await this.refreshStatus(id)) ?? runner;
  },

  /**
   * Recrea el container de un runner sin tocar el volumen (ni sus
   * credenciales). Útil en estos casos:
   *   - El container se borró/dañó pero el volumen sigue sano
   *     (caso típico: `docker rm` accidental, container que crasheó
   *     y no se puede re-arrancar).
   *   - El user quiere reintentar la creación después de un fallo
   *     del `create` original (image faltante, port conflict, etc.).
   *
   * NO borra credenciales del volumen. Si las credenciales en disco
   * están stale (GitHub las invalidó), usar `renew()` en su lugar,
   * que sí las borra antes de re-registrar.
   *
   * El entrypoint del wrapper (`docker/runner/entrypoint.sh`) detecta
   * si hay credenciales en el volumen y skipea el `configure`; si no
   * hay, corre `configure` con el `RUNNER_TOKEN` fresco. Por eso
   * este método requiere que el user pase un `registrationToken`
   * nuevo (los tokens son single-use y el original ya expiró).
   */
  async recreate(id: string, registrationToken?: string): Promise<Runner> {
    const runner = this.mustFind(id);
    const { containerName, volumeName, scope, target, labels } = runner;
    const runnerGroup = 'Default';
    // La imagen es FIJA — siempre el default actual, no lo que tenga
    // guardado el registro. Así, si actualizamos DEFAULT_IMAGE en una
    // nueva release, los runners existentes usan la nueva al recrear.
    const image = DEFAULT_IMAGE;

    // Auto-generar el token con el PAT del runner si no vino en el body.
    const token = await resolveRegistrationToken(
      registrationToken,
      runner.githubPatId,
      runner.scope,
      runner.targetSlug,
    );

    // 1) Stop (best-effort) + remove container. Si no existe, es no-op.
    try {
      await stopContainer(containerName, 10);
    } catch {
      // Ya estaba stopped o no existe
    }
    await removeContainer(containerName, true);
    RunnersRepo.addEvent(id, 'info', `Container removed para recreate`);

    // 2) Pull + create + start. NO tocamos el volumen.
    await ensureImage(image);
    await createRunnerContainer({
      containerName,
      volumeName,
      image,
      name: runner.name,
      scope,
      target,
      labels,
      runnerGroup,
      registrationToken: token,
      restartPolicy: 'unless-stopped',
    });
    RunnersRepo.addEvent(id, 'info', `Container ${containerName} recreado`);

    // 3) Start
    await startContainer(containerName);
    RunnersRepo.addEvent(id, 'renewed', 'Container recreado con nuevas credenciales');
    return (await this.refreshStatus(id)) ?? runner;
  },

  /**
   * Re-registra las credenciales de un runner:
   *   1) Stop + remove container (sin tocar el volumen)
   *   2) Borrar .runner y .credentials del volumen (con un container aux de alpine)
   *   3) Crear container de nuevo con el nuevo RUNNER_TOKEN
   *   4) Start
   *
   * Útil cuando GitHub borró la registration (típicamente porque el runner
   * quedó offline mucho tiempo) y el container está en loop de
   * "Failed to create a session. The runner registration has been deleted".
   */
  async renew(id: string, registrationToken?: string): Promise<Runner> {
    const runner = this.mustFind(id);
    const { containerName, volumeName, scope, target, labels } = runner;
    const runnerGroup = 'Default'; // se podría persistir en otra columna
    // La imagen es FIJA — siempre el default actual.
    const image = DEFAULT_IMAGE;

    // Auto-generar el token con el PAT del runner si no vino en el body.
    const token = await resolveRegistrationToken(
      registrationToken,
      runner.githubPatId,
      runner.scope,
      runner.targetSlug,
    );

    // 1) Stop (si está corriendo) y remove container
    try {
      await stopContainer(containerName, 10);
    } catch {
      // Si ya estaba stopped, ignorar
    }
    await removeContainer(containerName, true);
    RunnersRepo.addEvent(id, 'info', `Container removed para renew`);

    // 2) Borrar credenciales stale del volumen
    await wipeVolumeCredentials(volumeName);
    RunnersRepo.addEvent(id, 'info', `Credenciales stale borradas del volumen ${volumeName}`);

    // 3) Recrear container con nuevo token. Pull primero por si el user
    //    cambió la imagen en algún momento.
    await ensureImage(image);
    await createRunnerContainer({
      containerName,
      volumeName,
      image,
      name: runner.name,
      scope,
      target,
      labels,
      runnerGroup,
      registrationToken: token,
      restartPolicy: 'unless-stopped',
    });

    // 4) Start
    await startContainer(containerName);
    RunnersRepo.addEvent(id, 'renewed', 'Container recreado con nuevas credenciales');
    return (await this.refreshStatus(id)) ?? runner;
  },

  /**
   * Borra todo: container + volumen + registro en DB.
   * NO des-registra en GitHub (eso lo hace el entrypoint del container al
   * recibir SIGTERM, o el user manualmente). Sprint 4+ agregará un endpoint
   * para des-registrar vía API con PAT.
   */
  async delete(id: string): Promise<void> {
    const runner = this.mustFind(id);
    try {
      await stopContainer(runner.containerName, 10);
    } catch {
      // ignore
    }
    await removeContainer(runner.containerName, true);
    await removeVolume(runner.volumeName);
    RunnersRepo.addEvent(id, 'deleted', `Runner ${runner.name} borrado`);
    RunnersRepo.delete(id);
  },

  /**
   * Lee el estado actual del container en Docker y actualiza el status en DB.
   *
   * Importante: NO pisa `lastError` cuando el container no existe
   * (`info === null`). En ese caso preserva el error anterior (o setea
   * "Container X no existe" si no había uno). Esto evita que un refresh
   * borre el error real que dejó el create fallido, que es el que el user
   * necesita ver en el panel para entender qué pasó.
   */
  async refreshStatus(id: string): Promise<Runner | null> {
    const runner = RunnersRepo.findById(id);
    if (!runner) return null;
    const info = await inspectContainer(runner.containerName);
    const containerState = mapContainerState(info);
    const isRunning = containerState === 'running';
    const status = isRunning ? 'running' : containerState === 'exited' ? 'stopped' : runner.status;
    let nextError: string | null;
    if (info === null) {
      // Container no existe: preservamos el error anterior o seteamos uno nuevo.
      nextError = runner.lastError ?? `Container ${runner.containerName} no existe`;
    } else {
      // Container existe: refrescamos estado, limpiamos el error.
      nextError = null;
    }
    RunnersRepo.updateStatus(id, status, containerState, nextError);
    if (isRunning) {
      RunnersRepo.touchLastSeen(id);
    }
    return RunnersRepo.findById(id);
  },

  mustFind(id: string): Runner {
    const runner = RunnersRepo.findById(id);
    if (!runner) throw new Error(`Runner ${id} no existe`);
    return runner;
  },

  /**
   * Aplica un patch parcial al registro. No toca el container de Docker
   * (los cambios de imagen, labels, etc. recién aplican cuando se recree
   * el container con `/recreate` o `/renew`).
   *
   * Pensado para: cambiar la imagen default de un runner viejo a la
   * nueva wrapper, ajustar labels, cambiar el runner group, etc.
   */
  update(
    id: string,
    patch: {
      image?: string;
      labels?: string[];
      runnerGroup?: string;
      restartPolicy?: CreateRunnerRequest['restartPolicy'];
    },
  ): Runner {
    const runner = this.mustFind(id);
    if (patch.labels !== undefined) {
      if (patch.labels.length === 0) {
        throw new Error('labels no puede estar vacío');
      }
    }
    const updated = RunnersRepo.update(id, patch);
    if (!updated) throw new Error(`Runner ${id} desapareció durante update`);
    const fields = Object.keys(patch).join(', ');
    RunnersRepo.addEvent(id, 'info', `Actualizado: ${fields}`);
    // Si cambió la imagen, loguear el before/after para que quede en
    // el historial del runner.
    if (patch.image !== undefined && patch.image !== runner.image) {
      RunnersRepo.addEvent(
        id,
        'info',
        `Imagen cambiada: ${runner.image} → ${patch.image} (recrear container para que tome efecto)`,
      );
    }
    return updated;
  },
};

/**
 * Helper: borra .runner y .credentials de un volumen usando un container
 * auxiliar de alpine. Es la forma más portable (no depende de paths del host).
 */
async function wipeVolumeCredentials(volumeName: string): Promise<void> {
  const docker = getDocker();
  const container = await docker.createContainer({
    Image: 'alpine:latest',
    Cmd: ['sh', '-c', 'rm -f /home/runner/.runner /home/runner/.credentials && echo OK'],
    HostConfig: {
      AutoRemove: true,
      Binds: [`${volumeName}:/home/runner`],
    },
  });
  await container.start();
  // Esperamos a que termine (con timeout).
  await new Promise<void>((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Timeout borrando credenciales stale'));
      }
    }, 30_000);
    container.wait((err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Resuelve el registration token a usar para una operación:
 *   1) Si vino explícito en el body, ese.
 *   2) Si hay PAT asociado al runner, lo usa para generar uno con GitHub.
 *   3) Si no hay PAT, error claro.
 */
async function resolveRegistrationToken(
  explicitToken: string | undefined,
  githubPatId: string | null,
  scope: 'repo' | 'org',
  targetSlug: string,
): Promise<string> {
  if (explicitToken) return explicitToken;
  if (!githubPatId) {
    throw new Error(
      `No hay un GitHub PAT configurado para este runner. ` +
        'Agregá uno en Settings → GitHub PATs, o pasá `registrationToken` en el body.',
    );
  }
  const pat = RunnersRepo.findPatById(githubPatId);
  if (!pat) throw new Error(`GitHub PAT ${githubPatId} no existe`);
  const patToken = RunnersRepo.getPatToken(githubPatId);
  if (!patToken) {
    throw new Error(`No se pudo desencriptar el PAT ${githubPatId}`);
  }
  const token = await GitHubService.generateRunnerToken({
    token: patToken,
    scope,
    target: targetSlug,
  });
  RunnersRepo.touchPatUsed(githubPatId);
  return token;
}

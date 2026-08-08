import Dockerode from 'dockerode';
import { env } from '../env.js';
import { platform } from 'node:os';

/**
 * Cliente de Docker.
 * Detecta el socket según el OS:
 *   - macOS / Linux: /var/run/docker.sock
 *   - Windows: //./pipe/docker_engine
 * Si DOCKER_SOCKET está seteado en env, se usa ese.
 */

/**
 * Subset de los campos que usamos de `docker info`.
 * @types/dockerode tipa `info()` como `any`, así que definimos un tipo propio.
 */
export interface DockerSystemInfo {
  ServerVersion?: string;
  ApiVersion?: string;
  OperatingSystem?: string;
  Architecture?: string;
}

function defaultSocket(): string {
  if (env.DOCKER_SOCKET) return env.DOCKER_SOCKET;
  return platform() === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';
}

let _docker: Dockerode | null = null;

export function getDocker(): Dockerode {
  if (_docker) return _docker;
  _docker = new Dockerode({ socketPath: defaultSocket() });
  return _docker;
}

/**
 * Verifica que el daemon de Docker está accesible.
 * Devuelve info del daemon o null si no responde.
 */
export async function pingDocker(): Promise<DockerSystemInfo | null> {
  try {
    const info = (await getDocker().info()) as DockerSystemInfo;
    return info;
  } catch (err) {
    console.error('[docker] ping failed:', err);
    return null;
  }
}

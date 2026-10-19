import { Router, type Router as RouterType } from 'express';
import type { DockerInfo } from '@actions-self-hosted/shared';
import { pingDocker, getDocker } from '../docker/client.js';
import { RUNNER_IMAGE } from '../runner-image.js';

const router: RouterType = Router();

/**
 * GET /api/docker
 * Info del daemon de Docker: versión, OS, conteo de containers, y la imagen
 * del runner que usa la app (para que el panel no muestre un valor viejo).
 */
router.get('/', async (_req, res) => {
  const info = await pingDocker();
  if (!info) {
    const body: DockerInfo = {
      available: false,
      error: 'No se pudo conectar al daemon de Docker',
      runnerImage: RUNNER_IMAGE,
    };
    return res.status(503).json(body);
  }

  const containers = await getDocker().listContainers({ all: true });
  const running = containers.filter((c) => c.State === 'running').length;
  const stopped = containers.filter((c) => c.State === 'exited').length;

  const body: DockerInfo = {
    available: true,
    version: info.ServerVersion,
    apiVersion: info.ApiVersion,
    os: info.OperatingSystem,
    arch: info.Architecture,
    runnerImage: RUNNER_IMAGE,
    containers: {
      total: containers.length,
      running,
      stopped,
    },
  };
  res.json(body);
});

export default router;

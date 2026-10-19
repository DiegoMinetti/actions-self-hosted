import { env } from './env.js';

/**
 * Tag de la imagen del runner que usa la app.
 *
 * Es la fuente de verdad para "qué versión del runner corre". Se deriva de
 * `RUNNER_VERSION` (que es la variable que toca el operador) salvo que se
 * setee `RUNNER_IMAGE` a mano, que es el caso de uso para cuando la imagen
 * vive en un registry en vez de ser la local que construye compose.
 *
 * La imagen es un wrapper finito sobre la imagen OFICIAL de GitHub
 * (`ghcr.io/actions/actions-runner:<version>`) que le agrega el ENTRYPOINT
 * y el auto-configure que a la oficial le faltan. Ver
 * `docker/runner/Dockerfile.runner` para el detalle de por qué hace falta.
 */
export const RUNNER_IMAGE = env.RUNNER_IMAGE ?? `actions-self-hosted-runner:${env.RUNNER_VERSION}`;

/**
 * Imagen auxiliar para los containers de un solo uso (ej. borrar las
 * credenciales stale de un volumen). Va pineada a propósito: `alpine:latest`
 * hacía que cada `renew` dependiera de un pull de red.
 */
export const HELPER_IMAGE = 'alpine:3.20';

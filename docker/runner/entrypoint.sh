#!/usr/bin/env bash
# Entrypoint del container del runner.
#
# El `run.sh` oficial de la imagen `ghcr.io/actions/actions-runner:*` NO llama
# a `config.sh` automáticamente cuando recibe `RUNNER_TOKEN` por env. Solo
# invoca `Runner.Listener run`, que sin credenciales en disco falla con
# "Not configured" y entra en loop infinito.
#
# Este entrypoint es el que sí hace el flow completo:
#   1) Si hay `RUNNER_TOKEN` y NO existe `.credentials`, corre
#      `./config.sh --unattended --replace` con todas las env vars.
#      (Usamos `--replace` para que sobrescriba credenciales stale del
#      volumen cuando se reusa un volumen con `.credentials` viejo.)
#   2) Si ya hay `.credentials` (caso típico: container re-arrancado, el
#      volumen ya tiene credenciales), skipea el configure.
#   3) `exec /home/runner/run.sh "$@"` para que PID 1 sea el listener real
#      y las señales del daemon (SIGTERM, SIGINT) lleguen bien.
set -euo pipefail

cd /home/runner

# Solo configurar si hay token. Si no hay, asumimos que el container ya
# fue configurado en otro momento (caso de volúmenes pre-poblados).
if [[ -n "${RUNNER_TOKEN:-}" && ! -f .credentials ]]; then
  echo "[entrypoint] Configuring runner (RUNNER_NAME=${RUNNER_NAME})..."

  config_args=(
    --unattended
    --replace
    --name "${RUNNER_NAME:-$(hostname)}"
    --labels "${RUNNER_LABELS:-self-hosted,linux,x64}"
    --runnergroup "${RUNNER_GROUP:-Default}"
  )

  # Repo o org: una de las dos envs tiene que estar seteada
  if [[ -n "${RUNNER_REPO_URL:-}" ]]; then
    config_args+=(--url "${RUNNER_REPO_URL}" --token "${RUNNER_TOKEN}")
  elif [[ -n "${RUNNER_ORG_URL:-}" ]]; then
    config_args+=(--url "${RUNNER_ORG_URL}" --token "${RUNNER_TOKEN}")
  else
    echo "[entrypoint] ERROR: neither RUNNER_REPO_URL nor RUNNER_ORG_URL is set" >&2
    exit 1
  fi

  ./config.sh "${config_args[@]}"
  echo "[entrypoint] Runner configured OK"
elif [[ -f .credentials ]]; then
  echo "[entrypoint] .credentials ya existe en el volumen, skip configure"
else
  echo "[entrypoint] WARN: RUNNER_TOKEN no provisto y no hay .credentials. El listener va a fallar."
fi

exec /home/runner/run.sh "$@"

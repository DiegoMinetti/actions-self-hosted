#!/usr/bin/env bash
# =============================================================================
# Entrypoint del container del runner.
#
# Flujo de arranque:
#
#   1. Si el volumen persistente tiene credenciales (.credentials), se restauran
#      al work dir -> el listener arranca con la registration existente.
#   2. Si no hay credenciales, se corre `config.sh --unattended` con las env
#      vars (RUNNER_TOKEN + RUNNER_REPO_URL / RUNNER_ORG_URL) y después se
#      persisten al volumen.
#   3. Se ejecuta el listener oficial (`run.sh` -> `Runner.Listener run`).
#
# Layout (ver docker/runner/Dockerfile.runner para el porqué):
#   /home/runner  -> work dir EFÍMERO, viene de la imagen oficial.
#                    Acá viven los binarios: el tag de la imagen ES la
#                    versión real del runner.
#   /runner-data  -> volumen persistente con SOLO `.runner` y `.credentials`.
#                    Lo único que hay que preservar entre reinicios.
#
# POR QUÉ NO USAMOS `exec`:
# El runner refresca solo el token OAuth dentro de `.credentials`, así que
# hay que copiarlo al volumen periódicamente y también cuando el container
# para (SIGTERM). Con `exec` el shell desaparece y se pierde el trap, así que
# corremos `run.sh` en background y le reenviamos las señales.
# =============================================================================
set -uo pipefail

WORK_DIR="${RUNNER_WORK_DIR:-/home/runner}"
DATA_DIR="${RUNNER_DATA_DIR:-/runner-data}"
# Cada cuánto copiar las credenciales al volumen (el runner refresca el token).
PERSIST_INTERVAL="${RUNNER_CREDENTIALS_PERSIST_INTERVAL:-60}"

cd "$WORK_DIR" || exit 1

log() {
  echo "[entrypoint] $*"
}

# Archivos que el runner necesita conservar entre reinicios.
#
# NO son solo `.runner` y `.credentials`: el listener también necesita
# `.credentials_rsaparams` (la clave RSA que firma las requests de OAuth; sin
# ella el listener muere con "RSA key file ... was not found" y el runner
# queda offline), y `.env` / `.path` (los lee el `env.sh` de la distribución
# para armar el entorno del listener).
#
# OJO: el work dir es efímero (viene de la imagen), así que si alguno de
# estos no se persiste, el runner no puede autenticarse al reiniciar.
CREDENTIAL_FILES=(
  .runner
  .credentials
  .credentials_rsaparams
  .env
  .path
)

# Copia los archivos de credenciales del work dir al volumen persistente.
persist_credentials() {
  local f
  for f in "${CREDENTIAL_FILES[@]}"; do
    if [[ -f "$WORK_DIR/$f" ]]; then
      if ! cp -f "$WORK_DIR/$f" "$DATA_DIR/$f" 2>/dev/null; then
        log "WARN: no se pudo persistir '$f' al volumen $DATA_DIR"
      fi
    fi
  done
}

# Copia los archivos de credenciales del volumen persistente al work dir.
restore_credentials() {
  local f
  for f in "${CREDENTIAL_FILES[@]}"; do
    if [[ -f "$DATA_DIR/$f" ]]; then
      if ! cp -f "$DATA_DIR/$f" "$WORK_DIR/$f" 2>/dev/null; then
        log "WARN: no se pudo restaurar '$f' del volumen $DATA_DIR"
      fi
    fi
  done
}

configure_runner() {
  local config_args=(
    --unattended
    --replace
    --name "${RUNNER_NAME:-$(hostname)}"
    --labels "${RUNNER_LABELS:-self-hosted,linux,x64}"
    --runnergroup "${RUNNER_GROUP:-Default}"
  )

  # Repo u org: tiene que estar seteada una de las dos.
  if [[ -n "${RUNNER_REPO_URL:-}" ]]; then
    config_args+=(--url "${RUNNER_REPO_URL}" --token "${RUNNER_TOKEN}")
  elif [[ -n "${RUNNER_ORG_URL:-}" ]]; then
    config_args+=(--url "${RUNNER_ORG_URL}" --token "${RUNNER_TOKEN}")
  else
    log "ERROR: no está seteada RUNNER_REPO_URL ni RUNNER_ORG_URL"
    return 1
  fi

  log "Configurando runner (RUNNER_NAME=${RUNNER_NAME:-$(hostname)})..."
  ./config.sh "${config_args[@]}" || return 1
  log "Runner configurado OK"
}

# --- Startup ---------------------------------------------------------------

if [[ -f "$DATA_DIR/.credentials" ]]; then
  log "Credenciales restauradas del volumen $DATA_DIR"
  restore_credentials
else
  if [[ -z "${RUNNER_TOKEN:-}" ]]; then
    log "ERROR: no hay credenciales en el volumen ni RUNNER_TOKEN en el env"
    exit 1
  fi
  configure_runner || exit 1
  persist_credentials
fi
# El listener refresca el token OAuth dentro de `.credentials`. Sin esto, un
# restart volvería a usar el token viejo del volumen.
(
  while true; do
    sleep "$PERSIST_INTERVAL"
    persist_credentials
  done
) &
PERSIST_PID=$!

# `run.sh` en background (no exec) para poder persistir al recibir SIGTERM.
"$WORK_DIR/run.sh" "$@" &
RUNNER_PID=$!

shutdown() {
  log "Señal de cierre recibida, persistiendo credenciales..."
  persist_credentials
  kill -TERM "$RUNNER_PID" 2>/dev/null || true
}
trap shutdown TERM INT

STATUS=0
wait "$RUNNER_PID" || STATUS=$?
# Si una señal interrumpió el `wait`, el runner puede seguir vivo: esperamos.
while kill -0 "$RUNNER_PID" 2>/dev/null; do
  wait "$RUNNER_PID" || STATUS=$?
done

kill "$PERSIST_PID" 2>/dev/null || true
persist_credentials

log "El listener del runner terminó con código $STATUS"
exit "$STATUS"

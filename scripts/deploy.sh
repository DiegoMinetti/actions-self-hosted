#!/usr/bin/env bash
# =============================================================================
# Deploy completo de actions-self-hosted.
#
#   sudo ./scripts/deploy.sh            # build + deploy + migración (sin purgar)
#   sudo ./scripts/deploy.sh --purge    # además borra los volúmenes viejos
#
# Hace TODO el deploy en un solo comando:
#   1. Verifica los prerrequisitos (docker + compose)
#   2. Construye las dos imágenes (app + runner) y levanta el stack
#   3. Espera el healthcheck y valida la auth de la API
#   4. Migra los runners que siguen en el layout viejo de volúmenes
#   5. Verifica que los runners vuelven a estar online en GitHub
#   6. (--purge) Borra los volúmenes viejos y muestra el espacio liberado
#
# Corre como root porque hace falta acceso al socket de Docker.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 1 ;;
  esac
done

APP_URL="${APP_URL:-http://127.0.0.1:3000}"
ENV_FILE="$REPO_ROOT/.env"

log()  { echo; echo "==> $*"; }
warn() { echo "WARN: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# --- 0. prerrequisitos ------------------------------------------------------

log "Prerrequisitos"
command -v docker >/dev/null 2>&1 || die "falta docker"
command -v curl >/dev/null 2>&1 || die "falta curl"
command -v jq >/dev/null 2>&1 || die "falta jq (sudo apt install jq)"
docker compose version >/dev/null 2>&1 || die "falta docker compose"
docker info >/dev/null 2>&1 || die "no se puede hablar con el daemon de Docker (¿sudo?)"
echo "    docker: $(docker version --format '{{.Server.Version}}')  compose: $(docker compose version --short)"

[[ -f "$ENV_FILE" ]] || die "falta $ENV_FILE (copiá .env.example)"

# Leer el .env SIN sourcearlo: un password con espacios, # o $ rompería el
# shell. Con sed nos quedamos solo con el valor crudo.
env_value() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}
export PANEL_USER="$(env_value PANEL_USER)"
export PANEL_PASSWORD="$(env_value PANEL_PASSWORD)"
: "${PANEL_USER:?PANEL_USER no está en .env}"
: "${PANEL_PASSWORD:?PANEL_PASSWORD no está en .env}"
echo "    .env OK (RUNNER_VERSION=$(env_value RUNNER_VERSION))"

api_curl() {
  if [[ -n "${PANEL_PASSWORD:-}" ]]; then
    curl -sf -u "$PANEL_USER:$PANEL_PASSWORD" "$@"
  else
    curl -sf "$@"
  fi
}

# --- 1. build + deploy ------------------------------------------------------

log "Construyendo y levantando el stack"
docker compose up -d --build
docker compose ps

# --- 2. esperar el healthcheck ---------------------------------------------

log "Esperando el healthcheck"
for i in $(seq 1 30); do
  if curl -sf "$APP_URL/api/health" >/dev/null 2>&1; then
    echo "    API OK: $(curl -sf "$APP_URL/api/health")"
    break
  fi
  if [[ "$i" == "30" ]]; then
    docker compose logs --tail=40 app
    die "la API no levantó"
  fi
  sleep 2
done

# --- 3. validar la auth -----------------------------------------------------

log "Validando la auth"
code_sin=$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/api/runners")
code_con=$(curl -s -o /dev/null -w '%{http_code}' -u "$PANEL_USER:$PANEL_PASSWORD" "$APP_URL/api/runners")
echo "    /api/runners sin credenciales: $code_sin (esperado 401)"
echo "    /api/runners con credenciales: $code_con (esperado 200)"
[[ "$code_con" == "200" ]] || die "la API no acepta las credenciales del .env"
if [[ "$code_sin" != "401" ]]; then
  warn "/api/runners respondió $code_sin sin credenciales (la auth no está activa)"
fi

# --- 4. migrar los runners al layout nuevo ---------------------------------

log "Migración de volúmenes"
if "$SCRIPT_DIR/migrate-runner-volumes.sh"; then
  echo "    migración OK"
else
  die "la migración falló"
fi

# --- 5. verificar en GitHub -------------------------------------------------

log "Estado de los runners"
sleep 8
api_curl "$APP_URL/api/runners" | jq -r '.runners[] | "    \(.name): estado=\(.status) container=\(.containerState) imagen=\(.image) volumen=\(.volumeName) github=\(.githubStatus)"'

# --- 6. purgar los volúmenes viejos ----------------------------------------

if [[ "$PURGE" == "1" ]]; then
  log "Borrando los volúmenes viejos"
  for vol in $(docker volume ls --format '{{.Name}}' | grep -E '^actions-runner-.*-home$' || true); do
    if docker volume rm "$vol" >/dev/null 2>&1; then
      echo "    borrado $vol"
    else
      warn "no se pudo borrar $vol (¿lo está usando un container?)"
    fi
  done
  docker system df | head -5
fi

log "Listo"
echo "    Panel: $APP_URL (usuario '$PANEL_USER')"
echo "    Ver estado: docker compose ps"
echo "    Ver logs:   docker compose logs -f app"

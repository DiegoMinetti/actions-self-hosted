#!/usr/bin/env bash
# =============================================================================
# Migración de los runners del layout viejo al layout nuevo.
#
# LAYOUT VIEJO: el volumen persistente se montaba en /home/runner, que es
# justo donde la imagen oficial guarda bin/, externals/, config.sh y run.sh.
# Docker siembra un volumen nombrado desde la imagen SOLO cuando está vacío,
# así que el volumen terminaba pisando la distribución oficial y el container
# quedaba congelado en la versión con la que se creó el volumen. El tag de la
# imagen era cosmético y "Recreate" no actualizaba el runner.
#
# LAYOUT NUEVO: la distribución viene de la imagen (efímera, en /home/runner) y
# el volumen se monta en /runner-data guardando SOLO .runner y .credentials.
# El tag ES la versión real del runner.
#
# QUÉ HACE ESTE SCRIPT (por cada runner con el layout viejo):
#   1. Crea el volumen nuevo  actions-runner-<name>-data
#   2. Copia .runner y .credentials del volumen viejo al nuevo
#   3. Deja el volumen nuevo escribible por el uid 1001 (el user `runner`)
#   4. Actualiza volume_name e image en la DB de la app
#   5. Llama a POST /api/runners/:id/recreate → el container se recrea con la
#      imagen nueva y el volumen nuevo
#
# El volumen viejo NO se borra (queda por si hay que volver atrás). Para
# borrarlo al final, pasá --purge.
#
# USO:
#   ./scripts/migrate-runner-volumes.sh
#   ./scripts/migrate-runner-volumes.sh --purge
#
# VARIABLES DE ENTORNO:
#   APP_URL          default http://127.0.0.1:3000
#   PANEL_USER       default admin
#   PANEL_PASSWORD   (obligatoria si la auth está habilitada)
#   APP_CONTAINER    default actions-self-hosted
#   DOCKER           default docker (o "sudo -n docker" si hace falta sudo)
#   RUNNER_IMAGE     default: la que reporta la propia app en /api/docker
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"

# El puerto del panel sale del .env (PANEL_PORT), no está fijo: si el panel
# está en otro puerto, la API no responde en 3000 y la migración falla con
# "no responde la API".
PANEL_PORT="$(sed -n 's/^PANEL_PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n 1 | tr -d '[:space:]')"
PANEL_PORT="${PANEL_PORT:-3000}"

APP_URL="${APP_URL:-http://127.0.0.1:$PANEL_PORT}"
PANEL_USER="${PANEL_USER:-admin}"
APP_CONTAINER="${APP_CONTAINER:-actions-self-hosted}"
DOCKER_CMD="${DOCKER:-docker}"
PURGE=0

for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 1 ;;
  esac
done

log()  { echo "==> $*"; }
warn() { echo "WARN: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# --- auth -------------------------------------------------------------------
# La API puede estar sin auth (dev) o con Basic Auth (prod).
api_curl() {
  if [[ -n "${PANEL_PASSWORD:-}" ]]; then
    curl -sf -u "$PANEL_USER:$PANEL_PASSWORD" "$@"
  else
    curl -sf "$@"
  fi
}

command -v jq >/dev/null 2>&1 || die "falta jq"
command -v curl >/dev/null 2>&1 || die "falta curl"

log "API: $APP_URL"
health=$(api_curl "$APP_URL/api/health") || die "no responde la API en $APP_URL"
echo "    $health"

# La imagen la usa la app; la leemos de la API para no hardcodearla.
RUNNER_IMAGE="${RUNNER_IMAGE:-$(api_curl "$APP_URL/api/docker" | jq -r '.runnerImage // empty')}"
[[ -n "$RUNNER_IMAGE" ]] || die "no pude resolver la imagen del runner (/api/docker -> runnerImage)"
log "Imagen del runner: $RUNNER_IMAGE"

# --- helpers ----------------------------------------------------------------

# Nombre del volumen para un runner dado. Tiene que coincidir con la
# convención del código (apps/api/src/services/runner-service.ts).
volume_name_for() { echo "actions-runner-$1-data"; }

# ¿El container ya monta el volumen en /runner-data (layout nuevo)?
uses_new_layout() {
  local container="$1"
  $DOCKER_CMD inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' "$container" 2>/dev/null \
    | grep -q '/runner-data'
}

# Copia .runner y .credentials del volumen viejo al nuevo y deja el root del
# volumen nuevo escribible por el uid 1001 (el user `runner` de la imagen).
copy_credentials() {
  local old_vol="$1" new_vol="$2"
  $DOCKER_CMD volume create "$new_vol" >/dev/null
  # alpine puede no estar en el daemon: `docker run` no hace pull automático.
  $DOCKER_CMD pull alpine:3.20 >/dev/null 2>&1 || true
  $DOCKER_CMD run --rm \
    -v "$old_vol":/src:ro \
    -v "$new_vol":/dst \
    --entrypoint /bin/sh \
    alpine:3.20 -c '
      set -e
      for f in .runner .credentials; do
        if [ -f "/src/$f" ]; then cp -p "/src/$f" "/dst/$f"; fi
      done
      # el volumen nuevo no se siembra desde la imagen (ya tiene contenido),
      # así que el root queda root:root 0755 y el uid 1001 no puede escribir.
      chmod 0777 /dst
      ls -la /dst
    '
}

# Actualiza volume_name e image en la DB de la app.
# Usa el DB_PATH del container (no hardcodeado) por si cambia.
update_db() {
  local runner_id="$1" new_vol="$2" image="$3"
  $DOCKER_CMD exec "$APP_CONTAINER" node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB_PATH || '/app/data/runners.db');
const r = db.prepare('UPDATE runners SET volume_name = ?, image = ? WHERE id = ?')
  .run(process.argv[1], process.argv[2], process.argv[3]);
console.log('  DB: ' + JSON.stringify(r));
db.close();
" "$new_vol" "$image" "$runner_id"
}

# --- migración --------------------------------------------------------------

runners=$(api_curl "$APP_URL/api/runners" | jq -c '.runners[]')
expected_count=$(printf '%s\n' "$runners" | grep -c . || true)
if [[ "$expected_count" -eq 0 ]]; then
  # Instalación nueva: no hay nada que migrar. No es un error.
  log "No hay runners registrados, no hay nada que migrar"
  exit 0
fi

migrated=()
skipped=()
processed=0

# OJO: con `done <<< "$runners"` (herestring) bash crea un temp file, y en
# entornos restringidos eso falla. Peor: el fallo era SILENCIOSO (la redirección
# del while falla, el cuerpo nunca corre y el script termina con 0 sin haber
# migrado nada). Con process substitution (`< <(...)`) se usa una FIFO, que no
# necesita temp file, y el loop corre en el shell actual (así el array
# `migrated` persiste).
while IFS= read -r runner; do
  [[ -n "$runner" ]] || continue
  processed=$((processed + 1))
  name=$(echo "$runner" | jq -r '.name')
  id=$(echo "$runner" | jq -r '.id')
  old_vol=$(echo "$runner" | jq -r '.volumeName')
  old_image=$(echo "$runner" | jq -r '.image')
  container=$(echo "$runner" | jq -r '.containerName')
  new_vol=$(volume_name_for "$name")

  if uses_new_layout "$container"; then
    log "$name: ya está en el layout nuevo, se saltea"
    skipped+=("$name")
    continue
  fi

  log "$name: migrando"
  echo "    volumen viejo: $old_vol"
  echo "    volumen nuevo: $new_vol"

  copy_credentials "$old_vol" "$new_vol"
  update_db "$id" "$new_vol" "$RUNNER_IMAGE"

  log "$name: recreando el container"
  # Si el recreate falla, la DB quedaría apuntando al volumen nuevo mientras
  # el container sigue usando el viejo. Revertimos la DB para que el runner
  # quede consistente y operativo, y no lo migramos.
  #
  # MIGRATION_TOKEN: si se setea, se pasa como registrationToken explícito.
  # Útil cuando el PAT de la app está vencido pero tenés un token fresco a
  # mano. Si no se setea, la app lo genera sola con el PAT del runner.
  if [[ -n "${MIGRATION_TOKEN:-}" ]]; then
    recreate_body="{\"registrationToken\":\"${MIGRATION_TOKEN}\"}"
  else
    recreate_body='{}'
  fi
  if ! api_curl -X POST "$APP_URL/api/runners/$id/recreate" -H 'Content-Type: application/json' -d "$recreate_body" \
    | jq -c '{name, status, containerState, image, volumeName, lastError}'; then
    warn "$name: el recreate falló, revirtiendo volume_name/image en la DB"
    update_db "$id" "$old_vol" "$old_image"
    $DOCKER_CMD volume rm "$new_vol" >/dev/null 2>&1 || true
    die "la migración de $name falló y se revirtió. Revisar los logs de la app."
  fi

  migrated+=("$name:$old_vol")
done < <(printf '%s\n' "$runners")

# Guard: si la API devolvió runners pero no procesamos ninguno, algo falló
# en silencio. Es mejor abortar que terminar con 0 sin haber migrado nada.
if [[ "$processed" -ne "$expected_count" ]]; then
  die "se esperaban $expected_count runners y se procesaron $processed. Abortando sin migrar."
fi
log "Procesados $processed runners ($((expected_count - processed)) sin cambios)"

# --- verificación -----------------------------------------------------------

log "Verificando"
sleep 5
api_curl "$APP_URL/api/runners" | jq -r '.runners[] | "    \(.name): estado=\(.status) container=\(.containerState) imagen=\(.image) volumen=\(.volumeName) gitHub=\(.githubStatus)"'

if [[ "$PURGE" == "1" ]]; then
  for entry in "${migrated[@]:-}"; do
    [[ -n "$entry" ]] || continue
    name="${entry%%:*}"
    old_vol="${entry##*:}"
    log "$name: borrando el volumen viejo $old_vol"
    $DOCKER_CMD volume rm "$old_vol" || warn "no se pudo borrar $old_vol"
  done
else
  log "Volúmenes viejos conservados (pasá --purge para borrarlos):"
  for entry in "${migrated[@]:-}"; do
    [[ -n "$entry" ]] || continue
    echo "    ${entry##*:}"
  done
fi

log "Listo"

#!/usr/bin/env bash
# =============================================================================
# Destraba flserver y deja el servicio desplegado, en UN solo comando.
#
#   sudo ./scripts/unblock-flserver.sh
#
# Hace:
#   1) Regla de sudoers para docker y tailscale (pide el password UNA vez).
#      El socket de Docker está en GID 0 a propósito —para que los runners
#      1001:0 puedan usar el daemon—, por eso el grupo `docker` NO da acceso.
#   2) Tailscale operator: permite administrar el serve config sin sudo, que
#      es lo que publica el panel en http://flserver:<PANEL_PORT>.
#   3) Deploy completo: build de las dos imágenes, stack, healthcheck, auth,
#      migración de los runners al layout nuevo de volúmenes, publicación en
#      Tailscale y verificación.
#
# Opciones:
#   --no-deploy   solo destraba, sin desplegar
#   --purge       además borra los volúmenes viejos de los runners
#
# Es idempotente: se puede volver a correr sin romper nada.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

DO_DEPLOY=1
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --no-deploy) DO_DEPLOY=0 ;;
    --purge) PURGE=1 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 1 ;;
  esac
done

log()  { echo; echo "==> $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# --- 1. sudoers -------------------------------------------------------------

log "1/3 Configurando sudoers para docker y tailscale"
if sudo -n true 2>/dev/null; then
  echo "    ya hay sudo sin password"
else
  echo "    (te va a pedir el password de sudo)"
fi
echo 'flserver ALL=(root) NOPASSWD: /usr/bin/docker, /usr/bin/docker *, /usr/bin/tailscale, /usr/bin/tailscale *' \
  | sudo tee /etc/sudoers.d/docker-nopasswd >/dev/null
sudo chmod 440 /etc/sudoers.d/docker-nopasswd
sudo visudo -c | tail -1
echo "    regla instalada"

# --- 2. tailscale operator --------------------------------------------------

log "2/3 Configurando Tailscale operator"
if sudo tailscale set --operator=flserver 2>&1 | head -3; then
  echo "    operator configurado"
else
  echo "    (no se pudo configurar el operator; el panel va a quedar en 127.0.0.1)"
fi

# --- 3. deploy --------------------------------------------------------------

if [[ "$DO_DEPLOY" == "0" ]]; then
  log "Solo destrabado. Para desplegar: sudo ./scripts/deploy.sh"
  exit 0
fi

log "3/3 Desplegando"
if [[ "$PURGE" == "1" ]]; then
  sudo -n ./scripts/deploy.sh --purge
else
  sudo -n ./scripts/deploy.sh
fi

log "Listo"
echo "    Panel:  http://flserver:$(grep -E '^PANEL_PORT=' .env | cut -d= -f2)"
echo "    Estado: cd ~/apps/actions-self-hosted && sudo docker compose ps"

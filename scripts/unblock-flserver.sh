#!/usr/bin/env bash
# Un solo comando para destrabar TODO lo pendiente en flserver:
#
#   1) Regla de sudoers: operar Docker y Tailscale sin password.
#      El socket de Docker está en GID 0 a propósito (para que los runners
#      1001:0 puedan usar el daemon), por eso el grupo `docker` NO sirve:
#      hace falta sudoers.
#   2) Tailscale operator: permite administrar el serve config sin sudo,
#      que es lo que habilita publicar el panel en http://flserver:3000.
#
# Es idempotente: se puede volver a correr sin romper nada.
set -euo pipefail

echo 'flserver ALL=(root) NOPASSWD: /usr/bin/docker, /usr/bin/docker *, /usr/bin/tailscale, /usr/bin/tailscale *' \
  | sudo tee /etc/sudoers.d/docker-nopasswd >/dev/null
sudo chmod 440 /etc/sudoers.d/docker-nopasswd
sudo visudo -c

sudo tailscale set --operator=flserver

echo
echo "OK. Verificaciones:"
sudo -n docker version --format '    docker server: {{.Server.Version}}'
sudo -n tailscale serve status 2>&1 | head -5
echo
echo "Ahora se puede correr:  sudo -n ./scripts/deploy.sh"

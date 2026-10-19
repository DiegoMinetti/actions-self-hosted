#!/usr/bin/env bash
# Build de la imagen del runner, para cuando no querés usar compose.
#
# En el deploy normal NO hace falta: `docker compose up -d --build` ya
# construye la imagen `runner-image` y la deja lista para que la app la use.
# Este script queda para builds manuales (por ejemplo para publicarla en un
# registry y que la app la baje con RUNNER_IMAGE).
#
# La imagen es un wrapper FINITO sobre la oficial de GitHub
# (`ghcr.io/actions/actions-runner:<version>`). Ver el Dockerfile para el
# porqué de cada cosa.
#
# Uso:
#   ./build.sh                       # usa RUNNER_VERSION del .env (o 2.338.0)
#   ./build.sh 2.338.0               # versión explícita
#   ./build.sh 2.338.0 --no-cache    # build limpio (sin cache de layers)
#
# Multi-arch: el `FROM ghcr.io/actions/actions-runner:${RUNNER_VERSION}`
# resuelve solo a linux/amd64 o linux/arm64 según el host del build. Para
# publicar una imagen multi-plataforma desde un Mac M1:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     --build-arg RUNNER_VERSION=2.338.0 \
#     -t <registry>/<repo>:2.338.0 --push docker/runner
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Versión por defecto: la del .env del repo (fuente de verdad), o 2.338.0.
DEFAULT_VERSION="$(grep -E '^RUNNER_VERSION=' "$REPO_ROOT/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
DEFAULT_VERSION="${DEFAULT_VERSION:-2.338.0}"

RUNNER_VERSION="${1:-$DEFAULT_VERSION}"
shift || true

if ! [[ "$RUNNER_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ Error: versión inválida '$RUNNER_VERSION' (esperado X.Y.Z, ej. 2.338.0)" >&2
  echo "   $0 2.338.0" >&2
  exit 1
fi

IMAGE_TAG="actions-self-hosted-runner:${RUNNER_VERSION}"

# Validación contra el registry de GHCR. Cuesta ~1s y evita gastar
# 4-5s en un build que va a fallar. Si python3 no está disponible,
# seguimos adelante (el build va a fallar igual, con el error original).
if command -v python3 >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  echo "🔍 Verificando que la versión exista en ghcr.io/actions/actions-runner..."
  GHCR_TOKEN=$(curl -fsS 'https://ghcr.io/token?scope=repository:actions/actions-runner:pull' \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)

  if [[ -n "${GHCR_TOKEN:-}" ]]; then
    EXISTING_TAGS=$(curl -fsS \
      -H "Authorization: Bearer $GHCR_TOKEN" \
      'https://ghcr.io/v2/actions/actions-runner/tags/list' \
      | python3 -c 'import sys,json; print(",".join(json.load(sys.stdin).get("tags", [])))' 2>/dev/null)
  fi

  if [[ -n "${EXISTING_TAGS:-}" ]]; then
    if ! [[ ",$EXISTING_TAGS," == *",$RUNNER_VERSION,"* ]]; then
      LATEST=$(echo "$EXISTING_TAGS" | tr ',' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -3 | tr '\n' ' ')
      echo "" >&2
      echo "❌ Error: la versión '$RUNNER_VERSION' NO existe en ghcr.io/actions/actions-runner" >&2
      echo "   Últimas versiones disponibles: $LATEST" >&2
      echo "   Listado completo: https://github.com/actions/runner/releases" >&2
      exit 1
    fi
    echo "   ✓ Versión confirmada en el registry"
  else
    echo "   ⚠️  No pude verificar contra el registry, sigo con el build."
  fi
  echo ""
fi

echo "🐳 Buildeando la imagen del runner"
echo "   Versión base: $RUNNER_VERSION"
echo "   Tag destino:  $IMAGE_TAG"
echo "   Contexto:     $SCRIPT_DIR"
echo ""

docker build \
  -f "$SCRIPT_DIR/Dockerfile.runner" \
  --build-arg "RUNNER_VERSION=$RUNNER_VERSION" \
  -t "$IMAGE_TAG" \
  "$@" \
  "$SCRIPT_DIR"

echo ""
echo "✅ Imagen $IMAGE_TAG buildeada OK"
echo ""
echo "Para usarla desde compose, actualizá RUNNER_VERSION en .env y corré:"
echo "  docker compose up -d --build"

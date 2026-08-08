#!/usr/bin/env bash
# Build de la imagen wrapper del runner.
#
# Por qué existe este script:
# La imagen oficial `ghcr.io/actions/actions-runner:*` dejó de traer ENTRYPOINT
# en versiones recientes, lo que rompía el arranque del listener cuando se
# creaba el container. El wrapper en `docker/runner/` (Dockerfile.runner +
# entrypoint.sh) agrega el ENTRYPOINT + auto-configure que faltan.
#
# Uso:
#   ./build.sh 2.336.0                       # build normal
#   ./build.sh 2.336.0 --no-cache            # build limpio (sin cache de layers)
#   RUNNER_VERSION=2.336.0 ./build.sh        # equivalente
#
# Después de buildear:
#   1) Actualizar DEFAULT_IMAGE en apps/api/src/services/runner-service.ts
#      al nuevo tag (ej. 'actions-runner:2.337.0').
#   2) Actualizar el comentario JSDoc de `image` en packages/shared/src/index.ts.
#   3) Rebuild de la app: docker compose up -d --build
#   4) Recrear runners existentes (botón "Recreate" en el panel, o /recreate
#      via API). El volumen mantiene las credenciales.
#
# Multi-arch: el `FROM ghcr.io/actions/actions-runner:${RUNNER_VERSION}` resuelve
# automáticamente a linux/amd64 o linux/arm64 según la arquitectura del host
# que hace el build. Para builds multi-plataforma (ej. publicar a un registry
# desde un Mac M1 pero querer también amd64), usar buildx:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     --build-arg RUNNER_VERSION=2.336.0 \
#     -t actions-runner:2.336.0 --load docker/runner
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Args: <version> [extra docker build args...]
if [[ $# -lt 1 ]]; then
  echo "Uso: $0 <runner-version> [--no-cache]"
  echo "  runner-version: ej. 2.336.0"
  echo "  --no-cache: fuerza build sin usar cache de layers"
  echo ""
  echo "Alternativa por env var:"
  echo "  RUNNER_VERSION=2.336.0 $0"
  exit 1
fi

RUNNER_VERSION="${1:-${RUNNER_VERSION:-}}"
shift || true

if [[ -z "$RUNNER_VERSION" ]]; then
  echo "❌ Error: tenés que pasar la versión del runner" >&2
  echo "   $0 2.336.0" >&2
  exit 1
fi

# Validación rápida del formato de versión (X.Y.Z)
if ! [[ "$RUNNER_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ Error: versión inválida '$RUNNER_VERSION' (esperado formato X.Y.Z, ej. 2.336.0)" >&2
  exit 1
fi

# Validación contra el registry de GHCR. Cuesta ~1s y evita gastar
# 4-5s en un build que va a fallar. Si python3 no está disponible,
# seguimos adelante (el build va a fallar igual, pero con el error
# original de Docker).
if command -v python3 >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  echo "🔍 Verificando que la versión exista en ghcr.io/actions/actions-runner..."

  # Token anónimo de GHCR (lectura pública). La forma más portable es
  # extraer el token con un script python via stdin, sin comillas internas
  # que se enreden con bash.
  GHCR_TOKEN=$(curl -fsS 'https://ghcr.io/token?scope=repository:actions/actions-runner:pull' \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)

  if [[ -n "$GHCR_TOKEN" ]]; then
    EXISTING_TAGS=$(curl -fsS \
      -H "Authorization: Bearer $GHCR_TOKEN" \
      'https://ghcr.io/v2/actions/actions-runner/tags/list' \
      | python3 -c 'import sys,json; print(",".join(json.load(sys.stdin).get("tags", [])))' 2>/dev/null)
  fi

  if [[ -n "${EXISTING_TAGS:-}" ]]; then
    if ! [[ ",$EXISTING_TAGS," == *",$RUNNER_VERSION,"* ]]; then
      # Sugerir las 3 últimas versiones X.Y.Z (ignoramos tags sha256-* y 'latest')
      LATEST=$(echo "$EXISTING_TAGS" | tr ',' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -3 | tr '\n' ' ')
      echo ""
      echo "❌ Error: la versión '$RUNNER_VERSION' NO existe en ghcr.io/actions/actions-runner" >&2
      echo "   Últimas versiones disponibles: $LATEST" >&2
      echo "   (también podés usar 'latest', pero no es reproducible entre builds)" >&2
      echo "   Para ver el listado completo:" >&2
      echo "     https://github.com/actions/runner/releases" >&2
      exit 1
    fi
    echo "   ✓ Versión confirmada en el registry"
  else
    echo "   ⚠️  No pude verificar contra el registry (curl/python3 fallaron),"
    echo "      sigo con el build. Si falla, fijate que la versión exista en"
    echo "      https://github.com/actions/runner/releases"
  fi
  echo ""
fi

EXTRA_ARGS=("$@")
IMAGE_TAG="actions-runner:${RUNNER_VERSION}"

# Para que `set -u` no se queje con array vacío, mostramos string
# o "(ninguno)" según corresponda.
if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  EXTRA_ARGS_STR="${EXTRA_ARGS[*]}"
else
  EXTRA_ARGS_STR="(ninguno)"
fi

echo "🐳 Buildeando imagen wrapper del runner"
echo "   Versión base:   $RUNNER_VERSION"
echo "   Tag destino:    $IMAGE_TAG"
echo "   Contexto:       $SCRIPT_DIR"
echo "   Args extra:     $EXTRA_ARGS_STR"
echo ""

# `${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}` es el truco POSIX para expandir un
# array solo si existe (compatible con set -u y arrays vacíos).
docker build \
  -f "$SCRIPT_DIR/Dockerfile.runner" \
  --build-arg "RUNNER_VERSION=$RUNNER_VERSION" \
  -t "$IMAGE_TAG" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} \
  "$SCRIPT_DIR"

echo ""
echo "✅ Imagen $IMAGE_TAG buildeada OK"
echo ""
echo "Próximos pasos:"
echo "  1. Actualizar DEFAULT_IMAGE en apps/api/src/services/runner-service.ts a '$IMAGE_TAG'"
echo "  2. Rebuild de la app: docker compose up -d --build"
echo "  3. Recrear runners existentes con el botón 'Recreate' del panel"

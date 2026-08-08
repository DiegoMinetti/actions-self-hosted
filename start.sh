#!/usr/bin/env bash
# Arranca API + Web en paralelo para desarrollo (macOS / Linux).
# Requisitos: Node 20+, pnpm 9+, Docker (opcional, solo Sprint 1+).

set -euo pipefail

# Posicionarse en la raíz del repo (donde está este script).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Cargar .env si existe (las apps también lo cargan, esto es solo para información).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "🟢 Actions Self-Hosted · dev mode"
echo "   API → http://localhost:${API_PORT:-3000}"
echo "   Web → http://localhost:${WEB_PORT:-5173}"
echo

# Verificar pnpm.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "❌ pnpm no está instalado. Instalalo con: npm i -g pnpm"
  exit 1
fi

# Instalar deps si hace falta.
if [ ! -d node_modules ]; then
  echo "📦 Instalando dependencias (pnpm install)..."
  pnpm install
fi

# Levantar API + Web en paralelo.
pnpm dev

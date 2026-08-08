# Arranca API + Web en paralelo para desarrollo (Windows / PowerShell).
# Requisitos: Node 20+, pnpm 9+, Docker Desktop (opcional, solo Sprint 1+).

$ErrorActionPreference = 'Stop'

# Posicionarse en la raíz del repo (donde está este script).
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

# Cargar .env si existe.
if (Test-Path '.env') {
  Get-Content '.env' | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
      $name = $matches[1].Trim()
      $value = $matches[2].Trim()
      Set-Item -Path "Env:$name" -Value $value
    }
  }
}

$apiPort = if ($env:API_PORT) { $env:API_PORT } else { '3000' }
$webPort = if ($env:WEB_PORT) { $env:WEB_PORT } else { '5173' }

Write-Host "🟢 Actions Self-Hosted · dev mode" -ForegroundColor Green
Write-Host "   API → http://localhost:$apiPort"
Write-Host "   Web → http://localhost:$webPort"
Write-Host ""

# Verificar pnpm.
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "❌ pnpm no está instalado. Instalalo con: npm i -g pnpm" -ForegroundColor Red
  exit 1
}

# Instalar deps si hace falta.
if (-not (Test-Path 'node_modules')) {
  Write-Host "📦 Instalando dependencias (pnpm install)..." -ForegroundColor Yellow
  pnpm install
}

# Levantar API + Web en paralelo.
pnpm dev

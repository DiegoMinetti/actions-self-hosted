# Actions Self-Hosted

Panel local para gestionar N runners self-hosted de GitHub Actions. Pensado para
desarrollo: corrés la app en tu máquina y manejás todos los runners de tus
proyectos desde un solo lugar.

**Estado**: Sprint 0 — bootstrap. Solo health check. Sprint 1+ agrega CRUD real.

## Stack

- **Backend**: Node 20 + Express 4 + TypeScript + better-sqlite3 + dockerode
- **Frontend**: React 18 + Vite 5 + TanStack Query + Tailwind
- **Shared**: tipos compartidos en `packages/shared` (pnpm workspace)
- **DB**: SQLite local en `data/runners.db` (un solo archivo, cero infra)
- **Docker**: integración vía Dockerode (engine API), sin Docker-in-Docker

## Plataformas soportadas

| Plataforma  | Soporte       | Cómo                                                    |
| ----------- | ------------- | ------------------------------------------------------- |
| Linux/x64   | ✅ Containers | Imagen wrapper local `actions-runner:X.Y.Z`             |
| Linux/arm64 | ✅ Containers | Mismo wrapper, multi-arch (resuelve al build)           |
| macOS       | ⏳ Roadmap    | Hoy los runners de Mac se gestionan fuera de la app     |
| Windows     | ⏳ Roadmap    | Hoy los runners de Windows se gestionan fuera de la app |

**Hoy**: la app solo gestiona runners como **containers Docker Linux**. Para runners en
Mac o Windows, los corrés como procesos nativos en el host (binario `actions-runner`
de los releases oficiales) y los manejás por tu cuenta. Cuando estén listos los
agentes multi-host (Sprint 6+), el panel va a poder gestionar esos runners también.

## Requisitos

- Node 20+
- pnpm 9+ (`npm i -g pnpm`)
- Docker (Mac/Windows: Docker Desktop; Linux: dockerd + compose)
  - Requerido desde Sprint 1 en adelante

## Arranque rápido

### macOS / Linux

```bash
./start.sh
```

### Windows (PowerShell)

```powershell
.\start.ps1
```

### Manual (cualquier OS)

```bash
pnpm install
pnpm dev
```

Esto levanta en paralelo:

- **API** en `http://localhost:3000` (health: `/health` y `/api/health`)
- **Web** en `http://localhost:5173` (con proxy a `/api` → API)

Abrí `http://localhost:5173` y deberías ver "API OK" con la versión y el uptime.

### Opción Docker (opcional)

Si preferís correr todo containerizado en dev:

```bash
docker compose -f docker-compose.dev.yml up --build -d
```

> ⚠️ El bind del socket Docker (`/var/run/docker.sock`) asume host Mac/Linux.
> En Windows hay que ajustar la ruta del socket (ver `docker-compose.dev.yml`).

## Estructura

```
ActionsSelfHosted/
├── apps/
│   ├── api/         # Express + TS + SQLite + Dockerode
│   │   ├── src/
│   │   │   ├── server.ts        # entrypoint
│   │   │   ├── env.ts           # validación de env con Zod
│   │   │   └── routes/health.ts # GET /api/health
│   │   └── Dockerfile.dev
│   └── web/         # React + Vite + Tailwind
│       ├── src/
│       │   ├── App.tsx
│       │   ├── main.tsx
│       │   └── lib/api.ts
│       └── Dockerfile.dev
├── packages/
│   └── shared/      # tipos compartidos API ↔ Web
├── data/            # SQLite (gitignored)
├── start.sh         # bootstrap macOS/Linux
├── start.ps1        # bootstrap Windows
├── docker-compose.dev.yml
└── package.json     # pnpm workspace root
```

## Configuración

Copiá `.env.example` a `.env` y ajustá:

```bash
cp .env.example .env
```

Variables principales:

| Variable        | Default                 | Descripción                        |
| --------------- | ----------------------- | ---------------------------------- |
| `API_PORT`      | `3000`                  | Puerto del backend                 |
| `WEB_PORT`      | `5173`                  | Puerto del Vite dev server         |
| `CORS_ORIGIN`   | `http://localhost:5173` | Origen permitido para CORS         |
| `DB_PATH`       | `data/runners.db`       | Path al archivo SQLite             |
| `DOCKER_SOCKET` | autodetect              | Socket Docker (vacío = autodetect) |

## Scripts útiles

```bash
pnpm dev            # API + Web en paralelo
pnpm build          # build de prod
pnpm typecheck      # typecheck de todo el monorepo
pnpm format         # prettier --write
pnpm format:check   # prettier --check
pnpm lint           # placeholder (linter en sprint posterior)
```

Por paquete:

```bash
pnpm --filter @actions-self-hosted/api dev
pnpm --filter @actions-self-hosted/web dev
pnpm --filter @actions-self-hosted/api typecheck
```

## Setup de GitHub PATs

La app necesita **GitHub Personal Access Tokens** para:

1. **Generar registration tokens** automáticamente al crear/recrear/renovar runners (sin que tengas que pegarlos a mano).
2. **Consultar el estado de cada runner** en GitHub (`idle` / `busy` / `offline`) y reflejarlo en el panel.

Los PATs se guardan en la DB **encriptados con AES-256-GCM** y nunca se exponen al front. Podés tener N PATs (multi-cuenta, multi-org) y la app los matchea automáticamente con el `target` del runner.

### 1. Generar el master key de encryption (prod)

En producción, la app necesita una master key fija para no perder los PATs al reiniciar. Generá una con:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Pegá el output en tu `.env` (o donde pases envs al container):

```
APP_ENCRYPTION_KEY=<64-chars-hex>
```

En dev podés dejarla vacía — la app genera una en memoria al arranque y loggea un warning.

### 2. Crear un GitHub PAT

1. Andá a https://github.com/settings/personal-access-tokens/new
2. **Name**: `actions-self-hosted-panel` (o lo que quieras)
3. **Expiration**: 90 días (GitHub pide expiración; configurate un recordatorio para renovarlo)
4. **Scopes** (classic PAT): `repo` (Full control of private repos)
   - Si vas a gestionar runners de **una org**, también `admin:org:read` o `read:org` (para listar members/repos de la org)
5. Click **Generate token** → copialo (empieza con `ghp_...`, se muestra una sola vez)

### 3. Agregar el PAT al panel

1. En el panel, click **⚙ Settings** (esquina superior derecha)
2. Sección **GitHub PATs** → **+ Agregar PAT**
3. Completá:
   - **Nombre**: `Personal` o `Org MisNumeros` (lo que prefieras)
   - **Token**: pegá el `ghp_...` que generaste
   - **Tipo**: Personal (para user) u Organización
   - **Owner login** (si es personal): tu username de GitHub, ej: `diegominetti`
   - **Org login** (si es de org): el slug de la org, ej: `mi-organizacion`
4. **Guardar** → el panel valida el token contra GitHub automáticamente y guarda el resultado

Podés tener N PATs. La app los matchea por `ownerLogin` (para scope=repo) o `orgLogin` (para scope=org) cuando creás un runner.

### 4. Crear un runner

1. Click **+ Nuevo runner**
2. Completá nombre, scope, target
3. La sección **GitHub PAT** se auto-selecciona con el PAT que matchee el target. Si no hay match, agregá uno en Settings.
4. La sección **Registration token** queda vacía — la app lo genera automáticamente con el PAT seleccionado
5. **Crear runner**

### Lo que muestra el panel

- **GitHub** column en el dashboard: badge con `Idle` / `Busy` / `Offline` por cada runner, refrescado cada 30s
- **⚙ Settings** → lista de PATs con status (✓ OK / ✗ falla), último uso, scopes detectados
- En **Recreate** y **Renew creds**: el token se genera automáticamente. No hay input de token en los dialogs.

### Rate limits y errores

- GitHub rate limit para PATs: **5000 req/h**. El panel usa 1 llamada cada 30s por runner con PAT, así que con 100 runners son ~200 calls/h. Bien lejos del límite.
- Si GitHub responde 401 (PAT inválido), el runner se marca como `offline` y el PAT como `✗ falla` en Settings.
- Si GitHub responde 429 (rate limit), la app espera el `Retry-After` y reintenta en el próximo tick.

## Imagen del runner

A partir de Sprint 2, la app usa una imagen Docker **local** (`actions-runner:2.336.0`)
como default para los runners que crea, en vez de la imagen oficial de GHCR
(`ghcr.io/actions/actions-runner:*`).

**Por qué**: la imagen oficial dejó de traer `ENTRYPOINT` configurado en versiones
recientes, por lo que los containers arrancan en `bash` idle y el listener del
runner nunca se ejecuta. El wrapper en `docker/runner/` agrega el entrypoint que
falta + el auto-configure con las env vars (que la imagen oficial tampoco hace).
El binario `Runner.Listener` que se ejecuta adentro es el oficial de la release
indicada, sin tocar.

### Actualizar a una versión nueva del runner

Cuando sale una versión nueva de `actions/runner` (ej. 2.337.0):

```bash
# 1. Buildear la nueva imagen wrapper
./docker/runner/build.sh 2.337.0

# 2. Editar apps/api/src/services/runner-service.ts:
#    const DEFAULT_IMAGE = 'actions-runner:2.337.0';

# 3. Editar packages/shared/src/index.ts (JSDoc del campo `image`).

# 4. Rebuild de la app
docker compose up -d --build

# 5. Para cada runner existente, "Edit image" + "Recreate" desde el panel
#    (con token fresco). El volumen mantiene las credenciales.
```

El script `build.sh` valida el formato de versión, muestra los próximos pasos,
y acepta `--no-cache` para forzar un build limpio. Ver `docker/runner/build.sh`
para más opciones (multi-arch con buildx, etc.).

### Override por runner

Si querés usar una imagen distinta para un runner puntual (ej. una imagen
custom con toolchain preinstalada), pasala en el campo `image` al crearlo desde
el panel — o cambiala después con el botón **"Edit image"** del detalle del
runner. La app no la pisa en recreate/renew.

## Roadmap

| Sprint | Estado   | Qué entrega                                                 |
| ------ | -------- | ----------------------------------------------------------- |
| 0      | ✅ listo | Bootstrap monorepo, health check, scripts cross-platform    |
| 1      | ⏳       | Backend MVP: CRUD de runners con dockerode + SQLite         |
| 2      | ⏳       | UI básica: lista, form de alta, acciones start/stop/restart |
| 3      | ⏳       | Import de los 3 runners de misnumeros ya corriendo          |
| 4      | ⏳       | Live logs + auto-detección de "registration deleted"        |
| 5      | ⏳       | Settings + auth básica                                      |

## Notas

- El workspace usa pnpm workspaces. No commitees `package-lock.json`, sí `pnpm-lock.yaml`.
- La DB SQLite vive en `data/` (gitignored). Para backup: copiá `data/runners.db`.
- La app NO toca la API de GitHub hasta Sprint 1. El alta de runners va a pedir
  un registration token fresco cada vez.

# Actions Self-Hosted

Panel para gestionar N runners self-hosted de GitHub Actions desde un solo
lugar. Corre en Docker, administra los runners como containers, y te muestra
en vivo si están `idle`, `busy` u `offline`.

**Estado**: funcional. CRUD completo de runners, PATs de GitHub encriptados en
la DB, import de containers existentes, renovación de credenciales, y sync
periódico del estado contra la API de GitHub.

## Stack

- **Backend**: Node 24 + Express 4 + TypeScript + `node:sqlite` (built-in) + dockerode
- **Frontend**: React 18 + Vite 5 + TanStack Query + Tailwind
- **Shared**: tipos compartidos en `packages/shared` (pnpm workspace)
- **DB**: SQLite local en `data/runners.db` (un solo archivo, cero infra)
- **Docker**: integración vía Dockerode (engine API), sin Docker-in-Docker

## Plataformas soportadas

| Plataforma  | Soporte       | Cómo                                                    |
| ----------- | ------------- | ------------------------------------------------------- |
| Linux/x64   | ✅ Containers | Imagen wrapper local `actions-self-hosted-runner:X.Y.Z` |
| Linux/arm64 | ✅ Containers | Mismo wrapper, multi-arch (resuelve al build)           |
| macOS       | ⏳ Roadmap    | Hoy los runners de Mac se gestionan fuera de la app     |
| Windows     | ⏳ Roadmap    | Hoy los runners de Windows se gestionan fuera de la app |

**Hoy**: la app solo gestiona runners como **containers Docker Linux**. Para
runners en Mac o Windows, corrés el binario `actions-runner` de los releases
oficiales como proceso nativo en el host y los manejás por tu cuenta.

## Requisitos

- Node 20+
- pnpm 9+ (`npm i -g pnpm`)
- Docker (Mac/Windows: Docker Desktop; Linux: dockerd + compose)

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

### Docker (producción)

```bash
cp .env.example .env      # ajustá RUNNER_VERSION y las credenciales
docker compose up -d --build
```

Esto construye **las dos** imágenes (la app y la del runner) y levanta el
panel en `http://localhost:3000`.

> ⚠️ El bind del socket Docker (`/var/run/docker.sock`) asume host Mac/Linux.
> En Windows hay que ajustar la ruta del socket.

## Cómo funciona

```
┌─────────────────────────────────────────────────────────┐
│  actions-self-hosted (container)                        │
│  ├── API Express + panel React (same origin)            │
│  └── /var/run/docker.sock  ←── gestiona containers      │
└──────────────────────┬──────────────────────────────────┘
                       │ crea / arranca / para
        ┌──────────────┴───────────────┐
        ▼                              ▼
┌──────────────────────┐   ┌────────────────────────────┐
│ actions-self-hosted- │   │ actions-self-hosted-runner │
│ runner:<version>     │   │ (wrapper sobre la oficial) │
│  /home/runner  efímero│  │  /runner-data  volumen     │
│  /runner-data  volumen│  │   (.runner + .credentials) │
└──────────────────────┘   └────────────────────────────┘
```

La app **no** implementa el runner: usa la imagen oficial de GitHub y solo le
agrega lo que a la oficial le falta (ver abajo).

## La imagen del runner

El runner corre en la imagen **oficial** de GitHub:
[`ghcr.io/actions/actions-runner`](https://github.com/actions/runner) — el
mismo binario `Runner.Listener` que usarías en una VM, sin tocar.

Esa imagen oficial **no se puede usar directo** en este flujo porque:

1. No trae `ENTRYPOINT` — solo `CMD ["/bin/bash"]`. El container arranca en
   bash y el listener nunca se ejecuta.
2. No auto-configura: su `run.sh` invoca el listener pero nunca llama a
   `config.sh`, así que sin credenciales en disco el listener falla con
   "Not configured" y entra en loop infinito.

Por eso existe el wrapper thin de `docker/runner/`: toma la oficial como base
y le agrega un `ENTRYPOINT` (`entrypoint.sh`) que hace el flow completo —
restaurar credenciales → `config.sh --unattended` si hace falta → ejecutar el
listener.

### Por qué el volumen NO se monta en `/home/runner`

El work dir del runner tiene que ser `/home/runner`, porque el listener lee el
archivo `.runner` desde el CWD. Pero ahí también viven los binarios
(`bin/`, `externals/`, `config.sh`, `run.sh`).

Si el volumen persistente se montara ahí, **pisaría la distribución oficial**:
Docker siembra un volumen nombrado desde la imagen solo cuando está vacío, así
que después el volumen manda para siempre. Reproducido: un volumen creado con
la 2.328.0 seguía sirviendo los binarios de 2.328.0 después de correr la
imagen 2.338.0 — el tag de la imagen era cosmético y "Recreate" no actualizaba
el runner.

El layout actual separa las dos cosas:

| Ruta           | Origen           | Contenido                                       |
| -------------- | ---------------- | ----------------------------------------------- |
| `/home/runner` | la imagen        | binarios, `externals/`, `run.sh` — efímero      |
| `/runner-data` | volumen nombrado | solo `.runner` + `.credentials` — unos pocos KB |

Así **el tag de la imagen ES la versión real del runner**, y lo único que hay
que preservar entre reinicios son las credenciales.

### Actualizar la versión del runner

`RUNNER_VERSION` (en `.env`) es la **única** variable que hay que tocar. La
usa compose para taggear la imagen que construye y la app para resolver el
tag, así que no hay forma de que se desincronicen.

```bash
# 1) editá .env
RUNNER_VERSION=2.339.0

# 2) rebuild
docker compose up -d --build

# 3) recreá cada runner desde el panel (o POST /api/runners/:id/recreate)
```

El Recreate no borra el volumen, así que las credenciales se conservan. Si
GitHub invalidó la registration (el runner estuvo mucho tiempo offline),
usá **Renew** en vez de Recreate: borra las credenciales stale y re-registra.

## Setup de GitHub PATs

La app necesita **GitHub Personal Access Tokens** para:

1. **Generar registration tokens** automáticamente al crear/recrear/renovar runners.
2. **Consultar el estado de cada runner** en GitHub (`idle` / `busy` / `offline`).

Los PATs se guardan en la DB **encriptados con AES-256-GCM** y nunca se
exponen al front. Podés tener N PATs (multi-cuenta, multi-org) y la app los
matchea automáticamente con el `target` del runner.

### 1. Generar la master key de encryption (prod)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Pegá el output en tu `.env`:

```
APP_ENCRYPTION_KEY=<64-chars-hex>
```

En dev podés dejarla vacía — la app genera una en memoria al arranque y
loggea un warning. **En producción SIEMPRE tiene que estar seteada**: sin ella
los PATs guardados se vuelven ilegibles al reiniciar la app.

### 2. Crear un GitHub PAT

1. Andá a <https://github.com/settings/personal-access-tokens/new>
2. **Name**: `actions-self-hosted-panel`
3. **Expiration**: 90 días
4. **Scopes** (classic PAT): `repo`, y para runners de una org también
   `admin:org:read` o `read:org`
5. Click **Generate token** → copialo (empieza con `ghp_...`, se muestra una sola vez)

### 3. Agregar el PAT al panel

1. Click **⚙ Settings** (esquina superior derecha)
2. Sección **GitHub PATs** → **+ Agregar PAT**
3. Completá nombre, token, tipo (Personal u Organización) y el owner/org login
4. **Guardar** → el panel valida el token contra GitHub y guarda el resultado

### 4. Crear un runner

1. Click **+ Nuevo runner**
2. Completá nombre, scope y target
3. La sección **GitHub PAT** se auto-selecciona con el PAT que matchee el target
4. La sección **Registration token** queda vacía — la app lo genera automáticamente
5. **Crear runner**

## Configuración

Copiá `.env.example` a `.env` y ajustá:

```bash
cp .env.example .env
```

| Variable               | Default                 | Descripción                                            |
| ---------------------- | ----------------------- | ------------------------------------------------------ |
| `API_PORT`             | `3000`                  | Puerto del backend                                     |
| `NODE_ENV`             | `development`           | `development` \| `production` \| `test`                |
| `CORS_ORIGIN`          | `http://localhost:5173` | Origen permitido para CORS                             |
| `DB_PATH`              | `data/runners.db`       | Path al archivo SQLite                                 |
| `DOCKER_SOCKET`        | autodetect              | Socket Docker (vacío = autodetect)                     |
| `COMPOSE_PROJECT_NAME` | `actions-self-hosted`   | Label en los containers que crea la app                |
| `RUNNER_VERSION`       | `2.338.0`               | Versión del runner → imagen que construye compose      |
| `RUNNER_IMAGE`         | derivado                | Tag de la imagen del runner (solo si va a un registry) |
| `PANEL_USER`           | —                       | Usuario del panel (vacío = auth deshabilitada)         |
| `PANEL_PASSWORD`       | —                       | Password del panel                                     |
| `APP_ENCRYPTION_KEY`   | —                       | Master key AES-256-GCM de los PATs (64 hex)            |

### Auth

`PANEL_USER` / `PANEL_PASSWORD` activan **Basic Auth** sobre el panel y toda la
API. `/health` y `/api/health` quedan abiertos para los healthchecks.

Es importante setearlo: la API tiene el socket Docker montado, así que **sin
auth** cualquiera que alcance el puerto puede crear containers privilegiados
en el host. El panel y la API se sirven en el mismo origen, así que el browser
pide las credenciales una sola vez.

## Estructura

```
ActionsSelfHosted/
├── apps/
│   ├── api/         # Express + TS + SQLite + Dockerode
│   │   ├── src/
│   │   │   ├── server.ts          # entrypoint
│   │   │   ├── env.ts             # validación de env con Zod
│   │   │   ├── auth.ts            # Basic Auth (timing-safe)
│   │   │   ├── runner-image.ts    # tag de la imagen del runner
│   │   │   ├── db/                # schema, migraciones, repos
│   │   │   ├── docker/            # cliente dockerode + containers
│   │   │   ├── github/            # cliente de la API de GitHub
│   │   │   ├── routes/            # /api/health, /api/runners, ...
│   │   │   └── services/          # orquestación DB + Docker
│   │   └── Dockerfile.dev
│   └── web/         # React + Vite + Tailwind
├── packages/
│   └── shared/      # tipos compartidos API ↔ Web
├── docker/
│   └── runner/      # wrapper sobre la imagen oficial del runner
├── data/            # SQLite (gitignored)
├── Dockerfile       # imagen de la app (build de prod)
├── docker-compose.yml
├── DEPLOY.md        # guía de deployment (prod)
└── package.json     # pnpm workspace root
```

## Scripts

```bash
pnpm dev            # API + Web en paralelo
pnpm build          # build de prod
pnpm typecheck      # typecheck de todo el monorepo
pnpm format         # prettier --write
pnpm format:check   # prettier --check
```

Por paquete:

```bash
pnpm --filter @actions-self-hosted/api dev
pnpm --filter @actions-self-hosted/web dev
pnpm --filter @actions-self-hosted/api typecheck
```

## Notas

- El workspace usa pnpm workspaces. No commitees `package-lock.json`, sí `pnpm-lock.yaml`.
- La DB SQLite vive en `data/` (gitignored). Para backup: copiá `data/runners.db`.
- `docker-compose.override.yml` y `.env` están en `.gitignore` (tienen la
  master key y las credenciales del panel). No los commitees.
- Para el deployment en producción ver [DEPLOY.md](./DEPLOY.md).

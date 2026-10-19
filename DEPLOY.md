# Deployment de `actions-self-hosted` en flserver

Panel de gestión de runners self-hosted de GitHub Actions, corriendo en Docker
sobre `flserver` (Ubuntu 24.04 x64, 16 vCPU / 32 GB, Docker 29.9.1).

App: <https://github.com/DiegoMinetti/actions-self-hosted>

## Dónde está

| Qué                             | Dónde                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Código de la app                | `flserver@flserver:~/apps/actions-self-hosted`                                                    |
| Panel                           | `http://flserver.taile5d29.ts.net/` (solo tailnet)                                                |
| Panel local en el server        | `http://127.0.0.1:3000`                                                                           |
| DB (PATs encriptados + runners) | volumen Docker `actions-self-hosted-data` → `/app/data/runners.db`                                |
| Imagen del runner               | `actions-self-hosted-runner:<version>` (wrapper sobre `ghcr.io/actions/actions-runner:<version>`) |
| Runners                         | `flserver-1`, `flserver-2` — scope `org`, target `FewLines-com-ar`                                |

## Comandos

```bash
cd ~/apps/actions-self-hosted

# Deploy completo en un solo comando (build + deploy + migración de volúmenes
# + verificación). Necesita sudo por el socket de Docker.
sudo ./scripts/deploy.sh
sudo ./scripts/deploy.sh --purge    # además borra los volúmenes viejos

# O a mano:
docker compose ps                  # estado
docker compose logs -f app         # logs de la API
docker compose up -d --build       # redeploy (rebuild de app + imagen del runner)
docker compose down                # parar

curl -s http://127.0.0.1:3000/api/health
```

## Dos imágenes, dos sponsors

| Imagen                                 | Origen                                        | Para qué                      |
| -------------------------------------- | --------------------------------------------- | ----------------------------- |
| `actions-self-hosted:local`            | este repo (`Dockerfile`)                      | la app (API + panel)          |
| `actions-self-hosted-runner:<version>` | este repo (`docker/runner/Dockerfile.runner`) | los containers de los runners |

La imagen del runner es un wrapper FINITO sobre la imagen **oficial** de GitHub
(`ghcr.io/actions/actions-runner:<version>`), que es la que trae el binario
`Runner.Listener` sin tocar. Al wrapper solo se le agrega lo que a la oficial
le falta: el `ENTRYPOINT` y el auto-configure.

La oficial no se puede usar directo porque:

1. No trae `ENTRYPOINT` — solo `CMD ["/bin/bash"]`. El container arranca en
   bash y el listener nunca corre.
2. No auto-configura: su `run.sh` invoca el listener pero nunca llama a
   `config.sh`, así que sin credenciales en disco el listener falla con
   "Not configured" y entra en loop.

## Versión del runner: una sola variable

`RUNNER_VERSION` (en `.env`) es la única variable que hay que tocar para
actualizar el runner. Compose la usa para taggear la imagen que construye y
la app la usa para resolver el tag → no hay forma de que se desincronicen.

```bash
# 1) editá .env
RUNNER_VERSION=2.339.0

# 2) rebuild
docker compose up -d --build

# 3) recreá cada runner desde el panel (o POST /api/runners/:id/recreate)
```

**El tag ES la versión real.** El work dir del runner (`/home/runner`, con los
binarios) vive en la imagen, y el volumen persistente solo guarda las
credenciales (`.runner` + `.credentials`, montados en `/runner-data`).

> Esto NO era así antes. Con el volumen montado en `/home/runner` (el layout
> viejo), el volumen pisaba los binarios oficiales y el container quedaba
> congelado en la versión con la que se creó el volumen: un volumen creado con
> la 2.328.0 seguía sirviendo los binarios de 2.328.0 después de correr la
> imagen 2.338.0, y "Recreate" no actualizaba el runner. El layout actual
> separa la distribución (imagen) de las credenciales (volumen).

### Migrar runners del layout viejo al nuevo

Si venís de la versión anterior (volumen en `/home/runner`), el script
`scripts/migrate-runner-volumes.sh` hace la migración:

```bash
cd ~/apps/actions-self-hosted
./scripts/migrate-runner-volumes.sh          # migra, conserva los volúmenes viejos
./scripts/migrate-runner-volumes.sh --purge  # además borra los volúmenes viejos
```

Por cada runner: crea el volumen `actions-runner-<name>-data`, copia
`.runner` y `.credentials` del viejo, actualiza `volume_name` e `image` en la
DB, y llama a `POST /api/runners/:id/recreate` para que el container se
recree con la imagen nueva y el volumen nuevo.

Necesita las credenciales del panel:

```bash
PANEL_USER=admin PANEL_PASSWORD='<el de tu .env>' ./scripts/migrate-runner-volumes.sh
```

## Layout del container de un runner

```
/home/runner     efímero — viene de la imagen oficial (bin/, externals/, run.sh)
/runner-data     volumen nombrado — SOLO .runner y .credentials
/var/run/docker.sock  socket del host — para que los jobs puedan buildear
```

El container corre como `1001:0` (uid del user `runner` de la imagen oficial +
gid 0) y con `cap_drop: ALL` + las caps mínimas (`CHOWN`, `DAC_OVERRIDE`,
`SETGID`, `SETUID`, `KILL`).

## El socket Docker en GID 0 (Linux nativo)

En Linux nativo el socket es `root:docker` (0660), no GID 0. Los containers de
runner corren como `1001:0` y necesitan acceso al daemon para que los jobs
puedan hacer `docker buildx` / `docker push`.

Solución aplicada en el host: drop-in de systemd que pone el socket en GID 0.

```
/etc/systemd/system/docker.socket.d/override.conf
  [Socket]
  SocketGroup=0
  SocketMode=0660
```

Aplicado con `systemctl daemon-reload && systemctl restart docker.socket`.

> No confundir con `daemon.json` → `"group": "0"`: con la activación por
> socket de systemd eso **rompe el arranque de dockerd** (`start-limit-hit`).
> El grupo del socket lo maneja la unit, no el daemon.

Verificación:

```bash
docker exec actions-runner-flserver-1 sh -c 'id; ls -l /var/run/docker.sock'
# uid=1001(runner) gid=0(root) groups=0(root)
# srw-rw---- 1 root root 0 ... /var/run/docker.sock

docker exec actions-runner-flserver-1 docker version --format "{{.Server.Version}}"
# 29.9.1
```

> Consecuencia: el grupo `docker` del host **no** da acceso al socket (el
> socket está en GID 0 a propósito). Para operar Docker sin password se usa
> una regla de sudoers: `flserver ALL=(root) NOPASSWD: /usr/bin/docker, /usr/bin/docker *`.

## Auth

`PANEL_USER` / `PANEL_PASSWORD` (en `.env`) activan **Basic Auth** sobre el
panel y toda la API. `/health` y `/api/health` quedan abiertos para los
healthchecks de Docker.

El panel y la API se sirven en el mismo origen, así que el browser pide las
credenciales una sola vez y las reusa en todas las llamadas.

Esto importa: la API tiene el socket Docker montado, así que **sin auth**
cualquiera que alcance el puerto puede crear containers privilegiados en el
host. Por eso el puerto se publica **solo en `127.0.0.1`** y el acceso externo
es por Tailscale:

```bash
# desde cualquier equipo en la tailnet
http://flserver.taile5d29.ts.net/

# o por túnel SSH
ssh -L 3000:127.0.0.1:3000 flserver@flserver
```

Para habilitar HTTPS en la tailnet (y servir el panel con TLS):
<https://login.tailscale.com/f/serve?node=nuGVpBaWhU11CNTRL> — y después:

```bash
tailscale serve --bg 3000
```

### Si hay que exponerlo fuera de la tailnet

No está recomendado. Si igual hace falta, agregar un proxy inverso con auth
básica delante (Caddy/nginx) en vez de publicar el puerto directo.

## La master key de encriptación

La app guarda los PATs en SQLite encriptados con AES-256-GCM. La master key
vive en `.env` como `APP_ENCRYPTION_KEY`.

**Si se pierde esa key, los PATs guardados quedan ilegibles** y hay que
volver a cargarlos desde el panel (Settings → GitHub PATs).

El PAT cargado es el token OAuth de `gh` del server, que tiene scope
`admin:org` (necesario para registrar runners a nivel organización).

## Runners viejos (sin tocar)

Quedaron 4 runners de la org en estado `offline` (`fewlines-com-ar-1` a `-4`)
y 1 a nivel repo en `FewLinesSolution` (`probe-activity-01`). No se tocaron
porque no está claro si corresponden a alguna máquina todavía viva. Para
borrarlos:

```bash
gh api /orgs/FewLines-com-ar/actions/runners --jq '.runners[] | "\(.id) \(.name)"'
gh api -X DELETE /orgs/FewLines-com-ar/actions/runners/<id>
```

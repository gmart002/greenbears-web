# Green Bears — sitio web (greenbears.cl)

Sitio del club **Green Bears Rancagua**: web informativa, **noticias**, **fichas de
jugadores**, **calendario** y la **pizarra táctica** integrada. Autogestionable
desde un panel de administración. Todo en **un contenedor independiente y aislado**.

- **Stack:** Node + Express + EJS (SSR) + **SQLite** (archivo). Sin build, sin dependencias externas.
- **Datos:** base SQLite + imágenes subidas, en un volumen propio (`greenbears_data`).
- **Admin:** `/admin` protegido por clave. Crea/edita noticias, jugadores, partidos y ajustes.

## Estructura
```
src/            servidor Express (server.js), rutas y acceso a datos (db.js)
views/          plantillas EJS (público + admin)
public/         CSS, imágenes, favicon
data/           (runtime, ignorado) SQLite + uploads
Dockerfile, docker-compose.yml   contenedor aislado (red propia, límites, sin privilegios)
```

## Desarrollo local
```bash
cp .env.example .env      # define ADMIN_PASSWORD y SESSION_SECRET
npm install
npm run dev               # http://localhost:3000  ·  panel en /admin
```

## Seguridad / aislamiento (mismo VPS que GrapHCM)
- Red Docker **propia** `greenbears_edge`: la web **no comparte red** con Postgres ni con GrapHCM.
- Contenedor **sin privilegios** (`no-new-privileges`, `cap_drop: ALL`, usuario `node`).
- **Límites** de CPU (1) y RAM (512m) → aunque la ataquen o sature, no tumba el host.
- SQLite propio: un ataque a la web **no** alcanza los datos de GrapHCM.

## Puesta en marcha en el VPS (una sola vez)
Requisitos: Docker + el stack de GrapHCM ya corriendo (aporta el contenedor **grap-caddy**).

```bash
# 1) Clonar el repo como hermano de graphcm
cd ~
git clone git@github.com:gmart002/greenbears-web.git
cd greenbears-web
cp .env.example .env && nano .env          # ADMIN_PASSWORD y SESSION_SECRET

# 2) Levantar el contenedor (crea la red greenbears_edge)
docker compose --env-file .env up -d --build

# 3) Conectar Caddy a la red aislada para poder enrutar
docker network connect greenbears_edge grap-caddy

# 4) Agregar el dominio en el Caddyfile de graphcm y recargar Caddy
cat >> ~/graphcm/deploy/caddy/Caddyfile <<'CADDY'

greenbears.cl {
	encode zstd gzip
	reverse_proxy grap-greenbears:3000
}
www.greenbears.cl {
	redir https://greenbears.cl{uri} permanent
}
CADDY
docker compose -f ~/graphcm/docker-compose.unified.yml --env-file ~/graphcm/deploy/.env up -d --force-recreate caddy
```

## DNS (NIC Chile)
Apunta el dominio al VPS (registro **A**):
```
greenbears.cl        → 89.117.150.165
www.greenbears.cl    → 89.117.150.165
```
Caddy emite el certificado HTTPS automáticamente cuando el DNS resuelva.

## Deploy automático
Con los secrets `SSH_HOST`, `SSH_USER`, `SSH_KEY` en este repo, **cada push a `main`**
reconstruye el contenedor por SSH (ver `.github/workflows/deploy.yml`). La ruta de
Caddy y la red ya quedaron configuradas en la puesta en marcha, así que el deploy
solo actualiza la web.

## Copia de seguridad
Todo vive en el volumen `greenbears_data` (SQLite + imágenes):
```bash
docker run --rm -v greenbears_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/greenbears-backup.tgz -C /data .
```

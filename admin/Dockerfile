# syntax=docker/dockerfile:1.7

# Imagen del panel de administración de Golden Beauty Studio.
#
# Contexto de build = `admin/`. La app es una app Next hermana de la landing y
# no importa nada de `src/`, así que darle un contexto más ancho solo serviría
# para que un cambio en la landing invalide esta caché.
#
#   docker build -t gbs-admin admin/
#   docker run --rm -p 3000:3000 -e DATABASE_URL=... gbs-admin
#
# Tres cosas de acá no son gusto y romperían el panel si se tocan:
#
#   1. `output: "standalone"` NO copia `public/` ni `.next/static`. Se copian a
#      mano al layer final. Si se olvida, la página carga sin CSS y sin
#      imágenes — el error clásico de este flujo, y el que la Definition of
#      Done de este paquete verifica primero.
#   2. `tzdata`. Alpine no trae la base de zonas horarias; sin ella
#      `TZ=America/Bogota` no falla, simplemente se ignora y el proceso corre en
#      UTC. EA guarda datetimes locales sin zona, así que eso son cinco horas de
#      desfase que aparecen semanas después como "los totales del cierre no
#      cuadran". `/admin/api/health` reporta la zona efectiva vía `Intl` justo
#      para poder verificar esto en un contenedor corriendo.
#   3. El migrador es un **bundle**, no el `.ts`. El loader nativo de TypeScript
#      de Node no resuelve imports de directorio (`./migrations` →
#      `./migrations/index.ts`), que sí resuelven el bundler y Vitest. Ver
#      `src/db/migrate-cli.ts`.
#
# `--platform=linux/amd64` explícito: la VM es amd64 y la imagen tiene que serlo
# aunque quien construya esté en un Mac ARM. Una imagen arm64 en la VM falla al
# arrancar con "exec format error", que no se parece en nada a su causa.

# ── 1. Dependencias ──────────────────────────────────────────────────────────
# En su propio stage y antes de copiar el código, para que un cambio en `src/`
# no vuelva a bajar el árbol de npm.
FROM --platform=linux/amd64 node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
# `npm ci` y no `npm install`: instala exactamente el lockfile y falla si
# package.json y el lock discrepan, en vez de "arreglarlo" en silencio.
RUN npm ci --no-audit --no-fund

# ── 2. Build ─────────────────────────────────────────────────────────────────
FROM --platform=linux/amd64 node:22-alpine AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `next build` lee `next.config.ts` y lo **serializa dentro de `server.js`**:
# `basePath`, headers y rewrites quedan horneados en la imagen. Cambiarlos exige
# reconstruir, no reiniciar el contenedor.
#
# Cero `NEXT_PUBLIC_*` en esta app, a propósito: se hornean en el build, así que
# cada una obligaría a reconstruir la imagen por un cambio de configuración y a
# pasar build-args desde CI. Lo que el cliente necesita baja como props desde
# Server Components.
RUN npm run build

# El migrador, empaquetado a un único `.js` dentro del árbol standalone. Queda
# en `scripts/migrate.js` relativo a `/app`, que es lo que ejecuta el servicio
# `admin-migrate` del stack.
RUN npm run build:migrator

# El reconcile nocturno, por el mismo camino y por la misma razón. Queda en
# `scripts/reconcile.js`. **No es un respaldo**: como los webhooks de EA no
# reintentan, este job es lo que garantiza que toda cita termine con su precio
# congelado — el webhook solo lo adelanta.
RUN npm run build:reconcile

# `public/` puede no existir todavía (hoy no existe). Crearlo acá hace que el
# `COPY` de abajo funcione igual, en vez de romper el build el día que alguien
# borre el último archivo estático — o el día que agregue el primero.
RUN mkdir -p public

# ── 3. Runtime ───────────────────────────────────────────────────────────────
FROM --platform=linux/amd64 node:22-alpine AS runner
WORKDIR /app

# La zona horaria de verdad, no solo la variable. Ver la nota (2) de arriba.
RUN apk add --no-cache tzdata \
 && cp /usr/share/zoneinfo/America/Bogota /etc/localtime \
 && echo "America/Bogota" > /etc/timezone

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV TZ=America/Bogota
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# `node` (uid 1000) ya viene en la imagen oficial. El panel no escribe en disco
# —todo su estado vive en `gbs_admin`— así que corre con un árbol de solo
# lectura para él, que es lo que se quiere: un proceso que no puede modificar su
# propio código.
COPY --from=builder --chown=root:root /app/.next/standalone ./
COPY --from=builder --chown=root:root /app/.next/static ./.next/static
COPY --from=builder --chown=root:root /app/public ./public

USER node

EXPOSE 3000

# Sin `curl` ni `wget` en la imagen: el mismo Node que sirve el panel es el que
# lo consulta. La ruta lleva `/admin` porque `basePath` prefija **todo**,
# incluidos los route handlers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/admin/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# El server de standalone. `next start` no existe en esta imagen: standalone
# genera su propio `server.js` con las dependencias que el build rastreó.
CMD ["node", "server.js"]

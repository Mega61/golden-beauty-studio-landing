# Entorno de desarrollo local

Cómo levantar el panel en tu máquina, qué va en cada `.env.local` y por qué, y qué tiene que funcionar
al final de cada paquete de trabajo antes de pasar al siguiente.

El plan vive en `docs/ADMIN-PANEL.md`; el reparto en paquetes, en `docs/WORK-PACKAGES.md`.

## Qué corre dónde

```text
Docker (deploy/compose/dev-stack.yml)            Host (npm run dev)
  ├─ golden-agenda      → localhost:8080           ├─ landing  → localhost:3000
  ├─ mysql-transversal  → localhost:3307           └─ admin    → localhost:3001/admin
  └─ mailpit            → localhost:8025
```

Los nombres de servicio son los mismos que en el stack real de Portainer, a propósito: lo único que
cambia entre dev y producción son los valores de las variables, nunca la forma. La diferencia que sí
hay que tener presente es que allá **`mysql-transversal` vive fuera del stack**, en la red externa
`data`, y es un servidor **compartido con otras aplicaciones**.

**El panel no corre en Docker durante el desarrollo.** Corre con `npm run dev` en el host, porque el
HMR de Next a través de un bind-mount en Docker Desktop sobre Windows es lento y frágil. La imagen se
construye en CI y se prueba en la VM; en tu máquina solo necesitas Node.

Lo que sí corre en Docker es EA y su MySQL, porque necesitas la cosa real: la API, los webhooks y el
esquema contra el que los reportes hacen SQL directo.

## Prerrequisitos

- **Docker Desktop** con backend WSL2, corriendo.
- **Node 22** (`node -v`). La landing ya usa 22.
- Una **app de autenticación** en el celular (Google Authenticator, 1Password, Aegis) para probar el
  login TOTP de las técnicas.
- Opcional: `gh` para consultar el código fuente de EA sin salir de la terminal.

---

## Paso 1 — Levantar EA y MySQL

```bash
docker compose -f deploy/compose/dev-stack.yml up -d
docker compose -f deploy/compose/dev-stack.yml ps     # los tres en "running"/"healthy"
```

Antes de la primera vez, fija la versión de EA a la misma que corre la VM — desarrollar contra otra
versión es cómo se descubre en producción que un endpoint cambió:

```bash
echo "EA_VERSION=1.6.0" >> deploy/compose/.env    # el tag real que tenga la VM
```

**Verificación:** `http://localhost:8080` muestra el asistente de instalación de EA, y
`http://localhost:8025` abre Mailpit.

## Paso 2 — Instalar y configurar EA (una vez)

Abre `http://localhost:8080` y completa el asistente. Después, en **Ajustes**, deja el entorno igual al
que asume el plan — si te saltas esto, vas a depurar diferencias que no existen en producción:

| Ajuste | Valor | Por qué |
| --- | --- | --- |
| Zona horaria | America/Bogota | EA guarda datetimes locales sin zona |
| Formato de hora | 12 h | Lo que ve la clienta y lo que ve recepción tienen que coincidir |
| `require_email` | **No** | Muchas clientas no tienen correo; la identidad es el teléfono |
| `require_phone_number` | **Sí** | Es la llave de deduplicación |
| Estados de cita | `Reservada, Confirmada, Reprogramada, Completada, No asistió, Cancelada` | EA trae `Booked/Confirmed/…` y **no** trae "Completada" ni "No asistió", que son los dos que el motor de comisiones necesita |
| Página pública de reservas | Deshabilitada | La landing es el único formulario de reserva |
| API → token | Genera uno y cópialo | Es `EA_API_TOKEN` |

Crea también, para tener con qué trabajar: **dos proveedores** (las técnicas), **un par de servicios**
con precio y duración de `src/data/pricing.ts`, y **dos o tres clientas** con teléfono y sin correo.

**Verificación:**

```bash
curl -H "Authorization: Bearer $EA_API_TOKEN" http://localhost:8080/index.php/api/v1/services
```

Un 200 con JSON. Si además responde sin `/index.php`, el URL rewriting está activo — anótalo, porque
cambia `EA_API_URL`.

## Paso 3 — El esquema del panel

Ya lo creó el stack al levantar MySQL por primera vez (`deploy/compose/dev-init/01-gbs-admin.sql`):
la base `gbs_admin`, el usuario de escritura sobre ella, y el usuario **de solo lectura** sobre
`easyappointments`. Compruébalo:

```bash
docker compose -f deploy/compose/dev-stack.yml exec mysql-transversal \
  mysql -uroot -psecret -e "SHOW DATABASES; SELECT user,host FROM mysql.user;"
```

Si levantaste el stack antes de que existiera ese archivo, no corrió: los scripts de
`docker-entrypoint-initdb.d` solo se ejecutan cuando el volumen se crea vacío. Se arregla con
`docker compose -f deploy/compose/dev-stack.yml down -v` y volver a subir (borra los datos de EA).

## Paso 4 — `admin/.env.local`

No se commitea. Existe cuando el paquete WP-0 haya creado `admin/`.

```bash
# ── Base de datos ────────────────────────────────────────────────
DATABASE_URL="mysql://gbs_admin:gbs_admin_dev@127.0.0.1:3307/gbs_admin"
DATABASE_URL_EA_RO="mysql://gbs_ea_ro:gbs_ea_ro_dev@127.0.0.1:3307/easyappointments"

# ── Easy!Appointments ────────────────────────────────────────────
EA_API_URL="http://localhost:8080/index.php/api/v1"   # en la VM: http://golden-agenda/index.php/api/v1
EA_API_TOKEN="<el token del paso 2>"
EA_WEBHOOK_SECRET_HEADER="X-GBS-Webhook"
EA_WEBHOOK_SECRET_TOKEN="dev-webhook-secret"

# ── Sesión y auth ────────────────────────────────────────────────
BETTER_AUTH_SECRET="<openssl rand -base64 32>"
BETTER_AUTH_URL="http://localhost:3001/admin"
GOOGLE_CLIENT_ID="<consola de Google Cloud>"
GOOGLE_CLIENT_SECRET="<consola de Google Cloud>"
GOOGLE_WORKSPACE_DOMAIN="goldenbeautystudio.com.co"
TOTP_ENC_KEY="<openssl rand -base64 32>"

# ── Integraciones ────────────────────────────────────────────────
# Dejar INGEST_URL VACÍA. El push queda apagado y el cierre diario registra
# que no salió; se reintenta con el botón "Reintentar" cuando la ruta exista.
# Ver la nota de abajo antes de ponerle un valor.
INGEST_URL=""
INGEST_SHARED_SECRET="<el mismo del CRM local>"

# ── Entorno ──────────────────────────────────────────────────────
TZ="America/Bogota"
TICKET_STAFF_COBRA="true"
```

### Qué es cada una

| Variable | Para qué | Si está mal |
| --- | --- | --- |
| `DATABASE_URL` | Lectura y escritura sobre `gbs_admin`. Es donde vive **toda** la plata | El panel no arranca |
| `DATABASE_URL_EA_RO` | Lectura directa de las tablas de EA para reportes. **Solo lectura, a propósito**: las escrituras van por la API para que disparen notificaciones y el sync de Calendar | Los reportes fallan; o peor, si le das permisos de escritura, alguien terminará escribiendo por acá |
| `EA_API_URL` | Base de la API REST. Lleva `/index.php` salvo que el rewriting esté activo | 404 en todo |
| `EA_API_TOKEN` | Bearer de la API. **Nunca llega al navegador** | 401 en todo |
| `EA_WEBHOOK_SECRET_HEADER` / `_TOKEN` | El header estático con el que EA firma sus webhooks. No es un HMAC del cuerpo — EA no tiene eso — así que se compara en tiempo constante y el endpoint solo se expone en la red interna | El handler rechaza los eventos de EA y las citas quedan sin snapshot de precio |
| `BETTER_AUTH_SECRET` | Firma las sesiones | Nadie puede iniciar sesión |
| `BETTER_AUTH_URL` | Base absoluta de auth. **Va fijada a mano** porque en producción el panel vive detrás de un rewrite y el `Host` que le llega es el de la VM, no el del dominio público | Redirects de OAuth rotos |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Login de Workspace de la dueña y recepción | No entra nadie con Google |
| `GOOGLE_WORKSPACE_DOMAIN` | Se compara contra el claim `hd` del ID token. Es una de las dos compuertas | Un Gmail personal cualquiera entraría al panel |
| `TOTP_ENC_KEY` | Cifra los secretos TOTP de las técnicas en reposo | Los secretos quedarían en claro en la base |
| `INGEST_URL` / `INGEST_SHARED_SECRET` | Push de pagos a Strapi al cerrar el día | El cierre diario no llega a Actual Budget |

> **`INGEST_URL` va vacía hasta que el CRM tenga una ruta JSON.**
> `POST /api/ingest/agendapro-transactions` —la única ruta de transacciones que
> existe hoy— lee `ctx.request.files` y parsea un **XLSX de Agenda Pro**.
> Apuntarle el JSON del panel es mandarle un cuerpo que su parser de planillas
> no entiende. La ruta JSON que sí existe, `POST /api/ingest/agendapro`, es de
> **visitas** (`{ bookings: [...] }`), no de pagos.
>
> El panel manda `{ payments: [...] }` con los cinco campos de `Payment` y el
> header `x-ingest-secret`. Lo que falta del lado del CRM es un
> `POST /api/ingest/payments` que llame a `upsertPayment()`, que ya existe en
> `src/api/payment/services/ingest.ts` y se describe como "the ONE upsert path".
> Está **propuesto, no aprobado**: toca un segundo sistema en producción.
>
> Con `INGEST_URL` vacía el cierre del día funciona completo — congela los
> montos, escribe `day_close` y deja `pushed_to_ingest_at` en `NULL`. El push
> se recupera después con **Reintentar**, sin recalcular nada.
| `TZ` | Bogotá. EA guarda hora local sin zona | Todo desfasado cinco horas, y se manifiesta como "los totales no cuadran" |
| `TICKET_STAFF_COBRA` | Si la técnica registra también el método de pago | Solo cambia qué ve ella en "Cerrar servicio" |

**Ninguna variable `NEXT_PUBLIC_*` en `admin/`.** Se hornean en el build, así que cada una obligaría a
reconstruir la imagen por un cambio de configuración. Lo que el cliente necesita baja como props desde
Server Components.

## Paso 5 — Correr el panel

```bash
cd admin
npm install
npm run dev        # http://localhost:3001/admin
```

El `basePath` es `/admin`: `http://localhost:3001` a secas da 404, y está bien.

## Paso 6 — Probar el rewrite desde la landing

Recién cuando quieras verificar el camino completo. En el `.env.local` de la raíz:

```bash
ADMIN_ORIGIN="http://localhost:3001"
```

Con la landing en `npm run dev` (puerto 3000), `http://localhost:3000/admin` tiene que servir el panel,
y `/es` y `/bio` seguir intactas. Es donde se cazan los dos errores clásicos de esta arquitectura:

- **`/admin` redirige a `/es/admin`** → falta excluir `admin` del matcher de `src/proxy.ts`. Next 16
  corre `proxy` *antes* de los rewrites `beforeFiles`.
- **La página carga pero sin estilos, con 404 en `/_next/...`** → falta `basePath` en la app admin, y el
  navegador le está pidiendo los chunks a Vercel.

Para el día a día, trabaja directo contra `localhost:3001/admin`: menos piezas, menos ruido.

## Google OAuth en desarrollo

En Google Cloud, sobre un proyecto de la organización de Workspace:

- Pantalla de consentimiento **Internal**. Con la cuenta autorizante dentro del Workspace no hay
  verificación de Google, ni pantalla de "app no verificada", ni el vencimiento de refresh tokens de 7
  días que sí sufre una app *External* en modo Testing.
- URIs de redirección autorizadas — registra las tres desde el principio:
  - `http://localhost:3001/admin/api/auth/callback/google` (desarrollo directo)
  - `http://localhost:3000/admin/api/auth/callback/google` (desarrollo vía rewrite)
  - `https://www.goldenbeautystudio.com.co/admin/api/auth/callback/google` (producción — **con `www`**, que es el host canónico)

## Tests

```bash
cd admin
npm test               # todo
npm run test:watch     # iterando
npm run test:coverage  # la compuerta de los módulos de plata
```

Los de **capa 2** (MySQL real) levantan su propio contenedor efímero: no usan el MySQL de dev, para que
correr los tests nunca te borre los datos con los que estabas probando a mano.

---

## Validación por paquete

Cada paquete tiene un momento en el que se puede decir "esto quedó". Antes de pasar al siguiente:

| Paquete | Corre esto | Tiene que pasar esto |
| --- | --- | --- |
| **WP-0** andamiaje | `cd admin && npm run dev` | `localhost:3001/admin` responde; `/admin/api/health` da 200; `npm run lint && npm test` verde |
| **A1** cliente EA | `npm test` | Round-trip camelCase ↔ dominio ↔ snake_case; los tests pasan con `TZ=UTC` **y** con `TZ=America/Bogota`; un listado de 25 citas devuelve 25, no 20 |
| **A2** esquema | `npm test` + inspección | Las migraciones aplican en limpio dos veces seguidas sin error; existen las 18 tablas (14 de dominio + 4 de Better Auth) mas el libro `schema_migration` |
| **A3** diseño | Galería de componentes | Los siete estados por componente; contraste ≥4.5:1 en cuerpo; foco visible; revisada a 390 / 768 / 1440 |
| **A4** infra | `docker build` + despliegue | La imagen levanta y sirve **con estilos** (si no, faltó copiar `public/` y `.next/static`); `docker exec admin date` da hora de Bogotá; el rollback ensayado; el respaldo restaurado |
| **B1** plata | `npm run test:coverage` | 100 % de ramas en los módulos de plata; el golden test de una semana cuadra al peso |
| **B2** auth | Manual + tests | Entra Workspace; **rechaza** un `@gmail.com`; **rechaza** un Workspace fuera de la allowlist; TOTP no acepta dos veces el mismo código; un `staff` no alcanza caja **llamando la función directo**, no solo con el botón oculto |
| **B3** agenda motor | `npm test` | Dos citas simultáneas pasan y **tres no**, aunque haya tres técnicas: son dos estaciones |
| **B4** webhook | Drill manual | Con el panel abajo, crear una cita en EA → el evento **se perdió** (EA no reintenta) → el reconcile la recupera y no duplica la que sí llegó |
| **C1** agenda UI | Navegador | Día/semana, mover una cita, y el aviso "Guardar de todas formas" al encimar |
| **C2** cuenta | Celular real | Agendado `press-on`, cerrado como forrado + 3 diseños con motivo; y **en modo avión no se pierde nada de lo escrito** |
| **C3** caja | `npm run dry-run` en `actual-sync` | No deja cerrar el día con una cita completada sin cuenta; el dry-run muestra las transacciones nuevas y la segunda corrida no agrega nada |
| **C4** clientes | Navegador | Dos clientas con el mismo teléfono se resuelven a una; ninguna queda con correo inventado |
| **D2** reserva | Landing local | "Cualquiera" une los horarios de todas y **descuenta las estaciones ocupadas**; Turnstile rechaza sin token |
| **D4** reportes | Navegador | Ingreso por servicio **realizado**, no agendado; el respaldo con más de 48 h sale en rojo |

Cuando un punto no se puede ejecutar todavía, se anota como **no ejecutado** — nunca como pasa. Es lo
único que hace que la lista signifique algo.

---

## Fallas comunes

| Síntoma | Causa |
| --- | --- |
| `/admin` se va a `/es/admin` | `src/proxy.ts` no excluye `admin` del matcher |
| Panel sin estilos, 404 en `/_next/*` | Falta `basePath`, o la imagen no copió `public/` y `.next/static` |
| Las horas están corridas 5 h | `TZ` sin fijar en el contenedor o en el shell |
| La agenda muestra menos citas de las que hay | La API de EA pagina de a **20** por defecto: falta `length` |
| `redirect_uri_mismatch` en Google | La URI exacta del puerto que estás usando no está registrada |
| El puerto 3306 está ocupado | Por eso el stack publica MySQL en **3307** |
| El SQL de `dev-init` no corrió | Solo corre con el volumen vacío: `down -v` y volver a subir |
| EA pide instalarse de nuevo | El volumen se borró; es lo esperado después de un `down -v` |
| Cambios en `next.config.ts` que no se ven | Se serializa en el build: hay que reconstruir, no reiniciar |

## Resetear todo

```bash
docker compose -f deploy/compose/dev-stack.yml down -v   # borra EA y sus datos
docker compose -f deploy/compose/dev-stack.yml up -d
```

Y repetir el Paso 2. Vale la pena hacerlo una vez a propósito: el día que haya que montar la EA de
staging, ese procedimiento ya estará probado.

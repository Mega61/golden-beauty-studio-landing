# Panel de administración sobre Easy!Appointments

Plan de diseño e implementación. Estado: **aprobado, sin implementar.**

## Contexto

El estudio paga Agenda Pro. Easy!Appointments (EA) ya está instalado en la VM del estudio y cubre la
mitad de agendamiento; nada más. El objetivo es un panel en `goldenbeautystudio.com.co/admin` que sea
la superficie de trabajo diaria, que agregue los módulos que EA no tiene (caja, comisiones, combos,
reportes), y que permita cancelar Agenda Pro — más un flujo de reserva real en la landing para que la
clienta agende directo en EA en vez de ser enviada a Agenda Pro.

### Lo que la investigación cambió

Tres supuestos resultaron falsos, y cada uno **achica** el trabajo:

1. **Los combos ya están tarifados como productos únicos, no como paquetes.** `src/data/pricing.ts`
   tiene una categoría `combos` con cinco ítems vivos, y los números descartan el modelo de "dos
   citas enlazadas": `semi-permanent-hands` (60min, $50k) + `semi-permanent-feet` (75min, $55k) da
   135min / $105k, pero el combo `semi-permanent-hands-feet` es **120min / $95k**. Todos los combos
   son más cortos y más baratos que la suma de sus partes, por montos fijados a mano (8k–15k de
   descuento, 0–15min recortados). Un combo es entonces **un servicio**, y modela limpio como un solo
   servicio de EA — sin transacción multi-cita, sin borrados compensatorios, sin búsqueda de
   disponibilidad cruzada entre profesionales.
2. **El pipeline de integración ya existe y está automatizado.** `golden-beauty-studio-crm` corre
   `.github/workflows/agendapro-pull.yml` cada noche (23:50 UTC): Playwright scrapea Agenda Pro, hace
   POST a Strapi `/api/ingest/agendapro-transactions`, que hace upsert de filas `Payment` llaveadas
   por `tx_id`; luego `automation/actual-sync/sync.mjs` las empuja a Actual Budget vía
   `importTransactions` con `imported_id = agendapro-tx:<tx_id>`. Stampee tiene sus propias rutas
   `/ingest/stampee` y un cliente en `src/winback/stampee-client.ts`. **Así que este proyecto no
   construye un pipeline de exportación — cambia el productor** y jubila el scraper.
3. **Stampee no usa Supabase.** El fork tiene una API completa Fastify + Postgres (Kysely) bajo
   `api/`, con llaves máquina `Authorization: Bearer stmp_…`, y `requireRole` hace corto-circuito con
   `role === 'api'`, así que las llaves ya pasan toda ruta con alcance de owner. El push directo está
   disponible cuando la ruta por archivo deje de valer la pena.

---

## Lo que EA nos da (verificado contra el código fuente, rama `develop` = **v1.6.0**, 2026-05-27)

API REST en `/index.php/api/v1/` (o `/api/v1/` con URL rewriting activo). Auth: HTTP Basic, **o** un
token Bearer configurado en EA Settings (migración `017_add_api_token_setting.php`).

**Trece recursos**, todos descritos en el `openapi.yml` que viene dentro del repo de EA (su propio
`docker-compose.yml` levanta un `swagger-ui` para leerlo — no hace falta adivinar ningún contrato):
`appointments`, `availabilities`, `unavailabilities`, `customers`, `services`, `service_categories`,
`providers`, `secretaries`, `admins`, `settings`, `webhooks`, `blocked_periods`,
`working_plan_exceptions`.

`appointments` soporta `page`, `length`, `sort`, `q`, `fields`, `with`, `date`, `from`, `till`,
`serviceId`, `providerId`, `customerId`. Los payloads son camelCase; las columnas de la BD no.

⚠ **La paginación por defecto es de 20 registros.** Un `GET /appointments?from&till` de una semana con
varias técnicas devuelve 20 filas y ni un error: la agenda simplemente se vería incompleta, y nadie lo
notaría hasta que falte una cita. Todo listado pasa `length` explícito y pagina hasta agotar; el cliente
de A1 no expone un método que pueda truncar en silencio.

Campos que importan y que el plan anterior no contemplaba:

| Recurso | Campo | Por qué importa |
| --- | --- | --- |
| appointment | `color` | Color por cita. Deja codificar el estado sin tocar el color del servicio. |
| appointment | `status` | Texto libre (ver hueco #3). |
| appointment | `meetingLink` | Nuevo en 1.6 (Jitsi). Irrelevante para un estudio presencial: se ignora, pero viaja en el payload. |
| appointment | `hash` | Token de la cita para los links públicos de cancelación / reagendamiento. |
| service | `price`, `currency` | EA **sí** guarda precio en el servicio. Es la fuente del snapshot. |
| service | `slotInterval` | Reemplazó a `availabilitiesType` en 1.6. Define la grilla de horarios ofrecidos. |
| service | `attendantsNumber` | Capacidad simultánea. Entra en la detección de choques. |
| service | `isPrivate` | Oculta el servicio de la página pública de reservas de EA. |
| service | `color` | Color por servicio. **Ojo: es de solo escritura por la API** — se lee con `with=service` o por MySQL (ver hallazgos abajo). |
| provider | `workingPlan`, `workingPlanExceptions`, `services[]`, `googleSync`, `caldavSync` | Todo lo que la agenda necesita para pintar horario laboral y excepciones. |

### Lo que el spec dice y lo que la API hace (hallazgos de A1, leyendo los modelos)

El `openapi.yml` describe la intención; los `api_encode()` / `api_decode()` de los modelos describen el
comportamiento. No coinciden, y cada diferencia es una forma de fallar en silencio:

| Hallazgo | Consecuencia |
| --- | --- |
| **`service.color` es de solo escritura.** `api_decode()` lo acepta, `api_encode()` no lo emite, aunque el spec lo declare | `GET /services` **nunca** trae el color. Para pintar el calendario hay que leerlo por `with=service` o por MySQL. Además, un leer-modificar-guardar (el bump anual de precios) borraría el color si el cliente mandara `null` — por eso lo omite |
| **`q` anula todos los demás filtros.** Con `q` presente el modelo llama a `search()` y descarta el `where` de `from`/`till`/`providerId`/… | Buscar "Ana" dentro de una semana devuelve todas las "Ana" de la historia, con 200 y sin aviso. El cliente rechaza la combinación antes de salir a la red |
| **`with=` devuelve la relación en snake_case** dentro de una respuesta camelCase (`load()` pega la fila cruda) | Un mapeo que solo supiera camelCase leería `undefined` en todo, sin error. Es el argumento definitivo a favor del mapeo de tres sentidos |
| **`from`/`till` son de grano día e inclusivos, y `till` compara contra `end_datetime`** | Pasar una hora no filtra por hora, y **una cita que cruza la medianoche del último día del rango queda fuera**. La agenda pide siempre un día extra y recorta en memoria |
| **`webhook.secretHeader` no se expone por la API** (la columna existe desde la migración 060, pero ni encode ni decode la tocan) | Diagnóstico puede verificar url, acciones y token del webhook, **no el header**. Ese chequeo se hace por MySQL o no se hace |
| **El `openapi.yml` documenta acciones de webhook que no existen** (`appointment_create`, `category_create`…) | Registrar un webhook con esos nombres lo deja **mudo, sin error**. Las 18 constantes buenas están en `constants.php` y fijadas en `EA_WEBHOOK_ACTIONS` |
| **`availabilities` responde en la zona de la técnica**, no en la del estudio | Con una sola sede da igual. Queda anotado para el día que haya dos |
| **Las respuestas de listado son arreglos pelados**: sin total, sin `next`, sin `Link`. El 401 responde **texto plano**, no JSON | La paginación no puede confiar en un total: hay que pedir hasta que una página venga incompleta |

### Cinco huecos que definen el diseño

1. **`ea_appointments` no tiene columna de dinero.** El precio vive en el *servicio*, y los servicios
   se re-tarifan cada año (flujo documentado en `AGENTS.md`). Una comisión calculada con el precio de
   hoy está mal para una cita del mes pasado. **Hay que congelar el precio al momento de agendar.**
   Ésta es la decisión más importante de todo el diseño.
2. **La API REST no agrega** — no hay `GROUP BY` ni `SUM`. Todo reporte lee MySQL directo.
3. **Los estados de cita son texto libre.** La migración `043` siembra
   `["Booked", "Confirmed", "Rescheduled", "Cancelled", "Draft"]` — **no hay "Completada" ni "No
   asistió"**, que son justo los dos que el motor de comisiones necesita. Y son texto plano guardado
   por cita: renombrar un estado después *no* migra las filas viejas. La lista se fija antes del corte
   y el panel la vigila (ver Diagnóstico).
4. **La API REST no valida choques de horario.** `Calendar.php` (el backend propio de EA) llama a
   `has_provider_conflict()` y devuelve `{success:false, conflict:true}` salvo que se mande
   `force_save`. `Appointments_api_v1::store()` y `::update()` **no tienen ese chequeo**: aceptan una
   cita encima de otra sin protestar. Como todas nuestras escrituras van por la API, **la detección de
   choques es nuestra**, no de EA.
5. **Los webhooks de EA no reintentan.** `Webhooks_client::call()` hace un POST con Guzzle envuelto en
   un `try` con un `catch (Throwable)` que solo escribe en el log. Si el panel está caído, en
   redespliegue, o tarda de más, **el evento se pierde para siempre**. Consecuencia directa: el
   reconcile nocturno no es una red de seguridad, es **el mecanismo principal**; el webhook solo lo
   adelanta.

### Anatomía del webhook (importa para el handler)

- Acciones disponibles (constantes en `application/config/constants.php`): `appointment_save`,
  `appointment_delete`, `unavailability_save`, `unavailability_delete`, `customer_save`,
  `customer_delete`, `service_save`, `service_delete`, `service_category_save`,
  `service_category_delete`, `provider_save`, `provider_delete`, `secretary_save`,
  `secretary_delete`, `admin_save`, `admin_delete`, `blocked_period_save`, `blocked_period_delete`.
- Cuerpo: `{"action": "<acción>", "payload": { … }}`.
- **El payload es la fila cruda de la BD, en snake_case** — y trae más de lo que este documento listaba:
  `id`, `book_datetime`, `start_datetime`, `end_datetime`, `location`, `meeting_link`, `notes`, `hash`,
  `color`, `status`, `is_unavailability`, `id_users_provider`, `id_users_customer`, `id_services`,
  `id_google_calendar`, `id_caldav_calendar`. **No** es la forma
  camelCase de la API: en `Appointments_api_v1` el trigger corre dentro de
  `notify_and_sync_appointment()`, es decir *antes* de `api_encode()`. La ruta del calendario de EA
  dispara exactamente la misma forma. El mapeo del cliente tipado tiene que aceptar las dos.
- **El payload no trae el precio.** El handler resuelve el servicio (`GET /services/{id}` o MySQL)
  para congelarlo.
- **La "firma" es un header estático**, no un HMAC del cuerpo: la migración `060` agrega
  `secret_header` + `secret_token`, y el cliente los manda tal cual. No hay forma de verificar que el
  cuerpo no fue alterado. Mitigación: comparación en tiempo constante, y **el endpoint no se atiende
  desde afuera**.

  ⚠ Eso último no salía gratis, y este documento lo daba por hecho. El rewrite de la landing manda
  `/admin/:path*` **entero** a la VM, así que el webhook quedaba alcanzable desde internet por dos
  caminos —el dominio público y el subdominio del origen— con el header estático como único filtro,
  que es justo lo que se quería evitar. Lo cierra **Caddy**, con un `respond 404` para
  `/admin/api/webhooks/*`: EA le pega al contenedor directo por la red de Docker y nunca pasa por
  Caddy, así que queda cerrado por fuera y abierto por dentro. El bloque está en `docs/DEPLOY.md`.

  El daño posible era acotado —el precio se resuelve contra EA, nunca se lee del cuerpo, así que nadie
  podía inyectar un monto— pero un tercero podía forzar trabajo y ensuciar `webhook_event`.

---

## Topología

Las funciones de Vercel no alcanzan un MySQL privado, y los reportes necesitan agregación SQL sobre
las tablas de EA. Por eso el código de servidor del panel corre en la VM, **como un servicio más del
mismo stack de Docker Compose que ya corre EA**, administrado desde el mismo Portainer. **Lo pedido se
conserva: un solo repo, y la URL sigue siendo `goldenbeautystudio.com.co/admin`.** Solo se mueve dónde
se ejecuta.

```text
UN REPO ─┬─▶ Vercel : landing (/es, /en, /bio) + BFF público de reservas
         └─▶ VM     : servicio `admin` dentro del stack de EA (Portainer)

  goldenbeautystudio.com.co/admin/*
        │  rewrite beforeFiles (next.config.ts)
        ▼
  panel.goldenbeautystudio.com.co        ← subdominio propio, TLS de Caddy
        │  Caddy (ya en la VM)  →  reverse_proxy admin:3000
        ▼
  stack `golden-agenda` (Portainer, web editor)   redes externas: `data` y `web`
   └─ golden-agenda     alextselegidis/easyappointments (imagen única, no nginx+php-fpm)

  stack `gbs-admin` (Portainer, desde Git)        mismas redes externas  ← NUEVO
   ├─ admin             Next 16, basePath "/admin"
   ├─ admin-migrate     one-shot, corre y muere
   └─ db-backup         mysqldump nocturno

  fuera del stack, en la red `data`:
   └─ mysql-transversal  MySQL 8.0.46, fuera de todo stack nuestro
                         ├─ easyappointments   (lectura, usuario RO)
                         └─ gbs_admin          (lectura y escritura)   ← NUEVO

  admin ─┬─ http://golden-agenda/…/api/v1   API REST de EA  (todas las escrituras)
         ├─ mysql-transversal:3306          lecturas / reportes
         ├─ Strapi  /api/ingest/*           pagos + visitas (contrato existente)
         └─ API Stampee  llave stmp_        (cuando se jubile la ruta por archivo)
```

`admin/` es una **app Next hermana en el mismo repo, no un workspace de npm** — nada dentro de `src/`
se mueve y el proyecto de Vercel conserva su Root Directory.

```text
├─ next.config.ts        ← + rewrite beforeFiles para /admin
├─ src/proxy.ts          ← + excluir "admin" del matcher de locale   ⚠ crítico
├─ vercel.json           ← NUEVO  ignoreCommand
├─ .vercelignore         ← NUEVO  admin/  deploy/
├─ tsconfig.json / eslint.config.mjs  ← excluir admin/
├─ docs/ADMIN-PANEL.md   ← este documento
├─ deploy/compose/       ← NUEVO  el stack que Portainer lee
│   ├─ gbs-stack.yml
│   └─ .env              ← solo el digest de la imagen; ningún secreto
├─ .github/workflows/admin-image.yml ← NUEVO
└─ admin/                ← NUEVO  app Next autocontenida
    ├─ Dockerfile
    └─ .dockerignore
```

**`src/proxy.ts` rompe esto en silencio si se olvida.** Next 16 corre `proxy` (paso 3) *antes* de los
rewrites `beforeFiles` (paso 4), así que el matcher actual redirige `/admin` → `/es/admin` antes de
que el rewrite dispare. `admin` debe entrar al negative lookahead junto a `api`.

`basePath: "/admin"` en la app admin deja sus chunks en `/admin/_next/*`, así un solo rewrite
`/admin/:path*` cubre páginas y assets. Sin eso el navegador le pide a Vercel hashes de chunk que solo
existen en el build de la VM.

---

## Contenedor, stack y despliegue

### Corrección (2026-08-31): stack propio, no dentro del de la agenda

El plan decía "un servicio más del stack de EA". Al ver el stack real cambió, y para mejor: **el panel va
en su propio stack `gbs-admin`, colgado de las mismas redes externas `data` y `web`.**

El razonamiento original —DNS interno, tráfico que no sale del host, una sola unidad en Portainer— se
sostenía sobre compartir stack, pero **las redes externas ya dan las dos primeras cosas sin compartir
nada**: `admin` resuelve `golden-agenda` y `mysql-transversal` exactamente igual desde otro stack. Y a
cambio se ganan tres cosas que importan más:

- **El stack de la agenda no se toca.** Está en producción atendiendo clientas. Migrarlo al modo Git
  para poder desplegar el panel significaría recrearlo, y si el nombre del stack cambiara, el volumen
  `ea_storage` quedaría huérfano y EA arrancaría con su almacenamiento vacío. Riesgo innecesario.
- **El panel nace en modo Git**, que es lo que el CI/CD necesita, sin migrar nada existente.
- **El radio de explosión queda separado de verdad**, que es lo que la sección de riesgos ya pedía.

Lo único que se pierde es ver un solo stack en Portainer, y verlos separados es más honesto: son dos
ciclos de vida distintos.

### Por qué pegado a la agenda y no en otra máquina

El panel habla con MySQL y con la API de EA en cada request. Ponerlo en el mismo stack le da tres
cosas gratis: DNS interno (`mysql`, `nginx`), tráfico que **nunca sale del host** — incluido el webhook
de EA hacia nosotros, que de otro modo saldría a internet con un secreto en un header sin firma — y una
sola unidad que la dueña ve, arranca y reinicia desde Portainer.

El costo es radio de explosión compartido, y se acota explícitamente: `restart: unless-stopped`,
límites de CPU y memoria, ningún volumen compartido con EA, y **EA nunca lleva `depends_on: admin`**.
Si el panel se cae, la agenda de EA sigue en pie.

### El stack real (capturado el 2026-08-31)

No es el `docker-compose.yml` de desarrollo que publica EA (ése monta el código fuente y arrastra
phpmyadmin, swagger-ui, baikal y openldap). La VM corre **la imagen de producción, un solo contenedor**:

```yaml
  golden-agenda:
    image: alextselegidis/easyappointments:latest
    container_name: golden-agenda
    restart: unless-stopped
    environment:
      BASE_URL: ${BASE_URL}
      DEBUG_MODE: "FALSE"
      DB_HOST: mysql-transversal
      DB_NAME: easyappointments
      DB_USERNAME: easyappointments
      DB_PASSWORD: ${EA_DB_PASSWORD}
    volumes:
      - ea_storage:/var/www/html/storage
    networks: [ data, web ]
```

Tres cosas de acá cambian el diseño:

1. **MySQL no está en el stack.** `mysql-transversal` vive en la red externa `data`, y `gbs_admin` va
   a ser un esquema más ahí. El reconocimiento del 2026-08-31 corrigió una suposición: **hoy no está
   compartido con nadie** — solo aloja `easyappointments`, 14 tablas y 0,4 MB. El nombre anticipa que
   lo estará, así que los cuidados se mantienen: grants **por esquema y nunca globales**; el respaldo
   hace `mysqldump` de nuestras dos bases y no del servidor entero; y una consulta de reporte pesada se
   mira con `EXPLAIN` antes de darla por buena, porque el día que llegue la segunda aplicación el
   vecino lo va a sentir.
2. **Las redes `data` y `web` son externas y ya existen.** `admin` se cuelga de las dos: `data` para
   alcanzar `mysql-transversal` y `golden-agenda`, `web` para que Caddy lo alcance a él. **No publica
   puertos.**
3. **El nombre DNS de EA es `golden-agenda`**, no `nginx`: `EA_API_URL=http://golden-agenda/…`.

⚠ **`:latest` es un riesgo abierto.** Cada redespliegue del stack puede traer una versión distinta de
EA, y este panel lee su esquema directo y depende de los nombres de columna de sus webhooks. Un
`docker compose pull` una noche cualquiera puede romper reportes sin que nadie toque código.
**Pinear a la versión que corre hoy** es parte de la Fase 0.

Lo que todavía falta confirmar en la VM: **en qué red vive Caddy** (se asume `web`), y con qué usuario
se crean el esquema `gbs_admin` y los dos usuarios en `mysql-transversal`.

### El servicio `admin`

```yaml
  admin:
    image: ${ADMIN_IMAGE}          # ghcr.io/…/gbs-admin@sha256:…  ← digest, nunca :latest
    restart: unless-stopped
    env_file: [ .env.admin ]       # fuera del repo: host, o variables del stack en Portainer
    environment:
      TZ: America/Bogota
      NODE_ENV: production
      PORT: "3000"
      HOSTNAME: "0.0.0.0"
    depends_on:
      admin-migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/admin/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    deploy:
      resources:
        limits: { cpus: "1.0", memory: 512M }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
    networks: [ data, web ]        # data = mysql-transversal y golden-agenda; web = Caddy
```

- **Ningún puerto publicado.** Caddy entra por la red `web`, igual que ya alcanza a `golden-agenda`. Si
  Caddy corriera en el host y no en un contenedor, entonces `ports: ["127.0.0.1:3001:3000"]` — nunca
  `0.0.0.0`.
- **`admin-migrate` no espera a MySQL con `depends_on`**: `mysql-transversal` es externo al stack, así
  que no hay condición que esperar. El script reintenta la conexión con backoff antes de rendirse.
- **`admin` no monta `ea_storage` ni ningún volumen de EA.** No comparte estado con la agenda; si el
  panel se cae o se corrompe, EA no se entera.
- **`TZ: America/Bogota` no es cosmético.** EA guarda datetimes locales sin zona. Un contenedor en UTC
  desplaza cada cálculo cinco horas, y el error se manifiesta como "los totales del cierre diario no
  cuadran". El test de `lib/ea/mapping.ts` corre con `TZ` forzado justamente por esto.
- **`admin-migrate`** es un one-shot con la misma imagen, `restart: "no"`, `command: ["node",
  "scripts/migrate.js"]`. Las migraciones no van en el arranque del server: un reinicio en bucle las
  correría en bucle, y Portainer recrea el contenedor en cada despliegue. Forward-only e idempotentes.
- El usuario MySQL de solo lectura sobre `easyappointments` y el esquema `gbs_admin` se crean desde
  `admin-migrate`, no tocando el volumen de datos de EA.

### Caddy

```text
panel.goldenbeautystudio.com.co {
    encode zstd gzip
    @notadmin not path /admin*
    respond @notadmin 404
    reverse_proxy admin:3000
}
```

El 404 de todo lo que no cuelgue de `/admin` es deliberado: el origen existe solo para que Vercel haga
rewrite hacia él. Caddy ya resuelve TLS y los `X-Forwarded-*`; Better Auth no deriva su base URL del
`Host` (viene fijada), así que el rewrite de Vercel no la confunde.

### La imagen

Multi-stage sobre `node:22-alpine`, `output: "standalone"`, usuario no-root, `linux/amd64` explícito.

- `standalone` **no copia `public/` ni `.next/static`** — hay que copiarlos a mano al layer final
  (`cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/`). Si se olvida, la
  página carga sin CSS y sin imágenes. Es el error clásico de este flujo.
- `next.config.ts` **se serializa dentro de `server.js` durante el build**: `basePath`, headers y
  rewrites quedan horneados. Cambiarlos exige reconstruir la imagen, no reiniciar el contenedor.
- **Cero `NEXT_PUBLIC_*` en `admin/`.** Se hornean en build, así que cada variable pública obliga a
  rebuildear por cambio de configuración y a pasar build-args desde CI. Lo que el cliente necesita baja
  como props desde Server Components. Regla dura, no preferencia.
- Contexto de build = `admin/`, con su propio `.dockerignore`. La app admin no importa nada de `src/`.

### CI/CD — GHCR + stack en Git + polling de Portainer

**Portainer CE no tiene stack webhooks**: esa función está detrás de Business Edition. Lo que sí tiene
CE es desplegar un stack **desde un repositorio Git con actualización automática por polling**. El
diseño se apoya en eso, y sale mejor de lo que hubiera salido con webhook: **CI no necesita ninguna
credencial hacia la VM** — ni llave SSH, ni token de Portainer, ni puerto abierto. Su único secreto es
el `GITHUB_TOKEN` que Actions ya provee para empujar a GHCR.

```text
push a admin/**  ─▶  GH Actions
                      1. npm ci && npm run lint && npm test      (en admin/)
                      2. docker buildx build --platform linux/amd64
                      3. push a ghcr.io/<org>/gbs-admin:sha-<short>
                      4. escribe ADMIN_IMAGE=…@sha256:<digest> en deploy/compose/.env
                      5. commit "[skip ci] deploy: admin <sha>"  ─▶  repo
                                                                     │
Portainer (CE) hace polling del repo cada 5 min ◀────────────────────┘
                      pull → docker compose up -d → contenedor nuevo
```

- **Digest, no tag.** `@sha256:…` es lo único que convierte el rollback en una operación real: un
  `git revert` del commit de despliegue devuelve exactamente el binario anterior. Con `:latest` o con
  un tag móvil no hay rollback, hay esperanza.
- **Guarda anti-bucle:** el commit de CI lleva `[skip ci]` y el workflow declara
  `paths-ignore: ['deploy/compose/.env']`. Sin las dos, el push de CI dispara CI.
- **Latencia de despliegue = el intervalo de polling** (5 min sugerido). Cuando urge, el botón "Update"
  del stack en Portainer lo aplica ya. Si el Portainer de la VM resultara tener habilitada la opción
  "Webhook" dentro de las actualizaciones automáticas del stack de Git — la documentación oficial no la
  marca como Business, a diferencia del stack webhook clásico — se agrega un `curl` al final del
  workflow y la latencia baja a segundos. Es un acelerador opcional; el plan no depende de él.
- **Cero credenciales en Portainer, porque el repositorio es público** (confirmado el 2026-08-31). No
  hace falta PAT para clonar, y el paquete de GHCR se publica también en público: el código del panel ya
  lo es, así que un paquete privado no protegería nada y a cambio metería una credencial que caduca —
  y un PAT vencido se manifiesta como "el despliegue dejó de actualizar", **sin error visible**. La
  imagen no lleva secretos: las variables las inyecta el stack.
- Cache de build: `cache-from/to: type=gha`.

**Vercel se salta los pushes que no tocan la landing** — `vercel.json`:

```json
{ "ignoreCommand": "git diff --quiet HEAD^ HEAD -- ':(exclude)admin/' ':(exclude)deploy/' ':(exclude)docs/' ':(exclude).github/'" }
```

Semántica verificada: **exit 1 → el build continúa, exit 0 → el build se ignora.** `git diff --quiet`
sale con 0 cuando no hay diff, así que un push que solo toca `admin/`, `deploy/` o `docs/` no genera
deploy de la landing. **`deploy/` en la lista es obligatorio**: cada despliegue del panel escribe ahí, y
sin la exclusión cada despliegue del panel redesplegaría la landing.

Un push que toca ambas rutas despliega ambas; ningún pipeline puede corromper el artefacto del otro.

### Respaldos

Hoy no hay ninguno, y el panel está por convertirse en el libro de la plata: EA no guarda dinero, así
que una `gbs_admin` perdida **no se puede reconstruir desde ninguna otra fuente**. Es el único riesgo del
proyecto que no tiene arreglo después de ocurrido, y por eso entra en la Fase 0 y no "más adelante".

Un servicio más del stack, `db-backup`, con `mysqldump` de **los dos** esquemas (`easyappointments` y
`gbs_admin`), comprimido y con la fecha en el nombre:

- Diario, de madrugada, con `--single-transaction` para no bloquear a EA.
- Retención 30 días local, y **copia fuera de la VM** — a GCS, que ya se usa para media, con una cuenta
  de servicio que solo puede escribir en ese bucket.
- El volumen de MySQL también se respalda, pero el `mysqldump` es el que importa: restaurar un volumen
  entre versiones de MySQL falla de formas creativas.
- **Un backup que nunca se restauró no es un backup.** El ensayo de restauración a una base limpia entra
  en la verificación de la Fase 0, y se repite después de cada upgrade de EA.
- El resultado del job se ve en Diagnóstico: fecha y tamaño del último respaldo, en rojo si tiene más de
  48 horas. Un backup que falló en silencio es exactamente igual a no tener backup.

### Reglas de operación

- **Nadie corre `docker compose up` a mano en la VM.** Con el stack en modo Git, Portainer sobreescribe
  en el siguiente ciclo cualquier cambio local, y el cambio se pierde sin aviso. Todo cambio de
  infraestructura entra por un commit a `deploy/compose/`.
- Los secretos no entran nunca al repo: viven en las variables de entorno del stack en Portainer, o en
  un `.env.admin` en el host fuera del árbol clonado. `deploy/compose/.env` contiene una sola línea, el
  digest de la imagen.
- Variables que el servicio necesita: `DATABASE_URL` (usuario RW sobre `gbs_admin`),
  `DATABASE_URL_EA_RO` (solo lectura sobre `easyappointments`), `EA_API_URL`, `EA_API_TOKEN`,
  `EA_WEBHOOK_SECRET_HEADER`, `EA_WEBHOOK_SECRET_TOKEN`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_WORKSPACE_DOMAIN`, `INGEST_URL`,
  `INGEST_SHARED_SECRET`.

---

## Auth — Better Auth + Google Workspace

`admin/src/lib/auth.ts`, proveedor social Google, adaptador Kysely/mysql2 contra `gbs_admin`.

- **`baseURL` seteado explícitamente**, nunca derivado: detrás del rewrite el `Host` upstream es el
  origen de la VM. Igual para `trustedOrigins`.
- Redirect URI `https://www.goldenbeautystudio.com.co/admin/api/auth/callback/google` — **con `www`**: el apex hace 307 a `www`, que es el host canónico. Sin el `www`, Google redirige al apex, el apex redirige a `www`, y la cookie de sesión —que es host-only— se queda en el host equivocado. El login falla de una forma que parece de Google y no lo es.

⚠ **Dos correcciones que B2 verificó en la fuente de Better Auth, y que este documento tenía mal:**

1. **`baseURL` y el redirect URI que pedía el plan eran incompatibles.** Cuando el `baseURL` trae path,
   Better Auth **ignora `basePath`** y monta el router en ese path tal cual. Con
   `baseURL = …/admin` los endpoints habrían quedado en `/admin/get-session`, no en
   `/admin/api/auth/get-session`, y el redirect URI de arriba nunca habría existido. La variable de
   entorno `BETTER_AUTH_URL` **sigue siendo la raíz del panel** —como dice el runbook— y es el código el
   que le agrega `/api/auth`.
2. **Next le recorta el `basePath` al `request.url` de un Route Handler.** Pidiendo
   `/admin/api/auth/get-session`, el handler ve `/api/auth/get-session`. Como Better Auth usa el mismo
   `baseURL` para enrutar *y* para armar el `redirect_uri` de Google, no hay un solo valor que sirva
   para las dos cosas: el handler reescribe la request con el prefijo puesto. **Sin eso, todo responde
   404 en silencio** — es el modo de falla más fácil de no notar de este paquete, y el hermano del
   problema de `proxy.ts` en la landing.
- **Dos compuertas, ambas obligatorias:** el claim `hd` del ID token debe igualar el dominio de
  Workspace **y** `email_verified` debe ser true; después el email debe existir en `allowed_user`.
  Pasar `hd` como parámetro de request es para UX, pero nunca se confía sin verificar el claim firmado
  — es lo que hace `api/src/lib/googleVerifier.ts` en Stampee.
- Las cookies no llevan `Domain`, así el navegador las asocia al apex. `httpOnly`, `secure`,
  `sameSite: lax`, `path: /admin`.
- Roles `owner` / `admin` / `staff`; una fila `staff` enlaza a un provider de EA para que una
  manicurista vea solo su agenda y su liquidación.
- La autorización usa el **patrón DAL** de Next 16: `admin/src/lib/dal.ts` exporta `verifySession()`
  memoizado con `cache()` de React, invocado desde cada Server Component, Action y Route Handler. El
  chequeo en el proxy es redirect optimista únicamente — nunca la única compuerta.
- **Dos sistemas de identidad conviven a propósito.** Las cuentas de EA (admin / provider / secretary)
  siguen existiendo: son las que usan el token de la API y la sincronización con Google Calendar de
  cada profesional. Las personas entran al panel con Workspace; `allowed_user.ea_provider_id` es el
  puente. Nadie necesita saber su contraseña de EA para trabajar.

### Acceso de las técnicas — TOTP

Las técnicas usan correo personal, así que la compuerta de Workspace las deja afuera por diseño. Su
entrada es **un código TOTP de seis dígitos** desde la app de autenticación de su celular. Sin
contraseña, sin correo corporativo, sin una silla de licencia por persona.

**Better Auth no puede hacer esto solo.** Su plugin de dos factores es explícitamente un *segundo*
factor: exige un primer factor ya establecido y una sesión iniciada. Así que el TOTP como factor
primario es una ruta de sign-in propia — verificamos el código y creamos la sesión con la API de
servidor de Better Auth. Es código de autenticación escrito a mano, y por eso entra completo a la
Capa 1 de tests.

- **Tabla `staff_totp`:** `user_id`, `secret_encrypted` (cifrado con `TOTP_ENC_KEY`, nunca en claro),
  `confirmed_at`, `last_used_step`, `failed_attempts`, `locked_until`.
- **Enrolamiento:** la dueña crea a la técnica en Equipo, el panel muestra el QR (`otpauth://`) **una
  sola vez**, la técnica lo escanea y confirma con un código. Hasta ese confirm, la cuenta no entra.
- **Recuperación = re-enrolamiento por la dueña.** Nada de códigos de respaldo impresos: si el celular
  se pierde, los códigos de respaldo se pierden con él. Un QR nuevo en treinta segundos resuelve más.
- **Anti-repetición obligatoria.** Se guarda el último `step` aceptado y se rechaza reusarlo: un código
  vive 30 segundos y alguien que lo vea por encima del hombro podría reusarlo dentro de la ventana.
  Tolerancia de ±1 step, ni uno más.
- **Bloqueo por intentos:** 5 fallos en 15 minutos y la cuenta queda bloqueada hasta que la dueña la
  suelte. Comparación en tiempo constante.
- **Login: cara y código.** El estudio tiene tres personas; una grilla con sus nombres es más rápida en
  un celular que escribir un correo. Eso no debilita nada — el nombre nunca fue el secreto.
- **Sesión larga (30 días deslizantes)** para que entrar sea raro, con revocación por persona desde
  Equipo el día que alguien se va o pierde el teléfono.

**Se dice claro: TOTP solo es un factor, no dos.** Lo que lo hace aceptable es el alcance: una sesión
`staff` solo alcanza su propio día, sus propias cuentas y su propia liquidación — nunca la caja, ni los
reportes, ni las demás. La compuerta fuerte sigue siendo Workspace, y protege lo que importa.

Cuando exista el emisor de WhatsApp (ver Recordatorios), queda disponible un camino de recuperación por
código de un solo uso al número de la técnica. No se construye ahora.

---

## Modelo de datos — `gbs_admin` en `mysql-transversal`

Nunca escribir las tablas de EA (las escrituras van por la API para que disparen notificaciones y el
sync de Calendar); leerlas con un **usuario MySQL de solo lectura**. MySQL y no el Postgres de Stampee
porque el camino caliente — agenda, caja, comisiones, reportes — necesita las citas de EA al lado;
Stampee es un push periódico de pocas filas.

⚠ **No hay JOIN cross-schema, y el título anterior de esta sección sugería lo contrario.** `gbs_admin` y
`easyappointments` viven en el mismo servidor pero se leen con **usuarios distintos**, así que una
consulta no puede cruzarlos. Por eso `appointment_finance` denormaliza tres columnas de la cita
(`ea_provider_id`, `appointment_start_at`, `secondary_ea_provider_id`): no son caché, son la única forma
de indexar la agenda por rango y la liquidación por técnica sin un JOIN que no existe.

| Tabla | Propósito |
| --- | --- |
| `user`, `session`, `account`, `verification` | Better Auth |
| `allowed_user` | email → rol → provider de EA opcional |
| `appointment_finance` | **una fila por cita de EA** (`ea_appointment_id` UNIQUE — es la llave de idempotencia). Encabezado de la cuenta: `booked_service_id`, `performed_service_id`, `service_price_snapshot`, `discount`, `amount_charged`, `tip`, `payment_method` (efectivo/transferencia/otro — igual al enum `Payment.method` de Strapi), `paid_at`, `service_notes`, `variance_reason_code`, `variance_reason`, `closed_by`, `closed_at`, `day_close_id`, `snapshot_source` (webhook\|reconcile\|fallback), `pushed_to_ingest_at`. Resuelve el hueco #1 y *es* el libro de caja. |
| `appointment_finance_item` | los renglones de la cuenta: `kind` (servicio\|adicional\|manual), `ea_service_id`, `pricing_id`, `qty`, `unit_price_snapshot`, `line_total`, `note`. Es lo que permite que la técnica registre adicionales y un servicio distinto al agendado (ver "Cuenta de servicio"). |
| `day_close` | el cierre diario: fecha, totales por método, quién cerró, cuándo, y si ya se empujó a ingest. Congela las cuentas del día y es la unidad de push. |
| `webhook_event` | cada POST recibido de EA: `action`, `ea_entity_id`, `body_hash`, `received_at`, `processed_at`, `error`. Deduplica reprocesos y deja rastro para depurar un evento perdido — que con un webhook sin reintentos es el modo de falla esperado, no el raro. |
| `commission_rule` | `provider_id` (null = todas), `category_id` (null = todas), `service_id` (null = todos), `applies_to` (principal\|adicionales\|ambos), `kind` (percent\|fixed), **`percent_bp` en puntos básicos** o `fixed_amount` en pesos —columnas separadas con CHECK, no un `value` de doble unidad—, `valid_from`, `valid_to`. Ver "Comisiones". |
| `commission_entry` | por **renglón** de cuenta: regla aplicada, base, tasa, monto, periodo, `status` (pending\|paid) |
| `commission_run` | la liquidación de una quincena: periodo, técnica, total, `status` (borrador\|revisada\|pagada), quién la pagó y cuándo. Una vez `pagada` es inmutable. |
| `station` | los puestos físicos del estudio: `name`, `allows` (categorías o null). Dos filas. EA no sabe contar puestos; ver "Multi-técnica". |
| `staff_totp` | segundo camino de login para las técnicas: `secret_encrypted`, `confirmed_at`, `last_used_step`, `failed_attempts`, `locked_until`. Ver "Acceso de las técnicas". |
| `combo` | `ea_service_id`, `hands_service_id`, `feet_service_id`, `price`, `duration_min`, `allocation_hands_pct` |
| `service_map` | `pricing_id` (el id de `src/data/pricing.ts`) ↔ `ea_service_id`. Sin esto la vitrina y el catálogo operativo son dos listas que se separan en silencio (ver "Catálogo y precios"). |
| `legacy_appointment` | histórico de Agenda Pro, para continuidad de reportes sin ensuciar el calendario de EA |
| `audit_log` | quién cambió qué desde el panel |

**Webhooks de EA → `POST /admin/api/webhooks/ea`** crean la fila `appointment_finance` y congelan el
precio del servicio en el momento en que se agenda la cita — incluyendo reservas hechas desde la
landing. Se verifica con el header secreto (migración `060`) en comparación de tiempo constante, y el
endpoint solo se alcanza desde la red interna del stack.

**El reconcile nocturno es el mecanismo principal, no el respaldo.** Recorre las citas de EA de las
últimas N noches sin fila `appointment_finance` y las crea con `snapshot_source='reconcile'`. Como los
webhooks de EA no reintentan (hueco #5), un panel caído diez minutos pierde todos los eventos de esos
diez minutos, y solo el reconcile los recupera.

---

## Catálogo y precios — una sola fuente, un solo sentido

Con EA en la ecuación hay de golpe **tres lugares donde vive un precio**: `src/data/pricing.ts` (la
vitrina), el Collection Type de Strapi que `pricing.ts` ya consulta como override, y
`ea_services.price` (lo que se cobra y lo que se congela). Tres escritores sobre el mismo número es
deriva garantizada.

Decisión tomada (2026-08-31): **`src/data/pricing.ts` sigue siendo la fuente de verdad.** El panel no edita precios; los
**publica**. Una pantalla muestra el diff `pricing.ts` ↔ EA (servicio nuevo, precio distinto, duración
distinta, servicio en EA que ya no existe en la vitrina) y aplica en un solo sentido, escribiendo por
`PUT /services/{id}`. `service_map` guarda la correspondencia por id.

`scripts/check-pricing.mjs` gana un tercer chequeo: todo id de `pricing.ts` tiene entrada en
`service_map` o está marcado explícitamente como "solo vitrina". Así el build falla cuando alguien
agrega un servicio y olvida publicarlo, en vez de que aparezca en la web y no se pueda agendar.

---

## Multi-técnica y sincronización con Google Calendar

### Multi-técnica: qué arrastra además de las columnas

La agenda ya es por recurso (columnas = profesionales, ver UX). Lo que hay que no olvidar:

- Cada provider tiene su **propio** `workingPlan`, sus excepciones y su lista `services[]`. **Una
  profesional solo puede tomar un servicio que tenga asignado** — es el primer sitio donde aparece el
  reporte "no me sale disponibilidad" sin que nada esté roto.
- **`GET /availabilities` exige `providerId`: no existe "cualquiera".** Para el flujo público hay que
  abanicar una llamada por cada profesional habilitada para ese servicio y unir los resultados. Con 4–6
  técnicas son 4–6 llamadas por fecha consultada; se cachean unos segundos por `(servicio, fecha)`.
  Al reservar, el panel elige a quién asignar (la que tenga menos carga ese día) y lo hace explícito en
  la confirmación.
- La detección de choques corre **por columna** (hueco #4) **y también a nivel de estudio**: ver abajo.
- **Una técnica atiende a una clienta a la vez.** Nada de empezar una base, curar y arrancar con otra en
  paralelo. El solape dentro de una misma columna es un choque duro, no una advertencia.
- El reparto de comisión ya es por provider; un combo trabajado por dos técnicas usa
  `allocation_hands_pct` más el provider secundario de `appointment_finance`.

### El estudio tiene dos puestos, y EA no sabe contar puestos

El límite real no son las profesionales: son **dos estaciones de trabajo**. Con tres técnicas en
agenda, tres citas simultáneas son físicamente imposibles, y **EA no tiene ningún concepto de sala,
puesto o equipo** — `attendantsNumber` es capacidad por servicio, no por local. Es la restricción más
fácil de olvidar y la que produce el peor error posible: vender por la web una hora en la que no hay
silla.

- Tabla `station`: `id`, `name`, `allows` (categorías permitidas, o `null` = cualquiera). Se siembra
  con dos filas.
- `lib/conflict.ts` gana una dimensión: además de "¿la profesional está libre?", **"¿queda estación
  libre en esa franja?"**. Se resuelve con un barrido de solapes sobre todas las columnas, no solo la
  propia.
- **La disponibilidad pública tiene que aplicar el mismo filtro.** El abanico de `availabilities` por
  profesional devuelve horas que EA cree libres; la sub-API las cruza contra la ocupación de estaciones
  antes de mostrarlas. Sin ese cruce, la landing vende lo que no existe.
- **Ocupación de estación es la métrica de capacidad de verdad**, y por eso aparece en reportes: con
  dos puestos, la pregunta "¿me cabe otra técnica?" se responde mirando las estaciones, no las personas.

Queda un dato de siembra por confirmar: **¿las dos estaciones son intercambiables**, o una es de manos
y otra de pies? El modelo aguanta las dos respuestas — cambian las filas, no el código.

### Cómo funciona realmente el sync de EA (verificado en el código, no en la documentación)

**Push — inmediato.** Al guardar o borrar una cita o una indisponibilidad, EA escribe en el calendario
del provider. Si falla (token vencido, sin token, calendario borrado) **`Synchronization` se traga la
excepción y solo la escribe en su log**: la cita se guarda igual, la API responde 201, y el espejo
queda desincronizado sin que nadie se entere. El único rastro visible desde afuera es
`ea_appointments.id_google_calendar` vacío.

**Pull — solo cuando alguien lo dispara** (el botón "Sincronizar" del calendario de EA, o el comando de
consola). Y es destructivo:

| Lo que pasa en Google | Lo que EA hace |
| --- | --- |
| El evento se movió o se editó | **Reescribe la cita** local: inicio, fin y notas |
| El evento ya no está | **Borra la cita** (`$events_model->delete()`), no la cancela |
| Hay un evento que EA no conoce | **Lo importa como indisponibilidad**, copiando título + descripción a `notes` |

El borrado pasa por el modelo y no por el controlador, así que **no dispara el webhook
`appointment_delete`**: la cita desaparece, nuestra fila `appointment_finance` queda huérfana, y no hay
ningún aviso. El almuerzo familiar de una técnica, en cambio, termina siendo un bloqueo en el sistema
del estudio, con su título a la vista.

**Contenido del evento:** `summary` = nombre del servicio, `description` = notas de la cita, `location`,
y **attendees con nombre y correo del provider y de la clienta**. Quien pueda ver ese calendario ve
datos personales de las clientas.

**Scope OAuth:** `https://www.googleapis.com/auth/calendar` — lectura y escritura completas, que Google
clasifica como *sensible*.

**No existe sync a nivel de admin.** `googleSync` vive en el registro de *provider*. La dueña no puede
"conectar su calendario" desde EA: su vista se arma del lado de Google.

### La arquitectura que se adopta

```text
Cuenta Workspace del estudio (p. ej. agenda@goldenbeautystudio.com.co)
   ├─ Calendario "GBS · Lina"   ◀── provider Lina de EA, OAuth con la cuenta del estudio
   ├─ Calendario "GBS · Sara"   ◀── provider Sara de EA, misma cuenta, otro calendario
   └─ Calendario "GBS · …"
         │
         ├─▶ la dueña los agrega a SU Google Calendar → una vista, un color por técnica
         └─▶ cada técnica recibe SU calendario compartido a su Gmail personal, SOLO LECTURA
```

1. **Un calendario por técnica, todos propiedad de la cuenta de Workspace del estudio**, no de la
   técnica.
2. **Las N conexiones OAuth de EA se hacen con esa misma cuenta del estudio**, desde la sesión de EA de
   la dueña (`/index.php/google/oauth/{provider_id}`; un admin puede correr el flujo por cualquier
   provider). EA guarda token y calendario **por provider**, así que una sola cuenta sirve a las N
   columnas eligiendo un calendario distinto en cada una. La técnica no toca EA ni autoriza nada.
3. **La dueña no necesita ningún "sync de admin":** agrega los N calendarios a su propia cuenta de
   Google y los ve superpuestos, con color por técnica. El requisito se cubre sin una línea de código.
4. **Cada técnica recibe su calendario compartido a su correo personal con permiso "Ver todos los
   detalles del evento"** (solo lectura). Lo ve en la app de Google Calendar de su celular, con
   recordatorios, sin cuenta nueva y sin instalar nada.
5. **El sentido Google → EA se deja apagado.** No se corre el comando de consola de sync, y el botón
   "Sincronizar" del calendario de EA queda como acción prohibida (vive detrás de "Avanzado (EA)", solo
   `owner`). EA es la fuente de verdad; Google es un espejo. Las ausencias se registran en "Bloqueos"
   del panel, no metiendo eventos en el calendario espejo.

**Por qué así y no dándole OAuth al Gmail personal de cada técnica:**

- **La app de OAuth puede quedar *Internal*.** Con la cuenta autorizante dentro del Workspace, la
  pantalla de consentimiento es interna: sin verificación de Google, sin pantalla de "app no
  verificada", y sin vencimiento de refresh tokens. Con Gmail personales la app tiene que ser
  *External*, y ahí: en modo Testing **los refresh tokens caducan a los 7 días** — el sync se muere solo
  cada semana — y en producción el scope de calendario exige pasar la verificación de Google.
- **Solo lectura mata el modo de falla destructivo.** Si la técnica no puede borrar el evento, el pull
  no puede borrar la cita. Sumado a tener el pull apagado, son dos candados y no uno.
- **Nada personal entra al sistema del estudio.** Sin OAuth de su cuenta, EA no puede importar sus
  eventos privados como indisponibilidades.
- **Dar de baja a alguien es dejar de compartir un calendario**, no perseguir tokens.

**Lo que hay que aceptar a cambio:** la técnica **no edita** desde su teléfono — pide el cambio por el
canal de siempre y recepción lo mueve en el panel. Y **datos de la clienta viajan a un Gmail personal**:
nombre y correo van como attendees del evento. Es información que la técnica ya maneja para atender,
pero conviene dejarlo dicho en el acuerdo con cada una (habeas data, Ley 1581): el calendario se
comparte para trabajar, y se deja de compartir cuando la relación termina.

Si más adelante alguna necesita editar de verdad, la salida es darle una cuenta de Workspace (una silla
más de licencia) y conectarla como provider propio — pero eso reactiva el pull destructivo para su
columna, y hay que decidirlo sabiéndolo.

### Lo que el panel tiene que hacer al respecto

- **Equipo** muestra por profesional: sync activo sí/no, qué calendario y desde cuándo. Conectar y
  desconectar enlazan al flujo de EA, porque el token vive allá.
- **Diagnóstico vigila el push**, que es donde falla en silencio: cuenta las citas de los últimos N días
  con `id_google_calendar` vacío en providers que tienen `google_sync` activo. Cualquier número distinto
  de cero es un token vencido o un calendario borrado.
- **`appointment_finance` huérfano:** si una cita desaparece de `ea_appointments`, la fila financiera se
  queda sin par. Diagnóstico la lista; la fila de plata **nunca** se borra en cascada.
- La ficha de la cita indica si está espejada, y ofrece "Reenviar a Google" — que en la práctica es un
  `PUT` a la cita, porque el push se dispara en cada guardado.

---

## Cuenta de servicio — la técnica registra lo que hizo y lo que cobró

Lo agendado y lo realizado no son lo mismo, y la única persona que sabe la diferencia es la que estuvo
en la silla. Se reservó press-on y la clienta terminó pidiendo un forrado; pidió diseño en tres uñas;
se le rompió una y se le repuso sin cobro. **La técnica cierra su propia cuenta**: qué se hizo, qué
adicionales entraron, cuánto se cobró y qué pasó. De ahí salen la comisión y los reportes de la dueña,
sin que nadie tenga que reconstruirlo después de memoria.

### Lo que esto cambia en el modelo

Una cita deja de tener *un* precio y pasa a tener **una cuenta con renglones**. `appointment_finance`
se parte en encabezado + ítems:

| Tabla | Campos que importan |
| --- | --- |
| `appointment_finance` (encabezado) | `ea_appointment_id` UNIQUE, `booked_service_id`, `performed_service_id`, `discount`, `tip`, `amount_charged`, `payment_method`, `paid_at`, `service_notes`, `variance_reason_code`, `variance_reason`, `closed_by`, `closed_at`, `day_close_id`, `pushed_to_ingest_at` |
| `appointment_finance_item` (renglones) | `kind` (servicio\|adicional\|manual), `ea_service_id`, `pricing_id`, `qty`, `unit_price_snapshot`, `line_total`, `note` |

- **`booked_service_id` y `performed_service_id` son campos distintos y los dos se guardan.** La
  diferencia entre ambos *es* un dato de negocio: si la mitad de los press-on terminan en forrado, eso
  no es un error de la técnica, es el menú o el flujo de reserva pidiendo un ajuste.
- **La cita de EA no se reescribe.** EA guarda la *reserva*; el panel guarda la *entrega*. Cambiarle
  `id_services` a la cita dispararía la notificación de "tu cita cambió" a la clienta y reescribiría el
  evento de Google por algo que ya pasó. La agenda del panel muestra el servicio realizado con una
  marca de "cambió" una vez cerrada la cuenta.
- **Precio congelado por renglón.** El servicio agendado ya tenía su snapshot desde el webhook; el
  servicio realizado y los adicionales se congelan al cerrar la cuenta — mismo día, así que no hay
  deriva posible. Cada renglón guarda el precio de lista que se usó, no solo el total.
- **Los adicionales salen de la categoría `extras` de `pricing.ts`** (`design-per-nail`,
  `system-removal`, `single-press-on-nail`, `in-depth-foot-cleaning`…), con cantidad. Un renglón
  `manual` existe para lo que no está en el catálogo, y exige nota.
- **Invariante:** `Σ line_total − discount == amount_charged`. La propina va aparte y **nunca** entra a
  la base de comisión ni al ingreso del estudio. Vive en `lib/ticket.ts`, función pura, testeada.

### Independencia con rastro, no vigilancia

La técnica pone el número. Para que eso sea sostenible, el sistema tiene que hacer visible la
diferencia sin acusar a nadie:

- **El precio de lista siempre viaja al lado del cobrado.** La variación no se esconde ni se corrige
  sola; se muestra.
- **Si el total difiere del calculado, se pide un motivo.** Un `reason_code` de lista corta (cambió el
  servicio · adicionales · cortesía · corrección · otro) más texto libre. Sin motivo no se guarda —
  es un campo, no una auditoría.
- **`audit_log` registra cada escritura de la cuenta** con quién, cuándo y el antes/después. La cuenta
  se puede corregir; lo que no se puede es corregirla sin dejar huella.
- **Después del cierre diario la cuenta se congela.** Cambiarla exige `admin` u `owner` y genera un
  **ajuste** (renglón nuevo con su motivo), nunca una edición en sitio. La razón no es desconfianza:
  es que en ese momento los números ya salieron hacia Strapi y Actual Budget, y editar en sitio los
  desincroniza en silencio (ver abajo).

### Quién puede qué

| | `staff` (técnica) | `admin` (recepción) | `owner` |
| --- | --- | --- | --- |
| Cerrar la cuenta de **su** cita del día | ✅ | ✅ (de cualquiera) | ✅ |
| Cambiar servicio realizado, adicionales, total, observaciones | ✅ hasta el cierre diario | ✅ | ✅ |
| Registrar el método de pago | ✅ si `TICKET_STAFF_COBRA=true` | ✅ | ✅ |
| Ver totales del día y de las demás | ❌ | ✅ | ✅ |
| Hacer el cierre diario | ❌ | ✅ | ✅ |
| Corregir después del cierre | ❌ | ❌ | ✅ |
| Ver su propia liquidación y su propio ticket promedio | ✅ | — | ✅ |

`TICKET_STAFF_COBRA` existe porque la respuesta cambia con el día: en un estudio de dos personas la
técnica cobra; con recepción de planta, no. Es una decisión de operación, no de código.

### El flujo, en el celular, entre dos clientas

Desde **Hoy**, la tarjeta de su cita tiene una sola acción primaria: **"Cerrar servicio"**.

1. **¿Qué se hizo?** — viene con el servicio agendado ya elegido. Cambiarlo es un toque; la lista abre
   con los servicios de su categoría primero.
2. **Adicionales** — chips con contador (`+` / `−`), los cinco más usados adelante.
3. **Total** — grande, calculado, en cifras tabulares. Tocarlo lo hace editable y abre el motivo.
4. **Observaciones** — texto libre con chips de arranque ("cambió de servicio", "uña repuesta sin
   cobro", "llegó tarde", "alergia").
5. **Cobro** — método, si tiene permiso. Propina aparte.
6. **Guardar** — vuelve a Hoy con la cita marcada como cerrada.

Dos exigencias que no son opcionales en un flujo de celular en un salón:

- **Borrador local que sobrevive al envío fallido.** El wifi del estudio se cae; nada de lo que la
  técnica escribió puede perderse por eso. Se guarda local, se reintenta, y la cuenta queda en
  "pendiente de sincronizar" con reintento visible.
- **Nada de esto toca las notas de la cita en EA.** Las observaciones viven en `gbs_admin`. Las notas
  de EA se copian a la `description` del evento de Google, que está compartido a un correo personal —
  una observación interna sobre una clienta no tiene por qué terminar ahí.

Las observaciones sí suben a la **ficha de la clienta** y aparecen en la siguiente cita: la técnica que
la atienda dentro de tres semanas necesita saber que se le rompió una uña, y hoy eso vive en la memoria
de alguien.

### Hacia dónde fluye

- **Comisiones.** La base es el **renglón realizado**, no el servicio agendado. `commission_rule` gana
  `applies_to` (servicio principal · adicionales · ambos). Y una decisión que es de la dueña, no del
  código: **¿la comisión se calcula sobre lo cobrado o sobre el precio de lista?** Sobre lo cobrado, un
  descuento que da la técnica también le baja su comisión — el incentivo se alinea solo. Sobre lista,
  el descuento lo paga entero el estudio. Recomendado: **sobre lo cobrado, con el descuento prorrateado
  entre los renglones.** Queda pendiente de confirmar antes de la Fase 3.
- **Reportes de la dueña**, dimensiones nuevas que esto habilita y que se construyen en la Fase 5:
  ingreso por servicio **realizado** vs. agendado (la tasa de cambio de servicio es una señal del menú
  y del flujo de reserva); ingreso y tasa de enganche de adicionales por técnica; **variación de precio
  por técnica y periodo, desglosada por motivo** — un tablero de dónde se escapa la plata, no de a
  quién culpar; ticket promedio por técnica y por servicio; propinas por técnica; y el que se usa a
  diario: **cuentas sin cerrar**.
- **Strapi y Actual Budget:** el push ya no es por cita, es **por cierre diario** (ver la corrección en
  la sección de Reportes).

### Se cobra el mismo día, siempre

Una clienta nunca paga otro día. Eso convierte una pregunta contable en una regla de una línea:
**`paid_at` cae siempre en la fecha de la cita, y base caja = base servicio.** El panel, el cierre
diario, la liquidación y Actual Budget miden todos lo mismo, y ninguno tiene que llevar cuentas por
cobrar.

Se implementa como una compuerta, no como un supuesto: **el cierre diario no se puede hacer si queda
una cita completada del día sin cuenta cerrada.** La lista de pendientes es la pantalla de Caja, y
cerrar el día es el acto que la vacía.

### Fuera de alcance en la v1 (decidido el 2026-08-31)

No se construyen, y el modelo tampoco los prepara "por si acaso" — cada uno se agrega el día que exista
el caso real, no antes: abonos y depósitos, pago dividido entre dos métodos, comisión de datáfono,
devoluciones, venta de producto sin cita, arqueo de caja con base y conteo, facturación electrónica
DIAN, y política de propinas más allá del campo `tip`.

Dos notas para el día que alguno vuelva: **el retoque de garantía ya tiene salida sin construir nada**
(un renglón `manual` en cero con su nota, que sí queda contado en ocupación y en la ficha de la
clienta), y de la lista, los únicos estructurales son abonos y pago dividido — el resto son una columna
o una tabla nueva sin tocar lo existente.

---

## Comisiones — el modelo de reglas

El motor tiene que aguantar cómo se paga hoy y cómo se pague en dos años, sin que eso signifique un
editor de fórmulas. Una regla es cuatro cosas: **a quién aplica, sobre qué aplica, cuánto es, y desde
cuándo.**

### La regla

| Campo | Valores | Nota |
| --- | --- | --- |
| `provider_id` | una técnica · `null` = todas | |
| `category_id` | una categoría de `pricing.ts` (`montajes`, `retoques`, `forrados`, `sencillos`, `combos`, `extras`) · `null` = todas | Es el nivel que más se usa en la práctica: "15% en montajes, 10% en sencillos" |
| `service_id` | un servicio · `null` = todos | Para la excepción puntual |
| `applies_to` | `principal` · `adicionales` · `ambos` | Los adicionales suelen pagarse distinto, o no pagarse |
| `kind` + `percent_bp` / `fixed_amount` | `percent` en **puntos básicos** (12,5 % = `1250`) · `fixed` en pesos enteros | Dos columnas con CHECK, no una sola `value` con dos unidades: esa ambigüedad es la que cuesta cuatro órdenes de magnitud. Y un entero 0–100 no puede expresar 12,5 % |
| `valid_from` / `valid_to` | fechas, `valid_to` nulo = vigente | `valid_to` **inclusivo**: una regla que termina el 15 aplica al día 15 completo |

### Cómo se resuelve

Se evalúa **por renglón de la cuenta**, no por cita — un montaje con tres diseños puede pagar dos tasas
distintas. Gana la regla más específica:

```text
provider + service   ▶ provider + category ▶ provider
                     ▶ service             ▶ category   ▶ global
```

- Empate de especificidad ⇒ gana la de `valid_from` más reciente.
- Empate también ahí ⇒ **no se adivina**: el editor no deja guardar dos reglas idénticas en
  especificidad con vigencias solapadas. Se valida al guardar, no al liquidar.
- Sin ninguna regla aplicable ⇒ comisión cero **y el renglón se marca**, igual que un snapshot faltante.
  Cero silencioso es indistinguible de cero correcto.
- **Base = lo cobrado en ese renglón, con el descuento del ticket prorrateado.** Quien da el descuento
  también se baja su comisión, y el incentivo se alinea solo. La alternativa (sobre precio de lista) se
  descartó por eso.
- Redondeo a pesos al final del renglón, no al final de la quincena.

### El ciclo quincenal

Periodos **1–15** y **16–fin de mes** (por confirmar que ésos son los cortes reales). Estados de
`commission_run`: `borrador` → `revisada` → `pagada`.

**Nada se ajusta después de pagar** — así se trabaja hoy y el sistema lo respalda en vez de pelearlo:
una liquidación `pagada` es inmutable. Lo que hace que eso funcione es que la revisión previa sea real,
así que la liquidación **no se puede marcar como revisada mientras queden cuentas sin cerrar o días sin
cerrar en el periodo**. El bloqueo es la funcionalidad.

### El simulador es lo que hace confiable al motor

La pantalla de reglas trae un botón: **"¿Cuánto habría pagado la quincena pasada con estas reglas?"**,
con el desglose por técnica y por renglón, comparado contra lo que efectivamente se pagó. Cuesta poco
—el motor ya es una función pura sobre datos históricos— y es la diferencia entre cambiar una tasa con
confianza y cambiarla a ciegas. Ninguna regla nueva entra a producción sin pasar por ahí.

### Lo que falta para construirlo

Las reglas que rigen hoy no están escritas en ningún lado. Antes de la Fase 3 hacen falta: **las tasas
actuales por técnica y por categoría**, si los **adicionales** pagan comisión, y si existe algún
**escalonado** ("10% hasta X en la quincena, 12% por encima") — porque eso último sí cambia el modelo:
agrega un tramo por periodo que la regla actual no puede expresar.

---

## Combos — un servicio de EA cada uno

Los datos de tarifas zanjan el modelo. Un combo es un **servicio de manos + un servicio de pies
vendidos como un producto**, a un precio y una duración fijados a mano.

El constructor de combos del panel deja a la dueña elegir cualquier servicio de manos × cualquier
servicio de pies, muestra el precio y la duración sumados como *referencia*, y exige un precio y una
duración explícitos para el combo (los datos reales muestran que ambos son criterio, no fórmula).
Publicar escribe **un servicio de EA** en la categoría "Combos", más una fila `gbs_admin.combo` que
registra la composición y el reparto de comisión.

Consecuencias: la disponibilidad de EA, el flujo de reserva y el calendario funcionan de forma nativa.
Los reportes siguen atribuyendo ingreso a los servicios de manos/pies subyacentes vía `combo`. Dos
técnicas trabajando un combo se resuelve con `allocation_hands_pct` más un provider secundario opcional
en `appointment_finance` — no partiendo la cita.

Solo se publican pares curados, no el producto cruzado completo (~48 servicios enterrarían el menú).

---

## Reserva pública — reemplazo del CTA de Agenda Pro

Un flujo de reserva real en la landing: **servicio o combo → profesional o "cualquiera" → horarios en
vivo → nombre/teléfono → confirmado**, escribiendo en EA. `NEXT_PUBLIC_BOOKING_URL` se jubila.

El token de EA no puede llegar nunca al navegador, y EA no debe quedar expuesto. Por eso los Route
Handlers de la landing (`src/app/api/reservas/*`) hacen proxy a una **sub-API pública angosta en la app
admin** (`/admin/api/public/booking/*`), que guarda el token de EA y conoce los combos. Es exactamente
el patrón que `src/app/api/postulaciones/route.ts` ya usa para hacer proxy a Strapi con un secreto
server-only — se reutiliza, incluidas sus defensas: **Turnstile** (`NEXT_PUBLIC_TURNSTILE_SITE_KEY` /
`TURNSTILE_SECRET_KEY` ya están cableados), honeypot, tiempo mínimo de llenado y límite de ráfaga por
IP.

Los horarios salen de `GET /availabilities?providerId&serviceId&date`; la reserva es
`POST /appointments`. Los combos no necesitan camino especial — son un id de servicio.

### La identidad de la clienta es el teléfono

EA deduplica clientas **por correo** — `Customers_model::exists()` y `find_record_id()` lanzan si el
email viene vacío, así que sin correo EA simplemente no sabe reconocer a nadie. Y muchas clientas no
tienen correo, o dan el del esposo.

Por eso: **`require_email = false` y `require_phone_number = true` en los settings de EA**, y la
resolución de clientas la hace el panel, buscando por **teléfono normalizado a E.164** (`+57…`) antes de
crear. Nunca se inventa un correo de relleno: un correo falso viajaría como *attendee* del evento de
Google, rebotaría, y ensuciaría la ficha para siempre. Campo vacío es más honesto que campo inventado.

Consecuencia aceptada: sin correo, las notificaciones propias de EA no le llegan a la clienta. No
importa — los recordatorios van por WhatsApp.

**"Cualquiera" no existe en la API de EA**: `availabilities` exige un `providerId`. La sub-API abanica
una llamada por cada profesional habilitada para ese servicio, une los horarios y los deduplica; al
confirmar elige a quién asignar (la de menor carga ese día) y lo dice en la confirmación, para que la
clienta nunca se entere de que "cualquiera" era en realidad una decisión nuestra.

**La página pública de reservas propia de EA se apaga** (en 1.6 muestra una pantalla de aviso con botón
al backend). Dos formularios de reserva vivos es una forma elegante de darle dos disponibilidades
distintas a la misma clienta.

---

## Reportes — cambiar el productor, no construir un pipeline

`agendapro-pull.yml` scrapea Agenda Pro con Playwright y un baile de 2FA por OTP de Gmail. Ese job
entero muere. Lo que lo reemplaza es pequeño, porque el contrato aguas abajo ya existe y funciona:

```text
ANTES:   AgendaPro ──scrape Playwright──▶ Strapi /ingest/agendapro-transactions ──▶ filas Payment ──▶ actual-sync ──▶ Actual Budget
DESPUÉS: caja admin ───────POST─────────▶ (misma ruta) ─────────────────────────▶ (sin cambios) ──▶ (sin cambios) ──▶ (sin cambios)
```

**El push es por cierre diario, no por cita.** Es una corrección deliberada al plan anterior: Actual
Budget deduplica por `imported_id` y **no actualiza** el monto de una transacción ya importada. Si se
empujara al cerrar cada cuenta, corregir un ticket a las 3 p. m. dejaría a Actual con la cifra vieja
para siempre, sin error visible. Empujando al cierre del día, las correcciones intradía salen gratis, y
una corrección posterior al cierre viaja como una fila de **ajuste** propia
(`ea-tx:<id>:adj<n>`), que Actual sí importa como movimiento nuevo. `actual-sync`, el esquema `Payment`,
las rutas de Stampee y la lógica de winback siguen corriendo intactas.

**La migración de esquema** es generalizar los campos con forma de Agenda Pro: `Payment.tx_id` y
`sale_id` pasan a ser agnósticos de fuente (`source` + `source_tx_id`), con filas nuevas llaveadas
`ea-appt:<id>`.

**Lo único que no se puede equivocar:** Actual deduplica por `imported_id`, hoy
`agendapro-tx:<tx_id>`. Cambiarle el prefijo a filas históricas las re-importaría como duplicados. Así
que las filas históricas conservan su `imported_id` para siempre, las nuevas usan `ea-tx:<id>`, y
`ACTUAL_SYNC_SINCE` marca la frontera — la misma guarda de corte que el README de `actual-sync` ya
describe, usada una segunda vez.

Stampee se queda en su ruta actual de archivo + GitHub Actions, porque ya es automática. La llave
`stmp_` queda documentada como la costura para después, no se construye ahora.

### El set de reportes propio

No se copian los de Agenda Pro. Cada reporte de abajo existe porque **responde una decisión que la
dueña toma de verdad**; el que no responda ninguna, no se construye.

Y hay un eje que atraviesa todo: **con dos estaciones, la capacidad del negocio son horas de puesto, no
personas.** Donde tenga sentido, la cifra se expresa por hora de estación — es lo que convierte un
reporte en una decisión.

| Reporte | La decisión que habilita | Cadencia |
| --- | --- | --- |
| **Cierre del día** — ingreso por método, cuentas cerradas vs. pendientes, propinas, por técnica | ¿Cuadra la caja? ¿Puedo cerrar? | Diario |
| **Liquidación de la quincena** — base, comisión y total por técnica, con desglose por renglón | Cuánto se le paga a cada una | Quincenal |
| **Rentabilidad por hora de silla** — ingreso ÷ minutos de servicio, por servicio | Qué empujar y qué re-tarifar. Es el que Agenda Pro no daba y el que más plata mueve: un combo de $95k en 120 min rinde más por minuto que un montaje de $115k en 150 | Mensual |
| **Ocupación por estación y por técnica** — % sobre horas disponibles, por franja | ¿Contrato a alguien? ¿Abro otro puesto? ¿Cambio horarios? | Mensual |
| **Servicio agendado vs. realizado** — tasa de cambio y hacia qué | Arreglar el menú o el flujo de reserva, no a la técnica | Mensual |
| **Adicionales: enganche y monto por técnica** | Dónde entrenar, qué ofrecer por defecto | Mensual |
| **Variación de precio por técnica, desglosada por motivo** | Dónde se escapa la plata | Quincenal |
| **Clientas nuevas vs. que vuelven, y retención a 60 días** | Cuánto invertir en captación vs. en volver a traer | Mensual |
| **Inasistencia por franja y por origen de reserva** | Si el recordatorio funciona, y si algún horario no vale la pena abrir | Mensual |

Definiciones que se fijan una vez y se usan igual en todos lados: **ocupación** = minutos de servicios
realizados ÷ minutos disponibles (el plan de trabajo menos bloqueos; una inasistencia **no** cuenta como
ocupado); **clienta nueva** = sin ninguna cita previa en la unión EA + `legacy_appointment`;
**retención a 60 días** = % de clientas atendidas en el periodo que volvieron dentro de los 60 días
siguientes. Todas viven en `lib/metrics.ts` como funciones puras, y ningún reporte las recalcula por su
cuenta.

---

## Recordatorios por WhatsApp

Las clientas no tienen correo, así que las notificaciones propias de EA no llegan a ninguna parte. El
canal real es WhatsApp, y la inasistencia — un KPI de la portada — depende de él. El emisor vive en el
contenedor `admin`, que es el único que tiene la agenda, el scheduler y la base para no duplicar envíos.

**Lo que hay que saber antes de montarlo:**

- **Un recordatorio es un mensaje proactivo, así que va como plantilla `utility` pre-aprobada por Meta**,
  redactada en español y aprobada antes de existir el código que la manda. Se cobra por mensaje
  entregado, con tarifa por país y tramos por volumen mensual; al volumen de un estudio es
  insignificante, pero **no es cero** y no conviene descubrirlo en la factura. La exención general para
  utility dentro de la ventana de 24 h dejó de aplicar en octubre de 2025.
- **El número no se pierde.** El miedo clásico —"si paso el número a la API, no puedo volver a usar
  WhatsApp desde el celular"— ya no aplica: Meta habilitó *Coexistence* (mayo 2025, hoy en todos los
  países), que deja el mismo número activo en la app de WhatsApp Business **y** en la Cloud API a la
  vez, espejando conversaciones en ambos sentidos. Es lo que permite seguir usando el mismo número que
  ya está en `NEXT_PUBLIC_WHATSAPP_NUMBER` en la landing, en vez de pedir uno nuevo y partir la
  identidad del estudio en dos.
- **Idempotencia obligatoria.** Tabla `wa_message` con `(ea_appointment_id, kind)` UNIQUE: un recordatorio
  por cita y por tipo, pase lo que pase con reintentos o reinicios del contenedor. Duplicar un
  recordatorio es peor que no mandarlo.
- **Webhook de estado de entrega** para saber si llegó, y una columna de opt-out que se respeta siempre.
- **Qué se manda, y nada más:** confirmación al reservar desde la landing, recordatorio la tarde
  anterior, y aviso de cancelación. Promociones no — eso es categoría `marketing`, otra tarifa y otra
  conversación con el equipo.

Fuera de esto, WhatsApp queda disponible para dos cosas que el plan ya menciona y que no se construyen
todavía: el código de recuperación de acceso de una técnica que perdió el celular, y el winback que hoy
vive en el CRM.

---

## UX — paridad con EA y sistema de diseño

### La escena

Tres personas, tres posturas. La recepcionista de pie en el mesón con una tablet o su celular, entre
una clienta que llega y otra que paga, con luz de día entrando por la vitrina. La dueña en el sofá a
las 10 p. m. revisando la semana en el celular. Una manicurista mirando su liquidación del quincenal
en dos minutos entre citas.

De ahí salen tres decisiones que no se re-discuten: **tema claro** (no hay uso nocturno de escritorio y
el marfil de la marca ya es el fondo del estudio), **densidad táctil por defecto** con compacto
opcional en escritorio, y **español de Colombia únicamente** — el panel no lleva capa de i18n; los
diccionarios `es/en` son de la landing y no cruzan a `admin/`.

Este es un registro de **producto**, no de marca: la interfaz sirve a la tarea y desaparece. El
estándar no es "que no parezca hecha por IA", es que alguien acostumbrado a Linear o Stripe se siente y
confíe en cada control sin detenerse a interpretarlo.

### Paridad con EA — qué se reconstruye y qué se enlaza

La regla: **se reconstruye lo que el estudio toca cada semana; se enlaza a la interfaz propia de EA lo
que se configura una vez.** Cada campo reconstruido es un campo que hay que volver a verificar en cada
upgrade de EA, y el panel no gana nada por tener una copia bonita del formulario de LDAP.

| Pantalla de EA | Decisión | Nota |
| --- | --- | --- |
| Calendar, vista `default` (FullCalendar, filtrada a **un** provider o service) | **Reconstruir** | Se fusiona con la vista de tabla — ver abajo |
| Calendar, vista `table` (columnas por profesional, 1 o 3 días) | **Reconstruir** | ídem |
| Modal de cita | **Reconstruir** como panel lateral | + campos de caja |
| Modal de indisponibilidad (`unavailabilities`) | **Reconstruir** | Fusionado en "Bloqueos" |
| Modal de excepción de plan (`working_plan_exceptions`) | **Reconstruir** | Fusionado en "Bloqueos" |
| Blocked periods (todo el estudio) | **Reconstruir** | Fusionado en "Bloqueos" |
| Customers | **Reconstruir** | + historia unificada con `legacy_appointment` |
| Services / Service categories | **Reconstruir en lectura** | Los precios se publican desde `pricing.ts`, no se editan aquí |
| Providers | **Reconstruir** | Plan de trabajo, servicios asignados, estado de sync (solo lectura) |
| Secretaries / Admins | **Enlazar a EA** | Alta cada varios meses |
| Account (de EA) | **No exponer** | La identidad del panel es Workspace |
| Settings: general, business, booking, legal, integrations, api, google, caldav, jitsi, ldap, altcha, analytics | **Enlazar a EA**, solo `owner` | Un link "Avanzado (EA)" que abre en pestaña nueva |
| Settings → `appointment_status_options` | **Vigilar** | El panel lo lee por `GET /settings/{name}` y alerta si la lista cambió: el motor de comisiones depende de ella |
| Webhooks | **Enlazar a EA** + diagnóstico | El panel verifica que el webhook exista y apunte a él |
| Booking público de EA | **Apagar** | La landing es el único formulario de reserva |
| About / Update / Installation | **No exponer** | |

#### El regalo escondido: "Bloqueos"

EA expone tres recursos que hacen casi lo mismo y obliga a saber cuál usar. El panel no pregunta por el
recurso; pregunta **quién** y **cuándo**, y elige:

| Lo que la usuaria quiere | Recurso de EA |
| --- | --- |
| El estudio cierra el 25 y 26 de diciembre | `blocked_periods` |
| Lina no está el martes de 2 a 4 | `unavailabilities` |
| Lina el jueves entra a las 11 en vez de a las 9 | `working_plan_exceptions` |

Un solo botón "Bloquear", un solo formulario. Es una de las pocas partes donde el panel es
estrictamente mejor que EA, y sale casi gratis.

### La agenda

Es la pantalla donde el estudio pasa el día. El resto del panel se cuelga de ella.

#### Lo que EA hace hoy, y por qué no alcanza

La vista `default` es FullCalendar (`timeGridDay` / `timeGridWeek` / `dayGridMonth`, `slotDuration` de
15 min, `editable: true`, `timeGridDay` automático por debajo de 468 px) filtrada por **un** provider o
**un** service a la vez. La vista `table` pone a las profesionales en columnas para 1 o 3 días,
instanciando **un FullCalendar por columna**. Son dos páginas distintas y hay que saber a cuál ir.

El panel entrega **una sola vista, orientada a recurso**: columnas = profesionales, filas = tiempo. El
selector de rango cambia el eje horizontal (Día · 3 días · Semana), no la naturaleza de la vista. Mes
existe, pero como *resumen* de carga por día, no como grilla editable — nadie agenda dentro de una
celda de mes.

#### Construir, no comprar

Las vistas de recurso de FullCalendar (`resourceTimeGrid`) son **licencia comercial** — por eso EA
apila un calendario por columna. Las alternativas gratuitas o cuestan control visual o pelean con el
gesto táctil que queremos. La grilla se construye a mano con CSS Grid:

- Columnas: `[gutter] auto repeat(N, minmax(11rem, 1fr))`; filas de 15 min a `--slot-h` (≈14 px);
  jornada de 8:00 a 20:00 → 48 filas, ~670 px de alto. **Sin virtualización**: 6 profesionales × 48
  filas son ~290 celdas, un orden de magnitud por debajo de donde eso empieza a importar. Queda escrito
  para que nadie meta un virtualizador por reflejo.
- Los bloques se posicionan en absoluto dentro del contexto de apilamiento de su columna. Resolución de
  solapes por barrido: ordenar por inicio, asignar carril, ancho = 1/carriles. **Hace falta aunque no
  debería**: la API de EA acepta citas encimadas (hueco #4), así que la grilla tiene que saber dibujar
  el error, no romperse con él.
- Capas, de abajo hacia arriba: fuera de horario (tramado) → descansos del plan → excepciones de plan →
  bloqueos e indisponibilidades → citas → línea de "ahora".
- Gutter de horas `position: sticky; left: 0`; encabezado de profesional `position: sticky; top: 0`.
  Alto del viewport en `dvh`. Scroll inicial anclado al comienzo de la jornada, no a medianoche.
- `buildDayGrid(citas, bloqueos, planes, rango)` es **una función pura fuera de React**, igual que los
  módulos de plata. El layout de un calendario se rompe en los bordes — una cita que cruza el fin de la
  jornada, una excepción que se solapa con un bloqueo — y esos bordes se fijan con tests, no
  arrastrando el ratón.
- Si el cronograma se aprieta, el plan B es el truco de EA: un FullCalendar por columna. Se documenta
  como salida, no como destino.

#### Interacción

- **Crear:** tocar un hueco vacío abre el panel de cita con hora y profesional prellenadas.
- **Mover:** en táctil, tocar la cita → "Mover" → tocar el destino. Arrastrar sobre una grilla que
  scrollea es un modo de falla conocido. Con puntero fino (≥1024 px) sí hay drag, y el redimensionado
  por manija vive solo ahí.
- **Los choques son nuestros.** `lib/conflict.ts` corre antes de cada escritura y evalúa: profesional
  ocupada, fuera del plan de trabajo, dentro de un descanso / excepción / bloqueo, y capacidad
  (`attendantsNumber`). Si hay choque, el diálogo dice qué choca y ofrece **"Guardar de todas formas"**
  — el mismo modelo mental del `force_save` de EA. Se re-evalúa contra datos frescos al enviar, no solo
  al abrir el formulario.
- **Optimista con rollback:** el bloque se mueve al instante; si el PUT falla vuelve a su sitio y un
  toast explica por qué. Toda acción destructiva ofrece **Deshacer** en el toast en vez de un "¿Está
  seguro?" — salvo cancelar una cita, que además notifica a la clienta y por eso sí confirma.
- **Refresco:** que dos personas editen a la vez es el caso normal, no el raro. Polling del rango
  visible cada 30 s, más refetch al recuperar el foco de la ventana. No hay SSE: EA no emite eventos y
  montar un canal propio es un proceso más que mantener.
- **Teclado (escritorio):** flechas para moverse entre huecos, `n` nueva cita, `/` buscar. Cada cita es
  un `<button>` real, así el lector de pantalla tiene un recorrido lineal aunque la metáfora de grilla
  no le sirva.
- **Impresión:** hoja de ruta del día, una columna por profesional, en blanco y negro con el estado en
  texto. La recepción la pega en el mesón.

### Sistema visual

Se hereda de `src/app/globals.css`, con una corrección de registro: en la landing la tipografía display
**es** el producto; en el panel, no.

| Rol | Token | Regla |
| --- | --- | --- |
| Fondo de contenido | `--color-paper` `#fbf8f3` | |
| Segunda capa (barra lateral, toolbars, encabezados pegajosos) | `--color-cream` / `--color-ivory-deep` | Los paneles se separan del contenido por superficie, no por sombra |
| Texto | `--color-ink` / `--color-carbon`; secundario `--color-ink-soft` | `--color-ink-mute` **no** sirve para texto de cuerpo: no llega a 4.5:1 |
| Filetes | `--hair`, 1 px | |
| Dorado | `--color-gold` | Acción primaria, selección actual, anillo de foco. **Nunca** color que codifique un dato |

- **Cormorant aparece exactamente en dos lugares:** el wordmark de la barra lateral y la pantalla de
  login. En etiquetas, botones, encabezados de tabla o cifras, jamás — una serif display en una celda de
  datos es el tell de "landing disfrazada de herramienta".
- **Inter para todo lo demás**, escala fija en rem (12 · 13 · 14 · 16 · 20 · 24), razón ≈1.15. Nada de
  `clamp()`: en producto, un h1 fluido que encoge dentro de un panel se ve peor, no mejor.
- **`font-variant-numeric: tabular-nums` en todo número.** Precios, horas, totales, ids.
- **Moneda:** `Intl.NumberFormat("es-CO", { style:"currency", currency:"COP", maximumFractionDigits:0 })`
  → `$ 120.000`. Sin centavos, en pantalla y en el redondeo de comisiones.
- **Hora en formato de 12 h** (`2 p. m.`), y EA se configura igual, para que la confirmación que recibe
  la clienta y la agenda que ve la recepción digan lo mismo. En el gutter solo se marca el meridiano
  cuando cambia.
- **Foco visible siempre:** anillo dorado de 2 px, verificado a ≥3:1 contra marfil *y* contra crema.
  ⚠ **El dorado de marca no da la talla y hubo que separarlo en dos tokens.** `--color-gold` `#ac8231`
  mide 3.31:1 sobre marfil pero **2.98:1 sobre crema**, y con texto blanco encima se queda en 3.50:1 —
  falla el piso justo en la superficie de la barra lateral. El anillo de foco y el relleno del botón
  primario usan `--color-gold-dark` `#8b6a1f` (4.28:1 sobre crema, 5.02:1 con blanco); el dorado de
  marca sobrevive como filete y acento fino, donde 3:1 no aplica. Hay un test que fija los dos hechos
  para que nadie lo "corrija" de vuelta.
- **Movimiento** de 150–250 ms, ease-out, solo para comunicar estado. Nada de coreografía de carga.
  `prefers-reduced-motion` obligatorio.

#### La paleta de estados

El estado de la cita es el dato más denso de la pantalla y el dorado no puede cargarlo. Se define una
familia semántica propia — `Reservada`, `Confirmada`, `Completada`, `Cancelada`, `No asistió` — con
tres reglas duras:

1. **Nunca color solo.** Cada estado lleva punto + texto. Una persona daltónica y una hoja impresa en
   blanco y negro tienen que poder leerla.
2. **Nada de franja lateral de 4 px** (patrón prohibido): superficie tintada + borde de 1 px + punto de
   estado.
3. Contraste ≥4.5:1 de la etiqueta sobre su propio tinte, con los tintes separados en tono y
   distinguibles en deuteranopía.

Y una división que aprovecha que EA tiene los dos campos: **el color del servicio tiñe el bloque, el
estado va en el borde y el punto.** Una profesional escanea su columna y ve *qué tipo de trabajo* por
tono y *en qué va* por el cromo. Los colores de servicio se fijan desde el panel para que sigan la
paleta de marca en vez del `#7cbae8` que EA pone por defecto.

Con una salvedad que A1 descubrió leyendo la fuente: **el color del servicio no se puede leer por la
API** — es de solo escritura. La agenda lo obtiene con `with=service` (que devuelve la fila cruda, color
incluido) o por MySQL. Conviene igual, porque es la misma llamada que evita el N+1 de pedir el servicio
de cada cita por separado.

Los valores concretos ya están fijados (A3, con `dataviz`) en `admin/src/app/globals.css`, y los mismos
tonos alimentan después los gráficos de reportes. Tres cosas que quedaron decididas ahí y conviene no
deshacer:

- **`cancelada` es violeta, no roja.** Cancelar con aviso es negocio normal; con los dos desenlaces en
  rojo, un martes cualquiera la agenda parecería un incendio y **`no asistió` — el único que cuesta
  plata — quedaría enterrado**.
- **Los tintes no separan solos y nunca iban a hacerlo:** entre sí miden ΔE 1.78 en visión normal y
  **0.20** bajo deuteranopía. El punto y la palabra no son adorno, son el canal que carga el dato, y por
  eso la pastilla no tiene forma de apagar la etiqueta. Los cinco *puntos* sí pasan el gate
  todos-contra-todos (peor par ΔE 16.5 normal, 9.3 en deuteranopía).
- **Hay un sexto token, `desconocido`, que no es un sexto estado.** El `status` de EA es texto libre:
  cualquier cadena que el panel no reconozca se dibuja con filete punteado y tono neutro en vez de
  inventarle un color. Es exactamente la señal que Diagnóstico necesita el día que alguien edite la
  lista de estados en EA.

Queda una costura sin cerrar para la Ola C: **nadie ha escrito todavía el mapa entre las cadenas que
guarda EA y los cinco ids del panel.** El catálogo normaliza tildes y mayúsculas, pero traducir
`"Booked"` → `reservada` es dominio de EA (A1/C1), no del sistema de diseño.

### Navegación y pantallas

Barra lateral en ≥1024 px, riel de iconos entre 768 y 1024, y **barra inferior de cinco destinos** por
debajo — `Hoy · Agenda · Caja · Clientas · Más` — respetando `env(safe-area-inset-bottom)`.

| Pantalla | Qué resuelve | Forma en móvil |
| --- | --- | --- |
| **Hoy** | Qué pasó y dónde está la plata: ingreso y citas de hoy con delta semana a semana, agenda del día en línea, reparto por método de pago, servicios top, utilización por profesional, comisiones pendientes, inasistencia, clientas nuevas vs. que vuelven | Tarjetas apiladas; el KPI primero, el gráfico después |
| **Agenda** | La grilla de recurso | Vista día, una columna a la vez, deslizable entre profesionales |
| **Cita** | Ver / crear / mover / cancelar, cambiar estado, cobrar | Panel deslizante a pantalla completa; en escritorio, panel lateral |
| **Cerrar servicio** | La cuenta de la cita: qué se hizo, adicionales, total, observaciones, cobro. La escribe la técnica desde su propia tarjeta en Hoy | Es la pantalla **diseñada para móvil primero**; el escritorio es el caso raro |
| **Caja** | El día completo: cuentas cerradas y pendientes, totales por método, cierre diario | Lista con el pendiente arriba; el cierre solo desde tablet o escritorio |
| **Clientas** | Búsqueda, ficha, historia unida EA + `legacy_appointment` | Lista de dos líneas, nunca una tabla con scroll horizontal |
| **Comisiones** | Reglas, cálculo por periodo, liquidación por profesional, marcar pagado | Solo lectura en móvil |
| **Servicios** | Catálogo, diff contra `pricing.ts`, constructor de combos | Solo lectura en móvil |
| **Equipo** | Profesionales, plan de trabajo, excepciones, estado de sync | |
| **Reportes** | Ingreso por profesional/servicio/periodo, retención, inasistencia | Un gráfico por pantalla |
| **Diagnóstico** | ¿EA responde? ¿el webhook está registrado y apunta acá? ¿cambió la lista de estados? ¿cuántas citas sin snapshot? ¿cuántas sin espejar en Google? ¿hay filas de plata huérfanas? ¿cuándo corrió el último reconcile y el último push a ingest? | El tablero que hace sobrevivible un sistema con un solo dueño |
| **Avanzado (EA)** | Link a la interfaz de EA, solo `owner` | |

**Rol `staff`:** ve Hoy (su día), Agenda (su columna), **cierra la cuenta de sus propias citas** y ve su
liquidación y su ticket promedio. No ve totales del día, ni reportes, ni a las demás profesionales, ni
puede hacer el cierre diario. La matriz completa está en "Cuenta de servicio".

### Contrato responsive

Primera clase, no una pasada final: la recepción trabaja de pie.

| Ancho | Qué cambia |
| --- | --- |
| 390 px | Barra inferior; agenda en día con una profesional; tablas → listas de dos líneas; panel a pantalla completa |
| 768 px | Riel de iconos; agenda en día con 2–3 columnas; tablas con columnas prioritarias |
| 1024 px | Barra lateral; agenda en día / 3 días / semana; drag y resize habilitados; toggle de densidad compacta |
| 1440 px | Panel lateral persistente junto a la agenda (ver la cita sin tapar la grilla) |

- El viewport del calendario usa `dvh`, no `vh` — el chrome del navegador móvil colapsa al hacer scroll.
- Áreas táctiles ≥44 px. Ningún affordance solo-hover que cargue información real.
- **Ningún scroll horizontal en la página.** Lo único que scrollea de lado es la grilla, y lo hace
  dentro de su propio contenedor.
- Encabezados de día y de profesional, y el gutter de horas: pegajosos.

### Piso de accesibilidad

No es un programa WCAG completo; es el piso que no se negocia: contraste 4.5:1 en cuerpo y
placeholders, foco visible en todo control, ninguna acción destructiva disponible solo por gesto,
`aria-live` en los toasts, `<label>` real en cada campo, resumen de errores al enviar un formulario
largo, y respeto a `prefers-reduced-motion`.

### Estados que no son el estado feliz

Cada componente interactivo entrega los siete: default, hover, focus, active, disabled, loading, error.
Y tres estados de sistema que este panel sí va a ver:

- **EA no responde:** MySQL sigue arriba, así que el panel entra en **solo lectura** con una banda de
  aviso. Los reportes y la agenda se ven; nada se puede guardar. Mucho mejor que un formulario que
  falla al enviar.
- **Sin datos todavía:** los vacíos enseñan la interfaz ("Todavía no hay citas hoy — Nueva cita"), no
  dicen "sin resultados".
- **Cargando:** esqueletos con la forma del contenido. Nada de spinner en el centro de la pantalla.

---

## Testing

El panel calcula plata. Un bug de UI se ve; un bug de comisión se paga. La estrategia se ordena por
eso: **todo lo que decide un monto es una función pura, testeada, fuera de React.** Si un cálculo solo
existe dentro de un componente o de un handler, está mal ubicado. El layout del calendario sigue la
misma regla por la misma razón: se rompe en los bordes.

El runner es **Vitest**, ya montado en la landing (`vitest.config.mts`, `npm test`). `admin/` trae su
propio `vitest.config.mts` con la misma forma: entorno `node`, alias de `server-only` al stub de
`test/stubs/`, y `resolve.tsconfigPaths` para el alias `@/`.

### Capa 1 — Unitarios (la que no se puede negociar)

Cada módulo de abajo es lógica pura: entra data, sale un número o una decisión. Sin BD, sin red.

| Módulo | Qué se fija |
| --- | --- |
| `lib/ticket.ts` | `computeTicketTotals(items, discount, tip)`. **La invariante `Σ line_total − discount == amount_charged` no puede romperse nunca.** Cantidades en cero o negativas, renglón manual sin precio, descuento mayor que el subtotal, propina fuera de la base. Prorrateo del descuento entre renglones **sumando exacto** al descuento total: el peso de residuo se asigna de forma determinista, igual que en el reparto de combos. |
| `lib/commission.ts` | Precedencia de reglas (provider+service > provider > service > global). Bordes de `valid_from`/`valid_to` (¿inclusivo?, decidirlo y fijarlo). Porcentaje vs monto fijo. **Base = renglón realizado**, no el servicio agendado — un test explícito con cita agendada como press-on y realizada como forrado. `applies_to` (principal/adicionales/ambos). **Redondeo a pesos** — Colombia no tiene centavos, y el modo de redondeo es una decisión de negocio, no un detalle. Periodo sin reglas. Reglas solapadas. |
| `lib/combo-allocation.ts` | Repartir el precio del combo entre manos y pies por `allocation_hands_pct`. **Las partes deben sumar exacto al precio del combo** — el peso de residuo se asigna de forma determinista, nunca se pierde. Test de propiedad sobre muchos porcentajes. |
| `lib/price-snapshot.ts` | Falta la fila `appointment_finance` ⇒ cae al precio de lista **y marca la fila**. El test asegura que la marca nunca puede faltar: es lo único que separa "aviso" de "liquidación mal pagada en silencio". |
| `lib/ingest-id.ts` | `buildImportedId(source, id)`. Los namespaces `agendapro-tx:` y `ea-tx:` **no pueden colisionar jamás** — un choque duplica ingresos en Actual Budget. Test exhaustivo, no de ejemplo. |
| `lib/ingest-payload.ts` | `appointment_finance` → shape `Payment` de Strapi. `method` siempre dentro del enum (`efectivo`/`transferencia`/`otro`), monto entero, fecha en base caja. |
| `lib/ea/mapping.ts` | camelCase ↔ dominio ↔ **snake_case del webhook**, en los tres sentidos, con round-trip. **Zona horaria**: EA guarda datetimes locales; el test fija el comportamiento en `America/Bogota` y en UTC, y corre con `TZ` forzado para que no pase distinto en CI que en la VM. |
| `lib/conflict.ts` | Choque con otra cita, fuera del plan de trabajo, dentro de descanso / excepción / bloqueo, capacidad `attendantsNumber`, **y estaciones libres a nivel de estudio** (dos citas simultáneas pasan, tres no, aunque haya tres técnicas). Los límites exactos: una cita que termina justo cuando empieza otra **no** choca. Es lo que EA no valida por API. |
| `lib/totp.ts` | Código válido pasa; código de la ventana anterior con `last_used_step` ya consumido **falla** (anti-repetición); skew de ±1 step sí, de ±2 no; bloqueo a los 5 fallos; comparación en tiempo constante. Es la puerta de entrada de las técnicas: se testea como tal. |
| `lib/metrics.ts` | Ocupación (una inasistencia no cuenta como ocupado; un bloqueo reduce el denominador), clienta nueva sobre la unión EA + legacy, retención a 60 días, ingreso por hora de silla. Una definición, un solo lugar. |
| `lib/calendar-layout.ts` | `buildDayGrid()`: carriles de solape, cita que cruza el fin de la jornada, cita de duración cero, bloqueo que tapa media cita, jornada vacía. |
| `lib/webhook-verify.ts` | Header correcto pasa; ausente, vacío, o con el valor de otro webhook, falla. Comparación en tiempo constante. |
| `lib/auth-policy.ts` | `isAllowedIdentity(claims, allowlist)` — los tres casos: Workspace en la allowlist (pasa), `@gmail.com` (rechaza por `hd`), Workspace fuera de la allowlist (rechaza). El primero solo no prueba nada. |
| `lib/slots.ts` | Disponibilidad para el flujo de reserva: duración de combo, `slotInterval`, buffers, cruce de medianoche. |

### Capa 2 — Integración (MySQL real, efímero)

Un MySQL en Docker levantado por el propio test, no un mock del driver:

- Las migraciones de `gbs_admin` aplican en limpio y son idempotentes.
- El handler de webhook de EA escribe **exactamente una** fila `appointment_finance`, y un reenvío del
  mismo evento no crea una segunda. (EA **no** reintenta: el reenvío que hay que soportar es el
  nuestro — el reconcile y el reproceso manual desde `webhook_event`.)
- El reconcile crea las filas de las citas cuyo webhook se perdió, y no duplica las que sí llegaron.
- Las queries de reporte contra un dataset semilla dan los totales esperados.

### Capa 3 — Contrato contra EA

Una suite corta contra una instancia desechable de EA que verifica los supuestos de este documento: que
`blocked_periods` y `unavailabilities` responden, que appointments acepta `from`/`till`, que el payload
es camelCase, que `POST /appointments` **sigue sin validar choques**, y que el webhook llega con la fila
cruda en snake_case. No prueba EA; prueba **que seguimos teniendo razón sobre EA**. Es la mitigación
concreta del riesgo "actualizaciones de EA" listado abajo, y se corre después de cada upgrade.

### Capa 4 — E2E (Playwright)

Lo que Vitest no puede: los Server Components `async`. Playwright ya se usa en el CRM
(`automation/agendapro-pull`), así que no es herramienta nueva.

- Login: redirige sin sesión, entra con cuenta de Workspace.
- La agenda renderiza el día y permite crear una cita.
- Mover una cita encima de otra ofrece "Guardar de todas formas" en vez de guardar callado.
- Reserva pública de punta a punta, y Turnstile rechazando un envío sin token.
- Cerrar una cita en caja.

### El test que reemplaza la conciliación manual

Un **golden test** sobre una semana fija de citas de fixture que afirma los totales exactos de ingreso,
propinas y comisión por profesional. Convierte el paso "conciliar una semana real línea por línea" de
la sección de verificación en algo repetible: se concilia una vez a mano, y ese resultado se congela
como el fixture esperado.

### Política

- **Cada fase entrega sus tests con el código.** No hay una fase "de testing" al final.
- **Cobertura con umbral solo sobre los módulos de plata** (`lib/commission`, `lib/combo-allocation`,
  `lib/price-snapshot`, `lib/ingest-*`, `lib/conflict`): 100% de ramas. Un número global de cobertura
  sobre todo el panel no significa nada y se cumple con tests de relleno.
- **CI en cada PR**: `npm run lint && npm test` en la landing y en `admin/`. En `admin/` los tests son
  **compuerta del build de la imagen**: si fallan, no hay imagen y no hay despliegue. En la landing no
  corren en `prebuild` — un test lento o inestable no debe poder bloquear un deploy de la landing.
- **Lo que NO se testea:** EA en sí, Strapi en sí, Actual Budget en sí. Se testean nuestras
  suposiciones sobre ellos (capa 3) y nuestros mapeos hacia ellos (capa 1).

---

## Fases

El orden de dependencia importa: **caja antes que comisiones**, porque las comisiones deben basarse en
lo que realmente se cobró, no en el precio de lista. **Cada fase incluye sus tests** — ver la sección de
Testing arriba.

**0 — Cimientos.**
*Infra:* inventario del stack real de la VM · Dockerfile de `admin/` (standalone, no-root, amd64) ·
`deploy/compose/gbs-stack.yml` con `admin` + `admin-migrate` · entrada en Caddy · stack de Portainer
apuntando al repo con polling · GHCR y las dos credenciales en Portainer · `admin-image.yml` · rewrite
de Vercel, arreglo de `proxy.ts`, `vercel.json`, `.vercelignore` · `/admin/api/health`.
*Respaldos:* el servicio `db-backup`, el bucket en GCS y **el ensayo de restauración** — antes de que
exista un solo dato de plata que perder.
*App:* Better Auth + Google · login TOTP de las técnicas (`lib/totp.ts`, enrolamiento por QR) · cliente tipado de EA (`admin/src/lib/ea/`) con el mapeo
camelCase↔dominio↔snake_case en un solo lugar · migraciones de `gbs_admin` · tokens, paleta de estados
(`dataviz`) y kit de componentes; shell con `impeccable` · leer `src/api/visit/services/ingest.ts` en el
CRM para fijar el contrato de ingest de visitas.

**1 — Espejo de EA.** *Agenda* (la grilla de recurso, `from`/`till`/`with=`, crear/mover/cancelar/
estado, `lib/conflict.ts`), *Bloqueos* (los tres recursos bajo un solo formulario), *Clientes*
(búsqueda, detalle, historia entre EA + `legacy_appointment`), *Servicios* (lectura + diff contra
`pricing.ts`), *Equipo* (providers, planes de trabajo, excepciones, estado de sync), *Diagnóstico*.
Aquí también se monta el espejo de Google: proyecto de Google Cloud con consentimiento **Internal**, un
calendario por técnica en la cuenta de Workspace del estudio, las N conexiones OAuth desde la sesión de
la dueña, y los calendarios compartidos en solo lectura a los correos personales.

**2 — Caja y cuenta de servicio.** La pantalla "Cerrar servicio" (móvil primero) con servicio realizado,
adicionales, total con motivo de variación, observaciones y cobro; permisos de `staff` y borrador local
que sobrevive a la caída de red. Caja del día con pendientes y totales por método. Cierre diario que
congela las cuentas. Webhook + reconcile nocturno + backfill de snapshots para citas anteriores. Push
a la ruta de ingest de Strapi **al cerrar el día**, con el camino de ajuste para correcciones
posteriores.

**3 — Comisiones.** Editor de reglas, cálculo por periodo, liquidación por profesional, marcar pagado.
Una fila `appointment_finance` faltante cae al precio de lista **y marca la fila visiblemente** — nunca
una liquidación mal calculada en silencio.

**4 — Combos + reserva.** Constructor de combos → servicio de EA. Flujo público de reserva en la
landing; apagar el booking propio de EA; jubilar `NEXT_PUBLIC_BOOKING_URL`.

**5 — Dashboard + reportes.** El home de KPIs y los reemplazos de reportes de Agenda Pro (`dataviz`).

**6 — Corte.** Jubilar `agendapro-pull.yml` y las credenciales de Agenda Pro.

---

## Corte (cutover)

1. Exportar clientas de Agenda Pro → `POST /customers` en EA (deduplicar por teléfono).
2. Exportar histórico → `gbs_admin.legacy_appointment`. **No** rellenar el calendario de EA; la historia
   de la clienta lee la unión de ambos.
3. **Fijar la lista de estados** en los settings de EA, en español y con los dos que EA no trae:
   `Reservada`, `Confirmada`, `Reprogramada`, `Completada`, `No asistió`, `Cancelada`. Se hace **antes**
   de que existan citas reales: el estado es texto plano por fila y renombrarlo después no migra nada.
4. Correr en paralelo un ciclo de facturación completo: agendar en EA, y conciliar las filas `Payment`
   nocturnas y las cifras de Actual Budget contra el reporte de Agenda Pro antes de confiar en el panel.
5. Solo entonces desactivar `agendapro-pull.yml` y cancelar Agenda Pro.

---

## Verificación

### Confirmar en la VM antes de escribir código

1. `curl -H "Authorization: Bearer $TOKEN" https://<ea-host>/index.php/api/v1/services` → 200. También
   dice si el URL rewriting está activo (o sea, si hace falta `/index.php`).
2. ✅ **Versión de EA: 1.6.0, confirmada en la VM el 2026-08-31** con
   `docker exec golden-agenda grep "config['version']" /var/www/html/application/config/app.php`.
   Es exactamente la versión contra la que se leyó todo este documento, así que `slotInterval`,
   `blocked_periods` y `unavailabilities` existen y los hallazgos de la API aplican tal cual. **Lo que
   queda pendiente es pinearla**: el stack corre `:latest`, y un pull cualquier noche la puede mover.
3. `docker compose config`, `docker network ls`, `docker volume ls` → nombres de servicio y red reales.
4. `INGEST_URL` + `INGEST_SHARED_SECRET` de Strapi alcanzables desde la VM.

### Por fase

- `cd admin && npm run dev` → `localhost:3000/admin` contra una **EA de staging**, nunca producción,
  hasta que la Fase 1 esté aprobada.
- **Auth, los tres casos:** una cuenta de Workspace (pasa), un `@gmail.com` personal (rechazado en el
  chequeo de `hd`), una cuenta de Workspace ausente de `allowed_user` (rechazada en la allowlist). El
  primero solo no prueba nada.
- **Rewrite:** preview de Vercel con `ADMIN_ORIGIN` seteado — `/admin` sirve la app de la VM, los chunks
  `/admin/_next/*` resuelven, `/es` y `/bio` sin afectar.
- **CI:** un push solo-`admin/` no crea deployment en Vercel; un push solo-`src/` no construye imagen.
- **Despliegue:** un merge a master aparece corriendo en la VM dentro del intervalo de polling, sin que
  nadie entre por SSH. `docker inspect` muestra el digest esperado.
- **Rollback, ensayado una vez antes de producción:** `git revert` del commit de despliegue → esperar el
  polling → la versión anterior está sirviendo. Un rollback que nunca se ejecutó no existe.
- **Registro:** bajar la imagen privada de GHCR a mano en la VM una vez, para probar la credencial de
  Portainer antes de depender de ella.
- **Zona horaria:** `docker exec admin date` da hora de Bogotá, y una cita creada a las 3 p. m. se lee a
  las 3 p. m. en EA.
- **Aislamiento:** parar el contenedor `admin` no afecta a EA. Un `admin` en bucle de reinicio no agota
  la memoria de la VM (los límites están puestos).
- **Pérdida de webhook, provocada a propósito:** parar `admin`, crear una cita en EA, levantar `admin` →
  el evento **no** llegó (confirma que EA no reintenta) y el reconcile lo recupera. Es la prueba de que
  el diseño aguanta su propio modo de falla.
- **Cuenta de servicio, el caso que la justifica:** una cita agendada como `press-on`, cerrada por la
  técnica como forrado + 3 diseños, con motivo. La liquidación de esa técnica usa el servicio
  **realizado**, el reporte de ingreso por servicio también, y la cita en EA sigue diciendo `press-on`
  (es la reserva, no la entrega). Si algún reporte usa el agendado, el modelo se implementó mal.
- **Permisos de `staff`, los tres bordes:** cierra su propia cita (pasa), intenta abrir la cuenta de
  otra técnica (rechazado en el DAL, no solo oculto en la UI), intenta editar después del cierre diario
  (rechazado). Ocultar un botón no es un permiso.
- **Red caída al guardar la cuenta:** con el celular en modo avión, llenar y guardar → nada de lo
  escrito se pierde, la cuenta queda pendiente y se sincroniza sola al volver la red.
- **Ingest:** cerrar el día → aparecen las filas `Payment` en Strapi con los `tx_id` esperados →
  `npm run dry-run` en `automation/actual-sync` muestra exactamente una transacción mapeada nueva.
  Correrlo dos veces y confirmar que la segunda no agrega nada (dedupe de `imported_id` aguantando).
- **Reserva:** una reserva real desde la landing aparece en el calendario propio de EA, y Turnstile
  rechaza un envío sin token. Con "cualquiera", el abanico devuelve la unión de horarios de todas las
  técnicas habilitadas, no los de una sola.
- **Espejo de Google, los cuatro casos:** una cita creada en el panel aparece en el calendario de esa
  técnica y en ninguna otra; la dueña la ve superpuesta en su propia cuenta; la técnica la ve en su
  Gmail personal; y la técnica **no puede** editarla ni borrarla (permiso de solo lectura).
- **Push roto, detectado:** revocar a mano el token de una técnica, crear una cita → la cita **se
  guarda igual y la API responde 201** (EA se traga el error), y Diagnóstico la muestra como no
  espejada. Si Diagnóstico no la muestra, el chequeo no sirve.
- **Responsive:** cada módulo a 390 px, 768 px y 1440 px antes de darlo por terminado, y la agenda además
  en una tablet real, de pie — es la postura en la que se usa.
- **Plata:** conciliar una semana real línea por línea contra el reporte de Agenda Pro. Un número de
  ingreso o comisión que no se concilió contra una fuente confiable no está verificado.

---

## Decisiones pendientes

Lo que todavía bloquea código, con la fase que lo necesita. Todo lo demás de la revisión del
2026-08-31 quedó resuelto o explícitamente fuera de alcance.

| Decisión | Por qué bloquea | Se necesita para |
| --- | --- | --- |
| **Las tasas de comisión que rigen hoy**, por técnica y por categoría | El motor no tiene qué calcular | Fase 3 |
| ¿Los **adicionales** pagan comisión? | Es el campo `applies_to` de cada regla | Fase 3 |
| ¿Existe algún **escalonado** por volumen de quincena? | Sí cambia el modelo: la regla actual no expresa tramos | Fase 3 (decidir antes de escribir `lib/commission.ts`) |
| ¿Los cortes quincenales son **1–15 / 16–fin**? | Bordes del periodo, y no se pueden mover después de la primera liquidación | Fase 3 |
| ¿Las **dos estaciones** son intercambiables o especializadas? | Solo cambia la siembra de `station`, no el código | Fase 1 |
| ¿Qué trae realmente el **export de Agenda Pro** — hay dinero por cita? | Define si la continuidad de reportes históricos es real o es una promesa vacía | Corte |
| Número de WhatsApp: ¿**Coexistence** sobre el número actual, o uno nuevo? | Define el alta en Meta y las plantillas | Fase 5 |

Resueltas el 2026-08-31: **EA corre 1.6.0** (confirmado en la VM; falta pinearlo); el panel va en un
**stack propio `gbs-admin` desde Git**, sin tocar el de la agenda, que está en modo web editor; el
subdominio es **`panel.goldenbeautystudio.com.co`**, en la familia de `booking.`; y **no hacen falta
credenciales en Portainer** porque el repositorio es público y el paquete de GHCR también lo será.

**Riesgo aceptado, dicho en voz alta:** una sola persona tiene Portainer, Google Cloud, GHCR, Workspace
y la VM. No hay plan de continuidad y se decidió no construirlo. Queda escrito para que sea una
decisión y no un olvido.

---

## Riesgos abiertos

- **El webhook de EA no reintenta.** Es el riesgo operativo más probable de todos: cada despliegue del
  panel es una ventana de eventos perdidos. Mitigación estructural: reconcile nocturno como mecanismo
  principal, `webhook_event` como rastro, y Diagnóstico mostrando el conteo de citas sin snapshot.
- **El pull de Google borra citas.** Si alguien dispara "Sincronizar" en el calendario de EA y un
  evento ya no está en Google, EA **borra** la cita local sin disparar webhook. Es la única operación
  del sistema que puede hacer desaparecer una cita en silencio. Tres candados: el pull nunca se corre,
  los calendarios de las técnicas se comparten en solo lectura, y Diagnóstico lista las filas
  `appointment_finance` que quedaron sin cita.
- **El push a Google falla en silencio.** `Synchronization` traga la excepción y la manda al log de EA;
  el panel nunca ve un error. La única señal es `id_google_calendar` vacío, y por eso Diagnóstico la
  vigila.
- **La API de EA acepta citas encimadas.** Toda la validación de choques es nuestra; si alguien agenda
  por fuera del panel (el backend de EA, o el booking público si quedara vivo) puede aparecer un solape
  que el panel dibuja pero no evitó.
- **Editar una cuenta ya empujada desincroniza Actual Budget en silencio.** Actual no actualiza el monto
  de una transacción ya importada. Por eso el push va por cierre diario y las correcciones posteriores
  viajan como ajuste con id propio. Si alguien "arregla" esto empujando por cita, el error vuelve.
- **La técnica pone el número.** Es la decisión que hace usable el sistema y también la que abre la
  puerta a errores y a fuga. Las tres defensas son de diseño, no de confianza: precio de lista siempre
  visible al lado del cobrado, motivo obligatorio cuando difieren, y `audit_log` de cada escritura. El
  reporte de variación por técnica existe para ver dónde se escapa la plata, no para vigilar a nadie —
  si se usa como tablero de sospecha, el equipo empieza a no registrar los adicionales y se pierde el
  dato entero.
- **La deriva de precios** es el riesgo de corrección de todo el sistema. Un snapshot perdido valora en
  silencio una cita vieja al precio de hoy — de ahí la marca visible más el reconcile. Y con tres
  lugares donde vive un precio, publicar en un solo sentido no es un lujo.
- **Colisiones de `imported_id`** duplicarían ingresos en Actual. La frontera de prefijo y
  `ACTUAL_SYNC_SINCE` son estructurales; verificar con un dry-run repetido antes de ir a producción.
- **Actualizaciones de EA.** Los reportes leen su esquema directo y el handler de webhook depende de
  nombres de columna. Fijar la versión de EA (imagen con tag, no `latest`) y correr la suite de contrato
  después de cualquier upgrade.
- **Credenciales que caducan en Portainer** (PAT de GHCR, PAT de Git). El síntoma es "el despliegue dejó
  de actualizar", sin error a la vista. Documentar vencimientos o emitir sin expiración.
- **Deriva por intervención manual en la VM.** Con el stack en modo Git, un `docker compose up` a mano se
  pierde en el siguiente polling. Es la regla que más fácil se rompe cuando algo urge de noche.
- **Radio de explosión compartido con EA.** Acotado con límites de recursos, sin volúmenes compartidos y
  sin `depends_on` de EA hacia el panel — pero siguen compartiendo host, CPU y disco.
- **El origen del panel es alcanzable desde internet** para que Vercel pueda hacer rewrite hacia él.
  Caddy responde 404 fuera de `/admin` y Cloudflare va adelante con rate limiting; la auth es la
  compuerta real. Endurecimiento disponible más adelante: un `cloudflared` en el mismo stack elimina el
  puerto entrante por completo.
- **La duración del combo es criterio, no aritmética.** Si el constructor llegara a auto-calcular la
  duración, el calendario se desviaría de la realidad — el campo se queda explícito.

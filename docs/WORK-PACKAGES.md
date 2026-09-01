# Paquetes de trabajo — cómo se reparte el panel entre agentes

Este documento parte `docs/ADMIN-PANEL.md` en unidades que un agente puede tomar de punta a punta:
construir, testear y dejar verificable. **No sustituye al plan** — cada paquete apunta a las secciones
que tiene que leer antes de escribir una línea.

## Cómo se ejecuta esto

- **Un paquete = un agente = un worktree.** Se lanza con `isolation: "worktree"` para que dos agentes
  en paralelo no se pisen el árbol. Se mergea cuando su Definition of Done está verde.
- **La propiedad de archivos es exclusiva.** Cada paquete lista las rutas que le pertenecen. Si un
  agente necesita tocar algo fuera de su lista, se detiene y lo reporta — no lo edita.
- **Los tests van con el código, siempre.** No hay un paquete "de testing" al final; hay un auditor
  adversarial que ataca lo ya construido (ver Roles).
- **Nadie deduce el comportamiento de EA de memoria.** Se lee el código fuente de EA o se le pregunta a
  `gbs-ea-scout`. Cada supuesto equivocado sobre EA en este proyecto costó un rediseño.
- Antes de dar un paquete por terminado: `npm run lint && npm test` en `admin/`, más los puntos de
  Verificación del plan que le correspondan.

## Roles de agente

| Agente | Qué hace | Qué NO hace |
| --- | --- | --- |
| `gbs-builder` | Implementa un paquete completo con sus tests | Salirse de las rutas que le pertenecen |
| `gbs-money-auditor` | Ataca las invariantes de plata y de auth con tests que intentan romperlas | Arreglar el código — solo reporta y deja el test rojo |
| `gbs-verifier` | Corre la checklist de Verificación del paquete y reporta con evidencia | Escribir o editar código |
| `gbs-ea-scout` | Contesta "¿qué hace EA realmente?" leyendo su fuente | Opinar sobre nuestro diseño |

**Por qué el que construye también escribe los tests, y aparte hay un auditor:** un agente que escribe
tests contra código que no escribió tiende a escribir tests que describen lo que el código hace, no lo
que debería hacer. El builder fija el comportamiento esperado; el auditor intenta demostrar que está
mal. Son trabajos distintos y opuestos, y por eso no los hace el mismo agente.

## Orden de dependencia

```text
WP-0  andamiaje  (bloqueante, pequeño)
   │
   ├── Ola A  ─ A1 cliente EA · A2 esquema+repos · A3 diseño+shell · A4 infra
   │              (los cuatro en paralelo)
   │
   ├── Ola B  ─ B1 motores de plata · B2 auth+TOTP · B3 motor de agenda · B4 webhook+reconcile
   │              (necesita A1 y A2; B3 solo A1)
   │
   ├── Ola C  ─ C1 agenda UI · C2 cuenta de servicio · C3 caja+cierre · C4 clientes/servicios/equipo
   │              (necesita A3 y su motor de la Ola B)
   │
   └── Ola D  ─ D1 comisiones · D2 reserva pública · D3 WhatsApp · D4 reportes+diagnóstico
```

---

## WP-0 — Andamiaje de `admin/` · ✅ ENTREGADO (2026-08-31)

**Dueño de:** `admin/package.json`, `admin/tsconfig.json`, `admin/eslint.config.mjs`,
`admin/next.config.ts`, `admin/vitest.config.mts`, `admin/test/stubs/`, `admin/src/app/layout.tsx`,
`admin/src/app/api/health/route.ts`, carpetas vacías de `lib/`, `db/`, `components/`.
**Lee:** § Topología · § Contenedor (La imagen) · § Testing (política).
**DoD:** `basePath: "/admin"`, `output: "standalone"`, cero `NEXT_PUBLIC_*`, `server-only` aliaseado al
stub, `/admin/api/health` responde, `npm run lint && npm test` verde con un test trivial.

Es pequeño a propósito: todo lo demás forkea de aquí, así que no puede tardar.

**Verificado:** `npm run lint`, `typecheck`, `test` (6 tests) y `build` verdes; el `server.js` de
standalone sirve `/admin` → 200, `/admin/api/health` → 200, `/` → 404 (que es lo correcto con
`basePath`); la landing sigue con sus 78 tests y su lint intactos, ya excluyendo `admin/` de
`tsconfig.json` y `eslint.config.mjs`.

Dos cosas que salieron de construirlo y que valen para los paquetes siguientes:

- **El healthcheck reporta la zona horaria efectiva vía `Intl`, no `process.env.TZ`.** La variable
  miente en los dos sentidos: en Git Bash sobre Windows un prefijo `TZ=...` no llega al proceso aunque
  la zona sí sea la correcta. Un healthcheck que mirara la variable sería ruido permanente.
- **Un `server.js` de standalone corriendo bloquea `.next/` en Windows** y el siguiente `next build`
  falla dejando el árbol a medias. Hay que bajar el proceso antes de reconstruir.

---

## Ola A — contratos e infraestructura (4 en paralelo)

### A1 — Cliente tipado de EA · ✅ ENTREGADO (2026-08-31)

`admin/src/lib/ea/`: `types.ts`, `datetime.ts`, `mapping.ts`, `errors.ts`, `client.ts`, `index.ts` y sus
tests. **132 tests verdes bajo `TZ=UTC` y bajo `TZ=America/Bogota`**, 9 saltados (la suite de contrato,
que se salta sola sin `EA_CONTRACT_URL`). Lint y typecheck limpios, cero `any`.

Decisiones que el plan no fijaba y que quedan como contrato para los demás paquetes: el tipo canónico
del dominio es **la hora de pared** (`EaLocalDateTime` marcado), no `Date` — convertir en el borde es
donde nacen los bugs de cinco horas; `list()` pagina hasta agotar y **lanza** si toca el tope en vez de
devolver un resultado parcial, mientras `listPage()` exige `length` y devuelve `hasMore`; el mapeo es
**una tabla por recurso** de la que se derivan los cuatro codecs, así que agregar un campo "solo de ida"
no compila. Los hallazgos sobre EA están en § Lo que EA nos da.


**Dueño de:** `admin/src/lib/ea/**`.
**Lee:** § Lo que EA nos da · § Anatomía del webhook · § Testing capas 1 y 3.
**Entrega:** tipos de dominio; mapeo **camelCase ↔ dominio ↔ snake_case del webhook** en un solo lugar;
cliente con Bearer; helpers de `from`/`till`/`with=`; el esqueleto de la suite de contrato (capa 3).
**Invariantes:** round-trip en los tres sentidos; tests con `TZ` forzado en `America/Bogota` **y** UTC.
**Es el contrato del que dependen casi todos los demás paquetes: sale primero de la ola.**

### A2 — Esquema `gbs_admin` y repositorios · ✅ ENTREGADO (2026-08-31)

`admin/src/db/`: 15 migraciones numeradas + libro `schema_migration` con checksum, tipos de Kysely,
16 repositorios y una suite de integración contra **MySQL 8 real y efímero** (se salta sola sin Docker).
Merge verificado: **173 tests verdes**, lint y typecheck limpios.

Decisiones que quedan como contrato: **tasas en puntos básicos** (`percent_bp`) y montos fijos en
columnas separadas con CHECK, porque un solo `value` con dos unidades es la ambigüedad que cuesta
órdenes de magnitud, y un entero 0–100 no expresa 12,5 %; **plata `INT` por fila y `BIGINT` en
agregados**, verificado contra `information_schema`; `DATE` como string y `DATETIME` como `Date`, porque
los cortes de quincena son calendario y no instantes; `webhook_event` **no guarda el cuerpo**, solo su
hash — reprocesar es re-pedirle la cita a la API, y guardar el cuerpo metería teléfono y nombre de la
clienta en una tabla de log sin retención.

Hallazgo que vale para todos: **MySQL 8 rechaza un `CHECK` sobre una columna que participe de una acción
referencial de FK.** Tres claves pasaron a `ON UPDATE RESTRICT` para conservar sus CHECK. El error solo
aparece al aplicar, no al escribir.

**Pendiente que hereda A4:** `npm run migrate` **no existe todavía y no es trivial**. El loader nativo de
TypeScript de Node no resuelve los imports de directorio (`./migrations` → `./migrations/index.ts`) que
sí resuelve el bundler, así que las migraciones corren bajo Vitest pero no como script suelto. El
servicio `admin-migrate` necesita que A4 decida cómo: lo más limpio es empaquetar `src/db/migrate.ts`
con esbuild en el build de la imagen, que ya es dependencia de Next. `main()` está exportado y listo.


**Dueño de:** `admin/src/db/**` (migraciones, tipos Kysely, repositorios).
**Lee:** § Modelo de datos · § Cuenta de servicio · § Comisiones · § Respaldos.
**Entrega:** **todas** las migraciones del esquema en un solo set ordenado — `allowed_user`,
`appointment_finance`, `appointment_finance_item`, `day_close`, `webhook_event`, `commission_rule`,
`commission_entry`, `commission_run`, `combo`, `service_map`, `station`, `staff_totp`,
`legacy_appointment`, `audit_log`, más las tablas de Better Auth. Usuario MySQL de solo lectura sobre
`easyappointments`.
**Por qué todas juntas:** si cada paquete trae su migración, los números chocan al mergear. Ningún otro
paquete escribe migraciones; si le falta una columna, la pide.
**DoD:** aplican en limpio, son idempotentes, y corren contra un MySQL efímero en Docker.

### A3 — Sistema de diseño y shell · ✅ ENTREGADO (2026-08-31)

31 archivos: tokens y paleta de estados en `globals.css`, kit en `components/ui/**`, shell responsive en
`components/shell/**`, y la **galería en `/admin/galeria`**. Merge verificado: **279 tests verdes**, lint,
typecheck y build limpios. La galería se revisó de verdad en navegador a 390 / 768 / 1440 con capturas
leídas — `scrollWidth == clientWidth` en los tres anchos — y salieron tres defectos visuales que ya
están corregidos (el botón `loading` se veía igual que `disabled`, la pastilla se estiraba a barra
dentro de una grilla, y "Deshacer" partía en dos líneas a 390 px).

Decisiones que quedan como contrato:

- **La escala fija se impone mecánicamente**, no por convención: `--text-*: initial` y
  `--color-*: initial` borran las de Tailwind, así que `text-2xl` o `bg-blue-500` ya no compilan a nada.
- **Los componentes son clases CSS reales** en `@layer components`, no cadenas de utilidades repartidas
  por veinte `.tsx`: el contraste está medido en un solo lugar.
- **`Panel` es un `<dialog>` nativo con `showModal()`** — capa superior sin pelear `z-index` con los
  encabezados pegajosos de la agenda, trampa de foco y Escape gratis.
- **`DataTable` renderiza las dos formas y CSS elige**, sin `matchMedia`: funciona en Server Components,
  no parpadea en la primera pintura y la hoja de impresión sale bien. A 390 px `visibleColumns()`
  devuelve **cero** columnas a propósito, para que nadie llame responsive a una tabla de dos columnas.
- **Con Deshacer la escritura ya ocurrió**; el toast revierte en vez de retrasar, porque dos personas
  editando a la vez es el caso normal y retrasar dejaría la agenda mintiendo seis segundos.
- Los formateadores de COP y hora quedaron en `components/ui/format.ts` porque `lib/**` era de otro
  paquete. Son puros y sin dependencias: moverlos es un `git mv` cuando convenga.


**Dueño de:** `admin/src/app/globals.css`, `admin/src/components/ui/**`, `admin/src/components/shell/**`.
**Lee:** § UX completo. **Carga la skill `impeccable` antes del shell y `dataviz` antes de fijar la
paleta de estados.**
**Entrega:** tokens derivados de la landing; Cormorant solo en wordmark y login; escala fija en rem;
`tabular-nums`; formateadores de COP y hora 12 h; paleta semántica de estados (fill + borde + punto,
nunca color solo, nunca franja lateral); AppShell responsive (sidebar ≥1024, riel 768–1024, barra
inferior abajo con `env(safe-area-inset-bottom)`); DataTable que colapsa a lista de dos líneas;
Panel que es sheet en móvil y diálogo en escritorio; los siete estados por componente; skeletons;
empty states; toast con Deshacer.
**DoD:** contraste verificado ≥4.5:1 en cuerpo y placeholders, foco visible a ≥3:1 sobre marfil y crema,
y una página de galería de componentes revisada a 390 / 768 / 1440.

### A4 — Contenedor, stack, CI/CD y respaldos · ✅ ENTREGADO (2026-08-31)

Imagen, stack `gbs-admin`, workflow de GHCR, respaldos, el rewrite de la landing y **`docs/DEPLOY.md`**
(575 líneas de runbook con comandos copiables). Verificado corriéndolo, no describiéndolo: la imagen
levanta (311 MB, usuario `node`, hora de Bogotá), sirve `/admin` **con CSS de 41 KB** y `/` → 404, el
healthcheck queda `healthy`, y el migrador empaquetado aplicó las 15 migraciones desde cero contra un
MySQL efímero, dos veces, también desde dentro de la imagen. El ensayo de **restauración de respaldo**
se ejecutó de verdad. La landing quedó verde y el control negativo se hizo: quitando `admin` del matcher
de `proxy.ts`, `/admin` vuelve a redirigirse a `/es/admin`.

Tres correcciones a supuestos del plan:

- **`esbuild` no viene con Next 16.2.6** (Next usa Turbopack/Rust, Vitest usa Rolldown). Entró como
  devDependency de `admin/`. El brief de este paquete afirmaba lo contrario.
- **GitHub Actions no permite `paths` y `paths-ignore` juntos** en el mismo evento; el workflow habría
  sido inválido. Quedó solo `paths`, que ya excluye `deploy/compose/.env`, más el `[skip ci]`.
- **`.gitignore` ignoraba `deploy/compose/.env`** por su regla `.env`, con lo cual el canal de CI/CD no
  existía. Se agregó la excepción `!deploy/compose/.env`: ese archivo lleva una sola línea, el digest de
  la imagen, y ningún secreto.

Y un detalle de Alpine que vale oro: **sin `tzdata` en la imagen, `TZ=America/Bogota` se ignora en
silencio y el contenedor corre en UTC** — exactamente el bug de cinco horas que el plan lleva
persiguiendo desde el principio.

Riesgo documentado que nadie puede verificar sin desplegar: algunas versiones de Portainer escriben las
variables del stack en un `.env` dentro del clon, **el mismo nombre que el nuestro**. El síntoma y el
arreglo están en `docs/DEPLOY.md`.


**Dueño de:** `admin/Dockerfile`, `admin/.dockerignore`, `deploy/compose/**`,
`.github/workflows/admin-image.yml`, `vercel.json`, `.vercelignore`, `next.config.ts` (raíz),
`src/proxy.ts`.
**Lee:** § Contenedor, stack y despliegue · § Respaldos · § Verificación (infra).
**Entrega:** imagen multi-stage no-root amd64 que **copia `public/` y `.next/static`** al layer final;
servicios `admin`, `admin-migrate` y `db-backup`; `TZ=America/Bogota`; healthcheck; límites; entrada de
Caddy; workflow que testea → construye → empuja a GHCR → escribe el digest en `deploy/compose/.env` con
`[skip ci]`; `ignoreCommand` con `admin/`, `deploy/`, `docs/`, `.github/`; `admin` fuera del matcher de
`proxy.ts`.
**No toca una sola línea de código de aplicación**, por eso corre en paralelo con todo.
**DoD:** despliegue real por polling de Portainer, **ensayo de rollback** y **ensayo de restauración de
respaldo** ejecutados, no descritos.

---

## Ola B — motores (4 en paralelo)

### B1 — Motores de plata · ✅ ENTREGADO (2026-08-31) · `gbs-money-auditor` pendiente

Siete módulos y 4.714 líneas en `admin/src/lib/`: `ticket`, `commission`, `combo-allocation`,
`price-snapshot`, `ingest-id`, `ingest-payload`, `metrics`. **100 % de ramas en los siete**, ahora
**atornillado con umbrales por archivo** en `vitest.config.mts` — el 100 % de hoy no sirve si mañana
entra una rama sin test.

El **golden test** cubre una semana real (dos técnicas, diez cuentas, once renglones) con los esperados
**calculados a mano renglón por renglón antes de correr nada**: ingreso $870.000, propinas $60.000,
comisión $67.292 / $31.800. Incluye a propósito la cita agendada press-on y cerrada como forrado + 3
diseños, un combo a cuatro manos, un renglón manual en cero, una inasistencia y un prorrateo con
residuo que no cae redondo.

Decisiones que quedan como contrato:

- **El signo vive en el precio unitario, no en la cantidad** (`qty ≥ 1` siempre). Con signo en los dos
  campos, `qty −2 × precio −1000 = +2000`: una devolución indistinguible de un cobro, y ninguna
  validación local puede separarlas.
- **Editar el total deriva el descuento**; escribir *más* que el subtotal se rechaza, porque eso es un
  renglón que falta y no un descuento negativo.
- **Redondeo simétrico medio-arriba**, no medio-par: una corrección cancela exacto el cobro que corrige.
- **Un `fixed` paga una vez por renglón, no por unidad** — se sigue de "se evalúa por renglón", y hay
  que confirmarlo con la dueña junto con las tasas.
- **La comisión no se recorta a la base**: un fijo de $50.000 sobre $10.000 devuelve $50.000, porque es
  una regla mal configurada y recortarla la escondería.
- **Empate total de reglas ⇒ gana el id mayor y se marca.** El editor de D1 debería impedirlo, pero los
  datos también entran por SQL y el motor no puede confiar en el editor.
- **Ocupación devuelve `null`, no cero**, cuando no hay horas disponibles: promediar ceros de domingos
  cerrados hunde el mes. Retención: las cohortes cuya ventana no se cumplió salen `pending`, fuera del
  denominador, o un mes reciente se vería catastrófico y mejoraría solo.

**Dos cosas que hay que confirmar antes de C3:** los nombres de campo de `ingest-payload.ts` están sin
verificar (el plan manda leer `src/api/visit/services/ingest.ts` del CRM, **repo no disponible desde
acá**; está marcado con ⚠ en el archivo), y las dos llaves de la misma cita — `ea-appt:<id>` para la
fila `Payment` de Strapi y `ea-tx:<id>` para el `imported_id` de Actual — están implementadas como
namespaces disjuntos con test, pero el plan nunca las cruza explícitamente.
**Dueño de:** `admin/src/lib/ticket.ts`, `commission.ts`, `combo-allocation.ts`, `price-snapshot.ts`,
`ingest-id.ts`, `ingest-payload.ts`, `metrics.ts`.
**Depende de:** A1, A2. **Lee:** § Cuenta de servicio · § Comisiones · § Reportes · § Testing capa 1.
**Reglas duras:** funciones puras, sin React, sin BD, sin red. Invariante
`Σ line_total − discount == amount_charged`. Prorrateo y reparto de combo **suman exacto**, con el peso
de residuo asignado de forma determinista. Redondeo a pesos por renglón. Sin regla aplicable ⇒ cero
**marcado**. `agendapro-tx:` y `ea-tx:` no colisionan nunca.
**DoD:** 100 % de cobertura de ramas en este paquete, y el golden test de una semana de fixture.
**Bloqueo parcial:** el motor se construye completo, pero las **tasas reales** son una decisión
pendiente (§ Decisiones pendientes). Se implementa con reglas de fixture, no inventadas como default.

### B2 — Auth: Workspace, TOTP y DAL · ✅ ENTREGADO (2026-08-31) · `gbs-money-auditor` pendiente

`auth-policy.ts`, `totp.ts`, `auth.ts`, `dal.ts` y las pantallas de `(auth)`. **100 % de ramas** en
`auth-policy` (32/32), `totp` (53/53) y `dal` (12/12), ya atornillado con umbrales. Verificado **en
navegador y contra MySQL real**, no deducido: login TOTP completo, cookie
`__Secure-…; Path=/admin; HttpOnly; Secure; SameSite=Lax` **sin `Domain`** y firmada, anti-repetición
persistida, skew ±1 sí / ±2 no, bloqueo exactamente al quinto fallo, y el `redirect_uri` real que se le
manda a Google. Login revisado a 390 / 768 / 1440.

**Cómo resolvió el TOTP como factor primario:** endpoint de plugin propio dentro de Better Auth, no un
Route Handler suelto — la cookie de sesión va **firmada** con el secreto de la instancia, y un handler
propio tendría que reimplementar esa firma. Es el mismo patrón que usa el `magic-link` de la librería.
La decisión vive en `planTotpAttempt()`, que es pura y testeada; el endpoint solo traduce a escritura,
sesión y código HTTP.

Decisiones que quedan como contrato:

- **Se rechaza `step <= last_used_step`, no solo `==`.** Si alguien entró con el código de las 10:00:30,
  el de las 10:00:00 sigue dentro de la tolerancia y es justo el que un mirón habría visto.
- **Un código malformado no gasta intento; uno repetido sí.**
- **El rol se lee de `allowed_user` en cada `verifySession()`**, no se copia a la sesión: sacar a alguien
  de Equipo lo saca del panel en la request siguiente, sin esperar 30 días.
- **`verifySession()` falla cerrada** si la base no responde, para que el login siga alcanzable.
- **`locked_until` a ~100 años en vez de `NULL`**, para que la columna signifique siempre lo mismo.

Las dos correcciones al plan que encontró leyendo la fuente de Better Auth están en § Auth. Pendientes
que hereda C4: la **UI de enrolamiento (QR)** — el servidor ya está listo con `enrollStaffTotp()` y
`confirmStaffTotp()`. Y `auth.ts` queda en ~33 % de cobertura automática porque su endpoint necesita
MySQL: se verificó a mano contra una base real, y corresponde una prueba de capa 2 cuando exista el
harness.
**Dueño de:** `admin/src/lib/auth.ts`, `auth-policy.ts`, `dal.ts`, `totp.ts`,
`admin/src/app/(auth)/**`.
**Depende de:** A2, A3. **Lee:** § Auth completo, con la subsección de TOTP.
**Ojo:** el plugin de dos factores de Better Auth **no sirve como factor primario** — exige un primer
factor y sesión iniciada. El login de las técnicas es una ruta propia que verifica el código y crea la
sesión con la API de servidor. Es código de auth escrito a mano: se testea como tal.
**Invariantes:** anti-repetición por `last_used_step`; skew ±1 y no más; bloqueo a los 5 fallos;
comparación en tiempo constante; secreto cifrado en reposo; `hd` + `email_verified` + allowlist para
Workspace; `verifySession()` memoizado invocado desde **cada** Server Component, Action y Route Handler.
**DoD:** los tres casos de Workspace y los bordes de TOTP en tests; un `staff` no alcanza rutas de caja
ni de reportes **en el DAL**, no solo en la UI.

### B3 — Motor de agenda (puro) · ✅ ENTREGADO (2026-08-31)

`calendar-layout.ts` y `conflict.ts` con **100 % de statements, ramas, funciones y líneas**, y tests de
invariancia de zona: la grilla serializada da byte a byte lo mismo bajo UTC, Bogotá, Kiritimati (+14) y
Niue (−11).

- **El resultado del conflicto no es un booleano**: cada motivo trae severidad, mensaje en español, el
  tramo exacto a resaltar y los sujetos con los que choca, para que el diálogo diga "Lina ya tiene a
  Marcela de 2 a 3:30" sin volver a consultar nada. Nueve motivos.
- **Dos severidades, las dos forzables.** `hard` = físicamente imposible; `soft` = política de horario.
  Las dos ofrecen "Guardar de todas formas": un motor que impidiera guardar empuja a la recepción a
  arreglarlo fuera del panel, que es donde el dato deja de existir.
- **Estaciones por emparejamiento bipartito, no por conteo.** Con puestos especializados, contar está
  mal: dos citas de pies y un solo puesto de pies dan "2 citas, 2 puestos" y una clienta se queda
  parada.
- **`attendantsNumber` resuelto leyendo la fuente de EA**, no inventando: `consider_multiple_attendants()`
  cuenta por misma técnica + mismo servicio y descarta el slot en cuanto hay una cita de otro servicio
  encima. Con capacidad 1 —el caso de hoy— degenera literalmente en "una técnica, una clienta".
- **Una cita cancelada libera la silla, y EA no hace esto**: `has_provider_conflict()` consulta
  `appointments` sin mirar `status`. Divergencia deliberada, con `freeStatuses` parametrizable.
- **Citas huérfanas se reportan, no se descartan.** Una cita que desaparece de la agenda sin aviso es el
  peor modo de falla de esa pantalla.

Y un defecto de infraestructura que encontró y que estaba rompiendo a los agentes en paralelo:
**`ephemeral-mysql.ts` publicaba un puerto fijo**, así que dos suites simultáneas chocaban con "port is
already allocated" y la segunda fallaba por una razón ajena al código que probaba. Ahora publica
`0:3306` y le pregunta el puerto a Docker. Habría mordido igual en CI con dos jobs concurrentes.
**Dueño de:** `admin/src/lib/calendar-layout.ts`, `admin/src/lib/conflict.ts`.
**Depende de:** A1. **Lee:** § La agenda · § El estudio tiene dos puestos.
**Entrega:** `buildDayGrid()` con carriles de solape y capas; `lib/conflict.ts` con choque por columna,
fuera de plan, descansos, excepciones, bloqueos, `attendantsNumber` **y estaciones a nivel de estudio**.
**Recordar:** la API de EA acepta citas encimadas, así que la grilla tiene que **dibujar** el error sin
romperse, y el motor tiene que detectarlo antes de escribir.
**DoD:** bordes en tests — cita que cruza el fin de jornada, duración cero, bloqueo que tapa media cita,
dos citas simultáneas pasan y tres no aunque haya tres técnicas.

### B4 — Webhook, reconcile y snapshot de precio · ✅ ENTREGADO (2026-08-31)

`webhook-verify.ts`, el handler partido en `route.ts` (solo lee el entorno) + `handler.ts`
(`Request → Response`, testeable sin Next), `jobs/snapshot.ts` y `jobs/reconcile.ts`, con 24 tests de
capa 2 contra MySQL real. Integrado: **795 tests verdes**, lint, typecheck y build limpios.

- **La idempotencia no la cuida el código, la cuida `uq_af_ea_appointment`**: se inserta y se atrapa el
  choque, en vez de consultar primero. Hay un test que dispara dos webhooks concurrentes con cuerpos
  distintos sobre la misma cita y verifica que queda una sola fila.
- **Dos niveles de dedup, distintos a propósito**: `webhook_event` corta el reproceso del mismo evento;
  el índice único corta la segunda fila aunque el evento sea otro.
- **El reconcile mira también hacia adelante** (7 días atrás, 60 adelante): una cita reservada en
  diciembre para enero tiene que congelar la tarifa del día en que se presta, y `from`/`till` de EA
  filtran por fecha de cita, nunca por fecha de reserva.
- **El reconcile repara `fallback`.** Sin eso, una fila creada con EA caído se quedaba sin precio para
  siempre: el barrido solo busca citas *sin fila*, y ésa ya tiene una.
- **`appointment_delete` no borra la fila de plata** — es el libro de caja; solo deja rastro.
- Verificó las mutaciones: quitar el día extra del rango rompe 1 test, volver el fallback un precio
  silencioso rompe 4.

**Y encontró un agujero de seguridad en el plan.** El documento afirmaba que el endpoint del webhook
"solo se alcanza desde la red interna". Era falso: el rewrite de la landing manda `/admin/:path*`
entero, así que llegaba desde internet por dos caminos, con el header estático —que EA no usa para
firmar el cuerpo— como único filtro. Cerrado en **Caddy** con un `respond 404` para
`/admin/api/webhooks/*`: EA le pega al contenedor directo por la red de Docker y nunca pasa por Caddy.

Integrado además lo que B4 no podía tocar: `src/jobs/**` entró al `include` de cobertura, y el
**reconcile quedó cableado** — `reconcile-cli.ts`, `build:reconcile` con esbuild, el `RUN` en el
Dockerfile y el servicio `admin-reconcile` en el stack, a las 03:45 (después del respaldo de las 03:15,
para que el dump no agarre filas a medio escribir). El bundle corre y falla limpio sin `DATABASE_URL`.

**Nota que no hay que "arreglar":** este Route Handler **no** pasa por el DAL de B2. EA no tiene sesión.
Está escrito en el código para que nadie lo uniforme y deje el webhook mudo.
**Dueño de:** `admin/src/app/api/webhooks/ea/**`, `admin/src/lib/webhook-verify.ts`,
`admin/src/jobs/reconcile.ts`.
**Depende de:** A1, A2. **Lee:** § Anatomía del webhook · § Modelo de datos · § Testing capa 2.
**Recordar:** EA **no reintenta**; el payload es la fila cruda en snake_case y **no trae precio**; la
firma es un header estático. El reconcile es el mecanismo principal, no el respaldo.
**DoD:** una fila `appointment_finance` por evento y ni una más ante reproceso; el reconcile recupera lo
perdido y no duplica lo que sí llegó; el drill de "parar el contenedor, crear cita, levantar" pasa.

---

## Ola C — superficies (4 en paralelo)

### C1 — Agenda UI y Bloqueos
**Dueño de:** `admin/src/app/(panel)/agenda/**`, `admin/src/components/calendar/**`.
**Depende de:** A3, B3. **Lee:** § La agenda · § El regalo escondido: Bloqueos.
Grilla de recurso con CSS Grid (nada de FullCalendar: `resourceTimeGrid` es licencia comercial), gutter
y encabezados pegajosos, `dvh`, tap-para-mover en táctil y drag solo con puntero fino, optimista con
rollback, polling de 30 s con refetch al foco, hoja de impresión. Bloqueos: un formulario, tres recursos
de EA por debajo.

### C2 — Cuenta de servicio (móvil primero)
**Dueño de:** `admin/src/app/(panel)/hoy/**`, `admin/src/components/ticket/**`.
**Depende de:** A3, B1, B2. **Lee:** § Cuenta de servicio completo.
Los seis pasos, chips de adicionales con contador, total editable que exige motivo, observaciones que
**no** viajan a las notas de EA, y **borrador local que sobrevive al envío fallido** — no es un extra,
es requisito.
**DoD:** el caso completo (agendado `press-on`, cerrado como forrado + 3 diseños, con motivo) y la
prueba en modo avión.

### C3 — Caja, cierre diario y push a ingest
**Dueño de:** `admin/src/app/(panel)/caja/**`, `admin/src/lib/ingest-client.ts`,
`admin/src/jobs/day-close.ts`.
**Depende de:** B1, B4. **Lee:** § Cuenta de servicio (se cobra el mismo día) · § Reportes.
**La compuerta es la funcionalidad:** no se cierra el día con una cita completada sin cuenta. El push va
**por cierre diario**, y la corrección posterior viaja como ajuste con id propio.
**DoD:** el dry-run de `actual-sync` muestra exactamente las transacciones nuevas, y correrlo dos veces
no agrega nada.

### C4 — Clientes, Servicios y Equipo
**Dueño de:** `admin/src/app/(panel)/clientes/**`, `/servicios/**`, `/equipo/**`.
**Depende de:** A1, A3. **Lee:** § Paridad con EA · § Catálogo y precios · § La identidad de la clienta ·
§ Lo que el panel tiene que hacer (sync).
Identidad por **teléfono E.164**, nunca correo inventado. Diff `pricing.ts` ↔ EA con publicación en un
solo sentido. Equipo muestra estado de sync y enrolamiento TOTP. Todo lo que es configuración de una vez
enlaza a EA en vez de reconstruirse.

---

## Ola D — integraciones (4 en paralelo)

### D1 — Comisiones · **bloqueado por decisiones**
**Dueño de:** `admin/src/app/(panel)/comisiones/**`.
**Depende de:** B1, C3. **Lee:** § Comisiones completo.
Editor de reglas con validación de solapes al guardar, `commission_run` con
`borrador → revisada → pagada` inmutable, y **el simulador** ("¿cuánto habría pagado la quincena pasada
con estas reglas?"), que es lo que hace confiable al motor.
**No arranca hasta tener:** tasas actuales, si los adicionales pagan, si hay escalonado, y los cortes.

### D2 — Reserva pública
**Dueño de:** `admin/src/app/api/public/booking/**`, `src/app/api/reservas/**` (landing),
`src/app/[lang]/_components/` del flujo de reserva.
**Depende de:** A1, B3. **Lee:** § Reserva pública · § El estudio tiene dos puestos.
Abanico de `availabilities` por técnica (no existe "cualquiera" en EA), **cruzado contra ocupación de
estaciones** antes de mostrar horarios — sin ese cruce la landing vende sillas que no existen. Turnstile,
honeypot, tiempo mínimo, límite por IP, reusando el patrón de `postulaciones`. Apagar el booking propio
de EA y jubilar `NEXT_PUBLIC_BOOKING_URL`.

### D3 — Recordatorios por WhatsApp
**Dueño de:** `admin/src/lib/whatsapp/**`, `admin/src/jobs/reminders.ts`.
**Depende de:** A2, C1. **Lee:** § Recordatorios por WhatsApp.
Plantillas `utility` aprobadas antes del código, `wa_message` con UNIQUE `(cita, tipo)`, webhook de
estado, opt-out. Coexistence deja conservar el número actual de la landing.
**Bloqueado por decisión:** Coexistence sobre el número actual o número nuevo.

### D4 — Reportes y Diagnóstico
**Dueño de:** `admin/src/app/(panel)/reportes/**`, `/diagnostico/**`.
**Depende de:** B1 (`metrics.ts`), C3. **Lee:** § El set de reportes propio · § Diagnóstico.
**Carga `dataviz` antes de la primera línea de gráfico.** Los nueve reportes, cada uno atado a una
decisión; nada de números decorativos. Diagnóstico: EA vivo, webhook registrado, lista de estados sin
cambios, citas sin snapshot, citas sin espejar en Google, filas de plata huérfanas, último reconcile,
último push, **antigüedad del último respaldo en rojo a las 48 h**.

---

## Reglas que todo agente respeta

1. **No inventar tipos compartidos.** Vienen de A1 y A2. Si falta uno, se pide; no se duplica local.
2. **No escribir migraciones fuera de A2.**
3. **No tocar `src/` de la landing** salvo A4 (proxy, next.config, vercel) y D2 (rutas de reserva).
4. **No deducir EA de memoria** — fuente o `gbs-ea-scout`.
5. **Ningún cálculo de plata dentro de un componente o un handler.** Si aparece ahí, está mal ubicado.
6. **Responsive no es una pasada final:** 390 / 768 / 1440 antes de dar algo por terminado.
7. Un paquete que descubre que el plan está equivocado **para y reporta**; no rediseña por su cuenta.

# Lo que falta para cancelar Agenda Pro

Plan de cierre. Estado: **decisiones tomadas (2026-09-17).** X1, X2, X3 y X5 construidos; X6 resuelto
como configuración; X7 a medias (falta lo que depende de Meta); X8 es operación.

Complementa `docs/ADMIN-PANEL.md` (el diseño) y `docs/WORK-PACKAGES.md` (el reparto). Este documento
responde una sola pregunta: **qué falta, exactamente, para que el estudio deje de pagar Agenda Pro.**

## El punto de partida, verificado

Las cuatro funciones que la dueña nombró como imprescindibles ya están construidas. No es una promesa
del plan: es código con 1.700 tests verdes y despliegue por digest en la VM.

| Lo pedido | Dónde vive | Estado |
| --- | --- | --- |
| Registrar pagos | `(panel)/hoy` (cuenta de servicio) + `(panel)/caja` (cierre diario, push a ingest) | ✅ |
| Ventas totales | `(panel)/reportes` — nueve reportes, ninguno decorativo | ✅ |
| Comisiones | `lib/commission.ts` + `(panel)/comisiones`, quincenas `borrador → revisada → pagada` | ✅ correcto para la técnica actual |
| Clientas con teléfono | `(panel)/clientes`, identidad por E.164, historia EA + `legacy_appointment` | ⚠️ **solo lectura, y la base sigue en Agenda Pro** |
| Citas con servicio, clienta y hora | `(panel)/agenda` + `components/calendar` | ✅ |

Así que lo que falta **no son funciones nuevas**: son las piezas que convierten un panel que funciona
en un panel del que se puede depender el lunes siguiente. Ocho paquetes, en orden de dependencia.

---

## Decisiones tomadas el 2026-09-17

Cierran cuatro de las siete filas de § Decisiones pendientes del plan, y dos de ellas **agrandan** el
trabajo. Queda escrito para que no se relea como si fueran un detalle.

| Pregunta | Respuesta | Consecuencia |
| --- | --- | --- |
| ¿Cómo pagan las clientas? | Efectivo y transferencia, **y a veces una cuenta se parte entre los dos** | **Pago dividido entra al alcance.** Estaba fuera de la v1 y es uno de los dos ítems que esa lista marcaba como *estructurales* |
| ¿Qué exporta Agenda Pro? | Clientas **+ histórico + montos cobrados** | La continuidad de reportes es real, no una promesa. `legacy_appointment` se llena completo y el importador vale la pena entero |
| ¿La comisión es 40 % plano? | **Una técnica, 40 % para ella / 60 % para el negocio.** La dueña no atiende | La regla sembrada en `018` ya es correcta. X4 deja de ser bloqueante — pero **entra una segunda técnica en los próximos meses**, y ahí la regla global se vuelve una trampa |
| ¿Cortes quincenales? | **1–15 y 16–fin de mes** | Ya está implementado exactamente así en `lib/commission.ts`, con febrero cubierto. Nada que hacer |
| ¿Número de WhatsApp? | **Coexistence sobre el número actual** | Desbloquea D3. El trámite en Meta arranca ya: no depende de nosotros y tarda días |

---

## X1 — Pago dividido

**Lo primero, y no por tamaño: por orden.** Toca el esquema de plata, y todo lo que se cierre antes
de este cambio hay que migrarlo después. Cuanto más tarde entre, más filas hay que mover.

Hoy `appointment_finance.payment_method` es un `ENUM('efectivo','transferencia','otro')`: **un método
por cuenta**. Una clienta que paga $60.000 en efectivo y transfiere $40.000 no se puede registrar sin
mentir en uno de los dos, y esa mentira sale por el otro extremo — el cierre del día descuadra contra
el efectivo que hay en el cajón, que es justo el número que la dueña usa para confiar en el sistema.

**Forma:** tabla hija `appointment_payment (appointment_finance_id, method, amount)`, **única fuente
de verdad**. `paid_at` se queda arriba — se cobra el mismo día, es un solo instante.

⚠ **Corrección sobre lo que este documento decía** (aplicada al construirlo): el plan mandaba *borrar*
`payment_method` del encabezado, porque tener el método en dos lugares es tenerlo mal en uno de los
dos. No se borra, por dos razones que solo se ven leyendo el código:

1. **El set de migraciones es forward-only y sin `DROP`**, y no es una intención: `migrations.test.ts`
   lo afirma con un test que falla si aparece uno.
2. **El rollback es un `git revert` del commit de despliegue**, que devuelve la imagen anterior. Si la
   migración borrara la columna, el código viejo consultaría una columna que ya no existe — o sea, el
   rollback dejaría de funcionar justo el día que se necesita, que es el día que este cambio salga mal.

Así que expand/contract: la columna se queda, nadie la lee, y se sigue escribiendo como **shim de
rollback** — con un método, su método; con dos, `null`, que la imagen anterior muestra como "sin
método", visible y reclamable, en vez de afirmar un método que no fue. El `DROP` es una migración
posterior, cuando el digest actual lleve semanas sin que nadie quiera volver atrás.

El invariante `Σ pagos == amount_charged` **no puede ser un CHECK** (cruza tablas, MySQL no lo
expresa), así que vive en `lib/ticket.ts`, al lado del invariante de renglones que ya está ahí, con
cobertura de ramas al 100 %.

**Lo que arrastra, y es más de lo que parece:**

- `019-appointment-payment` con **backfill en la misma migración**: cada fila con `payment_method` no
  nulo se convierte en un pago único por su `amount_charged`. Idempotente, como todas.
- `jobs/day-close.ts` — los totales por método se agregan sobre pagos, no sobre cuentas. La compuerta
  (no se cierra el día con una cita completada sin cuenta) no cambia.
- `lib/ingest-payload.ts` + `lib/ingest-id.ts` — **una cuenta dividida son dos filas `Payment`**, con
  `ea-appt:<id>:efectivo` y `ea-appt:<id>:transferencia`. Es lo correcto y no un rodeo: la plata aterrizó
  en dos lugares distintos, y Actual Budget las quiere como dos transacciones. El test exhaustivo de
  no-colisión de `ingest-id` cubre el namespace nuevo contra `:adj<n>` y contra `agendapro-tx:`.
- `components/ticket/TicketSheet.tsx` — de un selector a dos montos, con el segundo autocompletado
  como "el resto". La suma se valida antes de dejar cerrar.
- `components/ticket/draft-store.ts` — **hay borradores viejos en el `localStorage` de los celulares
  del equipo** con la forma anterior. El store los migra al leer; si no, la técnica abre la app y
  pierde lo que había escrito. Es el modo de falla fácil de olvidar de este paquete.
- `(panel)/reportes/aggregate.ts` y `(panel)/caja/CajaVista.tsx` — agrupar por pago, no por cuenta.

**DoD:** una cuenta de $100.000 partida 60/40 aparece correcta en Caja, en el cierre del día, en los
nueve reportes, y llega a Strapi como dos `Payment`; `npm run dry-run` en `actual-sync` las muestra
las dos, y correrlo dos veces no agrega nada.

### Estado: ✅ construido (2026-09-17), sin desplegar

Migración `019-appointment-payment` con backfill idempotente, repositorio, la invariante
`Σ pagos == amount_charged` en `lib/ticket.ts`, cierre diario y reportes sumando pago por pago, dos
filas `Payment` hacia Strapi para una cuenta partida, y la hoja del celular con los dos montos y la
cifra que falta en vivo. **1.736 tests verdes**, lint y build limpios; 36 tests nuevos.

Tres cosas que salieron de construirlo y que el plan no anticipaba:

- **Un ajuste posterior al cierre no trae método propio** — la pantalla pide monto y motivo. Con una
  cuenta partida hay que elegir uno, porque `Payment.method` en Strapi es obligatorio: se usa **el
  pago más grande**, determinista y en un solo lugar. No es la verdad, es la apuesta más probable. El
  día que ajustar cuentas partidas deje de ser raro, lo correcto es que la pantalla pregunte.
- **La llave de ingest de una cuenta de un solo método no cambia.** Sigue siendo `ea-appt:<id>` pelada;
  solo las partidas llevan el método adentro (`ea-appt:<id>:efectivo`). Uniformar las dos formas
  habría re-llaveado las filas que Strapi y Actual **ya tienen**, importándolas de nuevo como
  movimientos nuevos — duplicando el ingreso histórico completo, en silencio.
- **La propina va entera en el primer movimiento**, no prorrateada. Repartirla daría dos cifras que
  suman bien y que por separado no significan nada.

## X2 — Importador de Agenda Pro

Sin esto no hay corte: los teléfonos que importan siguen allá. Es un script one-shot
(`admin/scripts/import-agendapro.ts`), no una pantalla — se corre dos o tres veces en la vida.

**Fase A · clientas → `POST /customers` de EA.** El trabajo real no es el POST, es el teléfono:

- Normalizar a E.164 colombiano: móviles `3XXXXXXXXX` → `+573XXXXXXXXX`, fijos con indicativo,
  extensiones, espacios y guiones, números de 7 dígitos sin indicativo (**no se adivina el indicativo**:
  van al informe de conflictos).
- Deduplicar contra lo que EA ya tenga, por teléfono. Nunca por correo, y **nunca inventando un
  correo** — es la regla de identidad del plan.
- Un informe al final, no un log: cuántas entraron, cuántas se fusionaron, cuántas quedaron sin
  teléfono utilizable y con qué nombre. Esa última lista la revisa una persona.

**Fase B · histórico → `gbs_admin.legacy_appointment`**, con `source_id` UNIQUE (correr dos veces no
duplica) y `amount_charged` real, ahora que sabemos que el export lo trae.

⚠ **`legacy_appointment` no se empuja a ingest, nunca.** Esa plata **ya está en Actual Budget**, metida
por el scraper nocturno con `imported_id = agendapro-tx:<tx_id>`. Empujarla otra vez duplicaría el
ingreso histórico completo, en silencio, sin error visible. La tabla existe solo para que los reportes
del panel tengan pasado. Queda escrito acá porque es exactamente el tipo de "mejora" que alguien
agrega con buena intención seis meses después.

**DoD:** correrlo dos veces no duplica nada; la ficha de una clienta real muestra sus citas de Agenda
Pro y las de EA en una sola línea de tiempo; "clientas nuevas" del primer mes post-corte no cuenta a
toda la base como nueva.

### Estado: ✅ construido (2026-09-17) · falta correrlo contra el archivo real

`src/jobs/import-agendapro.ts` (todo puro: CSV, mapeo de columnas, fechas, plan de clientas, plan de
historia) + su CLI, empaquetado como `scripts/importar.js`. **61 tests.** Ejecución en seco por
defecto, `--aplicar` para escribir, `--solo-clientas` / `--solo-historia` para correr una mitad.

**La normalización de teléfonos no se escribió: ya existía.** `(panel)/clientes/identity.ts` tiene el
E.164 colombiano completo, con el `+` explícito ganando sobre el indicativo por defecto. El importador
la reusa, así que la deduplicación del import y la de la ficha son literalmente la misma función — que
es la única forma de que no se separen.

Cuatro decisiones que salieron de construirlo:

- **El mapeo de columnas se adivina y se imprime.** Nadie acá ha visto el archivo que Agenda Pro
  produce, así que escribir el parser contra una forma inventada sería escribir un parser para tirar.
  Se detecta por sinónimos del encabezado, se imprime qué eligió para cada campo, y se anula con
  `--col-phone=2`. Sin columna de teléfono **no corre**: es la llave de la identidad.
- **Las fechas se leen día primero.** `03/04/2025` es el 3 de abril. Es la decisión más peligrosa del
  paquete porque las dos lecturas producen una fecha válida: un error no falla, importa dos años con
  los meses corridos y se descubre cuando alguien no reconoce sus citas. El CLI imprime el **rango**
  justamente para que eso se vea antes de aplicar. Una fecha sin hora se ancla al mediodía, no a
  medianoche, para que ningún corrimiento la cruce al día anterior.
- **Las filas sin teléfono no se descartan en silencio**: se agrupan, se cuentan y se imprimen con
  nombre. Son las clientas a las que hay que pedirles el número, y perderlas sin decir nada es el modo
  de falla silencioso de todo el corte.
- **Los correos de relleno no se importan.** `sin@correo.com` y compañía quedan en `null`. Importarlos
  sería volver a sembrar el problema que la ficha ya detecta: un correo falso viaja como *attendee* del
  evento de Google, rebota, y ensucia la ficha para siempre.

Lo que falta es correrlo contra el archivo real y ajustar los sinónimos de encabezado si hace falta —
que es una línea por columna, no lógica. El runbook está en `docs/DEPLOY.md`.

## X3 — Clientas de lectura y escritura

Hoy `(panel)/clientes` no tiene `actions.ts`: se busca, se ve la ficha, y nada más. La única ruta que
crea una clienta en todo el sistema es el flujo de reserva pública. Eso significa que recepción **no
puede corregir un teléfono mal digitado ni dar de alta a una clienta que entró caminando** sin
meterse a la UI propia de EA — que es justo la que el panel existe para no usar.

- Crear y editar (nombre, teléfono, notas) por la API de EA (`customers.create/update`), con
  `audit_log` de cada escritura.
- **Fusionar duplicadas**, que el importador va a destapar. EA no tiene "merge", pero
  `appointments.update` sí acepta `customerId`: se reasignan las citas y se borra la duplicada.
  `appointment_finance` no guarda clienta, así que la plata no se toca — la fusión es segura por
  construcción, y vale la pena decirlo antes de que alguien se ponga nervioso al ejecutarla.

### Estado: ✅ construido (2026-09-17)

Crear, corregir y fusionar, desde `/admin/clientes`. Dos capacidades nuevas en la matriz de permisos,
con la asimetría escrita: **`clientes:editar` es de recepción** —es trabajo de mostrador, con la
clienta enfrente— y **`clientes:fusionar` es de la dueña**, porque es la única operación del panel que
*borra* un registro de EA en vez de agregarle uno. La matriz del auditor se actualizó celda por celda.

- **El teléfono se normaliza en el servidor, siempre.** La pantalla puede mandar `300 123 4567`; lo que
  llega a EA es `+573001234567`. Guardar variantes es cómo se fabrican los duplicados que después hay
  que fusionar.
- **Antes de crear se busca por teléfono.** EA no deduplica por número —lo hace por correo— así que sin
  ese chequeo dos altas del mismo número crean dos clientas. Editar tiene el mismo chequeo al cambiar
  el número.
- **Corregir y fusionar son excluyentes en la pantalla.** Con varias fichas, corregir una dejaría a las
  otras con el dato viejo, que es exactamente cómo se pierde una corrección. Primero se unen.
- **El orden de la fusión no es negociable**, y es lo que hace que ninguna secuencia de fallas pierda
  una cita: copiar a la superviviente lo que solo tenían las perdedoras → mover las citas → **verificar
  con una segunda consulta, no confiar en el 200 del PUT** → recién ahí borrar. Si algo falla antes del
  último paso no se borra nada; si falla en el último, queda una ficha sin citas que la fusión al leer
  sigue mostrando como una sola persona. Volver a correrla termina el trabajo.
- Sobrevive **el id más bajo** —el más viejo, el más probable de estar referenciado en un evento de
  Google de hace meses— y se le copia lo que las otras tenían y ella no. Elegir "la más completa"
  sonaría mejor y sería inestable entre corridas.

## X4 — Comisiones: no bloquea el corte, pero tiene fecha de vencimiento

**Con una sola técnica al 40 %, el motor ya está bien.** La regla global de la migración `018` y una
regla amarrada a ella dan exactamente el mismo número, y la dueña no atiende, así que no hay comisión
fantasma sobre su propio trabajo. Los cortes 1–15 / 16–fin ya están implementados. Nada de esto
bloquea cancelar Agenda Pro.

⚠ **Lo que sí importa: la regla es global, y entra una segunda técnica en los próximos meses.** Una
regla con `ea_provider_id = NULL` aplica a *toda* cita, de *cualquier* persona. El día que la segunda
técnica atienda su primera clienta, el motor le calcula 40 % sin que nadie haya decidido que gana
40 %. No hay error, no hay marca: sale liquidado como si fuera correcto. Y si negociaron otra tasa, el
número está mal y se paga mal.

Por eso el paquete existe, y por eso su fecha la pone la contratación y no el corte:

1. **Amarrar la regla actual a la técnica** (`ea_provider_id` con su id de EA) y cerrar la global. Una
   migración de dos sentencias. Hacerlo **antes** de que exista la segunda persona, no después: una
   regla con vigencia mal puesta se descubre con la quincena ya corrida.
2. **El editor y el simulador** — el paquete D1 que nunca se construyó: validación de solapes al
   guardar, y el botón *"¿cuánto habría pagado la quincena pasada con estas reglas?"*. Sin él, darle
   de alta a la segunda técnica con otra tasa es un commit y un despliegue. Con él, es una pantalla y
   una comprobación contra datos reales antes de que la tasa entre en vigor.
3. **El comprobante de liquidación por técnica** — lo que se le entrega o se le manda: renglón por
   renglón, total, periodo. Hoy la liquidación solo existe en pantalla, y con dos personas cobrando
   eso deja de alcanzar.

## X5 — Lo que hay que hacer en EA antes de la primera cita real

Casi sin código, y con una ventana que se cierra:

1. **Fijar la lista de estados** en los settings de EA: `Reservada`, `Confirmada`, `Reprogramada`,
   `Completada`, `No asistió`, `Cancelada`. EA trae cinco en inglés y **ninguno de los dos que el
   motor de comisiones necesita**. Es texto plano guardado por fila: renombrarlos después **no** migra
   las citas viejas. Se hace antes, o se hace mal para siempre.
2. **Crear los cinco combos como servicios de EA.** Cada combo es *un* servicio con su precio y su
   duración fijados a mano (más corto y más barato que la suma de sus partes).
3. **Pinear la imagen de EA a 1.6.0.** Hoy el stack corre `:latest`, y el panel lee su esquema directo
   y depende de los nombres de columna de sus webhooks. Un `pull` una noche cualquiera puede romper
   reportes sin que nadie toque código.

### Estado: ✅ 1 y 2 construidos (2026-09-17) · 3 es operación pura

**1 — la lista de estados** es un job con guarda (`src/jobs/status-options.ts` + su CLI), empaquetado
en la imagen como `scripts/estados.js`. **No escribe por defecto**: muestra el plan, y hay que volver
a correrlo con `--aplicar`. Y antes de escribir mira qué estados están **en uso** en las citas que ya
existen: si alguno desaparecería de la lista, no escribe y los lista. Es lo que separa correrlo en una
agenda vacía —donde es gratis— de correrlo con seis meses de historia, donde deja citas con una cadena
que el desplegable ya no ofrece. Un test fija el contrato con `status-map.ts`: el panel tiene que saber
traducir los seis, o la agenda quedaría punteada entera y el daño se vería recién al abrir la pantalla.

**2 — los combos** quedaron como una acción en `/admin/servicios`, no como un script: la pantalla ya
tiene el diff y el estado *sin vincular*, así que agregar "Crear" sirve para cualquier servicio futuro
y no solo para estos cinco. El precio y la duración se releen de la vitrina en el servidor —nunca
viajan desde el navegador, igual que al publicar— y **el nombre lo escribe una persona**: `pricing.ts`
no guarda nombres, viven en los diccionarios de la landing, y derivarlo del id sería inventar el texto
que la clienta lee en su confirmación. Crear y vincular son dos sistemas y no es atómico: si lo segundo
falla, el servicio queda *solo en la agenda* y se vincula desde la misma pantalla — el mensaje lo dice,
para que nadie salga a borrarlo en EA.

**3 — el pin de EA** no se puede hacer desde este repo: el stack `golden-agenda` está en modo web
editor y no está versionado acá. El runbook exacto ya está en `docs/DEPLOY.md` § Paso 1.

Los dos procedimientos quedaron escritos en `docs/DEPLOY.md`, con los tres desenlaces posibles del
script y qué hacer con cada uno.

## X6 — Reserva pública

D2 está **escrito pero sin versionar**: `src/app/[lang]/reservar/`, `src/app/api/reservas/` y
`admin/src/app/api/public/booking/` están sin commitear, y la landing sigue mandando a Agenda Pro por
`NEXT_PUBLIC_BOOKING_URL`. Falta: commitear y desplegar, verificar Turnstile, apagar el booking propio
de EA y jubilar la variable.

### Estado: ⚠️ el flujo estaba escrito; el cambio de destino ya no es código

Lo que había compila, pasa los 96 tests de la landing y trae sus guardas (Turnstile opcional, límite
por IP, tiempo mínimo de llenado). Lo que faltaba para que el corte no fuera un cambio de código en el
peor momento era **el destino de los CTA**, y ahí apareció un hueco que nadie había mirado: la landing
es bilingüe y `NEXT_PUBLIC_BOOKING_URL` es un solo valor. Mientras apunte a Agenda Pro da igual —esa
URL es la misma para todos— pero un `/reservar` pelado mandaría a una visitante en inglés al flujo en
español, y un `/es/reservar` fijo lo haría a propósito.

Se resolvió con `bookingHref(lang)` en `src/config/site.ts`: una URL absoluta pasa intacta, una ruta
relativa recibe el prefijo del idioma. Los tres lugares con CTA —nav, servicios y `/bio`— lo usan.

**Así que jubilar Agenda Pro del sitio público es cambiar una variable a `/reservar`**, y los dos
idiomas siguen. No hay commit de por medio el día del corte.

## X7 — Recordatorios por WhatsApp

**El trámite arranca ya, antes que el código.** Coexistence sobre el número actual exige verificación
de negocio en Meta y plantillas `utility` aprobadas; los tiempos los pone Meta, no nosotros, y el
código sin plantilla aprobada no sirve de nada.

Después: `lib/whatsapp/`, `jobs/reminders.ts`, tabla `wa_message` con UNIQUE `(cita, tipo)` para no
mandar dos veces, webhook de estado y opt-out por clienta.

### Estado: ⚠️ la mitad que no depende de Meta, construida

Hecho: la migración `020` (`wa_message` con `UNIQUE (ea_appointment_id, kind)` y `wa_optout`) y
**`jobs/reminders.ts`, que es donde viven las decisiones que se pagan caro** — 18 tests.

- **La ventana es un rango, no un instante.** "Mandar 24 horas antes" suena a instante y no lo es: el
  job corre cada N minutos y una cita cuyo momento exacto cayó entre dos corridas **no se mandaría
  nunca, sin error, sin que nadie se entere**. Hay una función que comprueba que la tolerancia le gana
  al intervalo del cron, y un test que la ejerce: es una propiedad de la configuración, y bajarle la
  frecuencia al cron sin subir la tolerancia es un cambio que se ve inocente.
- **Nunca se manda un recordatorio de una cita que ya empezó**, aunque la ventana lo permita. Llegar
  tarde sirve; llegar después de la cita es ruido, y para la clienta una molestia.
- **"No se mandó" es un dato con motivo, no un hueco.** Se registra `sin-telefono`, `opt-out`,
  `estado-no-aplica` y `ya-existe`; lo único que no se registra es `fuera-de-ventana`, que son casi
  todas las citas en casi toda corrida. Sin esto, una clienta sin número y una que se dio de baja se
  ven exactamente igual: sin fila.
- **La fila se inserta antes de llamar a Meta**, no después: un timeout en el que el mensaje sí salió
  dejaría la fila sin escribir y el siguiente barrido lo mandaría de nuevo.
- **El texto del mensaje no se guarda**, solo qué plantilla y para qué cita. Es el mismo principio que
  `webhook_event`: el texto lleva el nombre de la clienta y la hora de su cita, y una tabla de log sin
  retención no es lugar para eso.
- La baja es del **número**, no de la ficha: sobrevive a que alguien borre y recree la clienta.

Falta —y depende de Meta, no de nosotros— el alta de Coexistence, **las plantillas `utility`
aprobadas**, el cliente de `lib/whatsapp/` contra la Cloud API, el webhook de estado y el cron. El
trámite es lo que hay que empezar ya: el código sin plantilla aprobada no manda nada.

**Es la regresión más visible del corte.** Agenda Pro manda recordatorios hoy; el día que se cancele,
si esto no está, la clienta simplemente deja de recibirlos y la inasistencia sube. Si el trámite se
alarga, el paliativo es un botón que abre `wa.me` con el texto listo: trabajo humano diario, pero
nadie se queda sin aviso.

## X8 — El corte

1. **Ensayo de restauración del respaldo.** El servicio `db-backup` ya existe en el stack: `mysqldump`
   de los dos esquemas cada madrugada, comprimido, 30 días de retención, y Diagnóstico vigila la
   antigüedad en rojo a las 48 horas. Lo que falta es **agarrar uno de esos archivos y meterlo en una
   base vacía para comprobar que sirve.** Se hace porque `mysqldump` falla en silencio —permisos a
   medias, archivo cortado, gzip corrupto— y el resultado se ve idéntico a uno bueno hasta el día que
   se necesita. `gbs_admin` es el único dato del sistema que no se puede reconstruir desde ninguna
   otra fuente.

   Y lo otro: **confirmar que `BACKUP_OFFSITE_URI` está seteado.** Vacío, el respaldo queda solo en la
   VM — o sea que no cubre el único modo de falla que de verdad importa, que es que la VM se muera. El
   propio servicio lo avisa por log al arrancar, y nadie lee los logs de arranque.
2. **Un ciclo de facturación completo en paralelo**: agendar en EA, y conciliar línea por línea las
   filas `Payment` y las cifras de Actual Budget contra el reporte de Agenda Pro. Un número de ingreso
   o de comisión que no se concilió contra una fuente confiable no está verificado.
3. Recién entonces: jubilar `agendapro-pull.yml`, revocar las credenciales, cancelar la suscripción.

---

## Orden

```text
LO QUE FALTA PARA CANCELAR AGENDA PRO

  ✅ X1 pago dividido        construido, sin desplegar
  ✅ X2 importador           construido · falta correrlo con el archivo real
  ✅ X3 clientas RW          construido, sin desplegar
  ✅ X5 estados y combos     construidos · el pin de EA es operación en Portainer
  ⚙️  X6 reserva pública      commitear + una variable de entorno
  ⏳ X7 WhatsApp             lógica lista · falta Meta (trámite + plantillas)
  ⬜ X8 corte                operación: respaldo, ensayo, ciclo en paralelo

FUERA DEL CAMINO DEL CORTE

  ⬜ X4 comisiones           su fecha la pone la segunda técnica, no Agenda Pro
```

**Lo que queda no es, casi nada de ello, escribir código.** Es correr tres scripts mirando la salida,
cambiar una variable, esperar a Meta y conciliar un ciclo de facturación. El orden que queda:

1. **Desplegar lo construido** y fijar los estados de EA (X5) — su ventana se cierra con la primera
   cita real.
2. **Correr el importador** con el archivo de verdad (X2), primero `--solo-clientas`, revisar en
   `/admin/clientes`, después la historia.
3. **Empezar el trámite de Meta** (X7). No depende de nosotros y es lo que más tarda.
4. **Cambiar `NEXT_PUBLIC_BOOKING_URL` a `/reservar`** (X6) cuando el flujo esté verificado.
5. **X8**: ensayo de restauración, ciclo en paralelo, y recién ahí cancelar.

---

## Preguntas abiertas

Lo que todavía falta para escribir código, no para discutir el plan:

> **El export real ya se vio** (2026-09-14, 173 citas) y el importador está ajustado a su forma.
> Lo que ese archivo contestó, y lo que abrió, está en la sección de abajo.

| Pregunta | Bloquea |
| --- | --- |
| **¿Ya le dieron "cerrar el día" en `/admin/caja` alguna vez?** O sea: ¿ya se está cobrando de verdad por el panel, o todo sigue pasando por Agenda Pro? | X1. Sin días cerrados, el backfill del pago dividido no tiene nada que migrar y el paquete se achica a la mitad |
| ¿Alguien **restauró un respaldo** alguna vez, y está seteado `BACKUP_OFFSITE_URI`? La antigüedad del último se ve en `/admin/diagnostico` | X8, y es el único riesgo del proyecto sin arreglo posterior |
| ¿Las **dos estaciones** son intercambiables o especializadas? | Solo cambia la siembra de `station` |
| ¿Hace falta **exportar reportes** a Excel/PDF? | Agenda Pro lo hace; el panel no exporta nada hoy |
| ¿Hace falta **comprobante para la clienta** (impreso o por WhatsApp)? | No existe hoy |

Cuando se concrete la segunda técnica, tres datos más, y antes de su primer día de trabajo: **su
tasa**, si los **adicionales** pagan igual que el servicio principal, y su **correo personal** para el
enrolamiento TOTP. Si la tasa trae escalonado por volumen de quincena ("10 % hasta X, 12 % por
encima"), eso sí cambia el modelo: la regla actual no expresa tramos.

---

## Lo que enseñó el export real (2026-09-14)

173 citas, del **25/05/2026 al 29/09/2026**. El importador quedó ajustado a esta forma y hay
tests que la fijan columna por columna: el día que Agenda Pro cambie el encabezado, se ve.

| Dato | Valor |
| --- | --- |
| Citas | 173 (171 utilizables; 2 son una cancelada que el export trae **triplicada**) |
| Clientas únicas por teléfono | 100 |
| Teléfonos | 173 de 173, ninguno vacío. 170 colombianos, 3 extranjeros (+52, +1) |
| Correos | 19 de 173 |
| Con pago asociado | 136 |
| Estados | `Asiste` 139 · `Cancelado` 17 · `No Asiste` 10 · `Reservado` 7 |
| Servicios distintos | 37 |
| Origen | `Manual` 162 · `Online` 11 |

**Lo caro:** `Precio lista` y `Precio real` **difieren en 96 de 173 filas**. Importar la de lista
no falla —infla el histórico de ingresos con cifras que se ven razonables— y por eso la detección
de columnas recorre los sinónimos en orden de especificidad en vez de quedarse con la primera
columna que coincida.

**Lo que abrió, y necesita una decisión:**

> ⚠ **Atienden dos personas: Kati (136 citas) y Mariana (35).** La respuesta del 2026-09-17 fue
> "una técnica, y la dueña no atiende", y el archivo dice otra cosa. Importa porque la regla de
> comisión sembrada es **global**: aplica a toda cita de cualquier persona, así que hoy el motor
> liquidaría 40 % también sobre esas 35. Las tres salidas —Mariana es la dueña y no cobra
> comisión; es una segunda técnica con su propia tasa; o el 40 % vale para las dos— son una
> migración de dos sentencias, pero hay que elegir una. Es la fila que X4 estaba esperando.

**Dos cosas menores que el archivo también trae:** 20 de 173 apellidos son un guion bajo (se
limpian; si no, quedan clientas llamadas "Julian \_" y ese nombre va en la confirmación), y 37
citas sin pagar cuyo precio **no** se importa como ingreso: el precio existe, la plata no entró.

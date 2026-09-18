# Ver el panel por primera vez

Guía de una sentada, para quien nunca lo ha abierto. Todo lo de acá está **ejecutado**, no
supuesto: los comandos son los que corrieron y las respuestas son las que dieron.

`docs/DEV-LOCAL.md` es la referencia completa del entorno. Esto es el camino corto.

---

## 0. Qué vas a tener al final

El panel corriendo en tu máquina, con sesión de dueña, contra un Easy!Appointments local. Sin
Google Cloud, sin tocar la VM, sin riesgo para nada de producción.

**Tiempo:** 15 minutos la primera vez, casi todo esperando a Docker.

---

## 1. Levantar la base y la agenda

```bash
cd golden-beauty-studio-landing
docker compose -f deploy/compose/dev-stack.yml up -d
docker compose -f deploy/compose/dev-stack.yml ps      # los tres en running/healthy
```

Esto levanta MySQL (puerto **3307**, para no chocar con ningún MySQL tuyo), Easy!Appointments
(**8080**) y Mailpit (**8025**).

**Los tres puertos son variables.** 8080 es de los más disputados que hay, y si otro proyecto tuyo
ya lo tiene, el despliegue falla entero con `Bind for 0.0.0.0:8080 failed: port is already
allocated`. Se resuelve sin editar el archivo:

```bash
EA_PORT=8081 docker compose -f deploy/compose/dev-stack.yml up -d
```

`BASE_URL` de EA sigue a la variable sola. Las otras dos son `MYSQL_PORT` y `MAILPIT_PORT`.
Para saber quién tiene el puerto ocupado: `docker ps --format "{{.Names}}\t{{.Ports}}" | grep 8080`.

La base `gbs_admin`, el usuario de escritura y el de **solo lectura** sobre `easyappointments`
los crea el propio stack la primera vez. Si levantaste el stack antes de que existiera ese
script, no corrió —los `docker-entrypoint-initdb.d` solo se ejecutan con el volumen vacío— y se
arregla con `down -v` y volver a subir.

## 2. Instalar Easy!Appointments (una vez)

`http://localhost:8080` —o el puerto que hayas puesto en `EA_PORT`— y completa el asistente.
Anota el **token de API** (Ajustes → API).

> **Se puede saltar para una primera mirada.** El panel no se cae si EA no responde: entra en
> **solo lectura con una banda de aviso**, que es su comportamiento diseñado. Lo comprobé sin
> EA instalado — las nueve pantallas responden 200 igual, con los datos de la agenda vacíos.
> Para probar agenda, clientas o servicios sí hace falta.

## 3. `admin/.env.local`

No se commitea. La lista completa y qué hace cada variable está en `docs/DEV-LOCAL.md` § Paso 4.
Lo mínimo para arrancar:

```bash
DATABASE_URL="mysql://gbs_admin:gbs_admin_dev@127.0.0.1:3307/gbs_admin"
DATABASE_URL_EA_RO="mysql://gbs_ea_ro:gbs_ea_ro_dev@127.0.0.1:3307/easyappointments"
EA_API_URL="http://localhost:8080/index.php/api/v1"   # ← el mismo puerto de EA_PORT
EA_API_TOKEN="<el del paso 2>"
EA_WEBHOOK_SECRET_HEADER="X-GBS-Webhook"
EA_WEBHOOK_SECRET_TOKEN="dev-webhook-secret"
BETTER_AUTH_SECRET="<openssl rand -base64 32>"
BETTER_AUTH_URL="http://localhost:3001/admin"
GOOGLE_CLIENT_ID="no-hace-falta-en-local"
GOOGLE_CLIENT_SECRET="no-hace-falta-en-local"
GOOGLE_WORKSPACE_DOMAIN="goldenbeautystudio.com.co"
TOTP_ENC_KEY="<openssl rand -base64 32>"
INGEST_URL=""
TZ="America/Bogota"
TICKET_STAFF_COBRA="true"
```

`GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` tienen que **existir** —la app se niega a arrancar
sin ellas— pero en local no se usan: se entra por TOTP.

## 4. El esquema

```bash
cd admin
npm ci
npm run build:migrator && node .next/standalone/scripts/migrate.js
```

## 5. La cuenta para entrar

Acá está el truco que ahorra la media hora de Google Cloud:

```bash
npm run dev:seed
```

```
dev:seed: ✓ dev@goldenbeautystudio.com.co (owner) lista para entrar.

  Código: 418293   (le quedan 25 s)
  Para el celular:  otpauth://totp/Golden%20(dev):dev%40...

  Entrar en: http://localhost:3001/admin/entrar
```

Escanea el `otpauth://` con Google Authenticator o el gestor que uses y tendrás códigos siempre;
o corre `npm run dev:seed` cada vez que necesites uno nuevo.

- `npm run dev:seed -- --rol=staff` crea una **técnica**, para ver el panel con su alcance
  recortado — es la mitad del diseño de permisos y no se ve de otra forma.
- Se niega a correr con `NODE_ENV=production` o contra una base que no sea localhost.

## 6. Arrancar

```bash
npm run dev            # http://localhost:3001/admin
```

Si el 3001 está ocupado por otro proyecto: `npx next dev --port 3007` y cambia `BETTER_AUTH_URL`
a ese puerto — **las dos cosas**, o el login redirige al puerto equivocado.

Entra en `/admin/entrar`, elige la cara y escribe el código.

---

## Qué mirar, en orden

Esto es lo que respondió 200 con sesión, pantalla por pantalla:

| Pantalla | Qué es | Qué probar |
| --- | --- | --- |
| **Hoy** `/admin/hoy` | El día de la técnica | Es la pantalla del celular. Ábrela angosta (390 px) |
| **Agenda** `/admin/agenda` | La grilla por técnica | Crear, mover y cancelar una cita |
| **Caja** `/admin/caja` | El día y su cierre | La compuerta: no cierra con una cita atendida sin cuenta |
| **Clientas** `/admin/clientes` | Búsqueda y ficha | **Nueva clienta**, corregir, y fusionar duplicadas |
| **Servicios** `/admin/servicios` | Vitrina ↔ agenda | Los combos salen como *sin vincular*, con su botón **Crear** |
| **Comisiones** `/admin/comisiones` | La quincena | 40 %, cortes 1–15 y 16–fin |
| **Reportes** `/admin/reportes` | Los nueve reportes | Necesita cuentas cerradas para decir algo |
| **Equipo** `/admin/equipo` | Técnicas y TOTP | El QR de enrolamiento |
| **Diagnóstico** `/admin/diagnostico` | Estado del sistema | **Míralo primero**: dice qué le falta al entorno |

### Tres pantallas con datos de mentira, para ver el diseño sin cargar nada

Solo existen fuera de producción:

- `/admin/hoy/demo` — la cuenta de servicio completa, con un interruptor de **modo avión** para
  ver que el borrador sobrevive a la caída de red. Es el caso que justifica todo ese módulo.
- `/admin/caja/vista-previa` y `/admin/reportes/vista-previa` — caja y reportes con datos
  sembrados.

---

## Probar el importador con el export real

**Sin escribir nada.** La ejecución en seco es el modo por defecto:

```bash
cd admin
npm run build:importar
node .next/standalone/scripts/importar.js ~/Downloads/reservas_XXXX.xlsx --solo-historia
```

Contra el export del 2026-09-14 (173 citas) responde:

```
importar: 173 fila(s) en "…xlsx" (xlsx).
importar: columnas detectadas —
  phone        → [10] Teléfono
  startedAt    → [0] Fecha de realización
  amount       → [14] Precio real
  …
importar: historia — 171 cita(s) utilizables · 2 saltada(s).
importar: 136 de 171 traen monto.
importar: prestadores — Kati: 136 · Mariana: 35
importar: rango 2026-05-25 → 2026-09-29.
```

**Lo que hay que leer, en este orden:**

1. **`amount → Precio real`**, no «Precio lista». Las dos columnas difieren en 96 de 173 filas.
2. **El rango.** Si empezara en un año en que el estudio no existía, las fechas se estarían
   leyendo al revés (`MM/DD` en vez de `DD/MM`).
3. **Los prestadores.** Ahí se ve quién atendió — y si aparece alguien a quien el motor de
   comisiones le va a liquidar 40 % sin que nadie lo haya decidido.
4. **Las saltadas.** Las 2 de este archivo son una cita cancelada que el export trae
   **triplicada**; el importador la colapsa en una.

Para escribir: `--aplicar`. Correrlo dos veces no duplica —clientas por teléfono normalizado,
historia por `source_id`— así que se puede probar sin miedo.

---

## Los tests

```bash
cd admin && npm test          # 1.866
cd ..     && npm test         # 96, la landing
```

Los de integración contra MySQL **se saltan solos** si Docker no está: no fallan, dicen que se
saltaron. Con el stack arriba corren contra una base efímera de verdad.

---

## Cuando algo no funciona

| Síntoma | Qué pasa |
| --- | --- |
| `/admin/entrar` no muestra a nadie | El correo de la cuenta no pasa la allowlist. Tiene que tener **dominio con punto**: `dev@local` no sirve y falla en silencio |
| "Código inválido" con el código recién sacado | Lo mismo de arriba, o pasaron más de 30 s. `npm run dev:seed` otra vez |
| `EADDRINUSE :::3001` | Otro proyecto tiene el puerto. Cambia el puerto **y** `BETTER_AUTH_URL` |
| Banda de solo lectura en todas las pantallas | EA no responde. Normal si te saltaste el paso 2 |
| `dev:seed` se queda colgado | La base no está arriba. A los 10 s lo dice y sale |
| `/reportes` en blanco | Es correcto sin cuentas cerradas: cierra un día primero, o mira `/admin/reportes/vista-previa` |

---

## Lo que **no** se puede probar en local

Dicho para que no se busque:

- **El login con Google.** Necesita el proyecto de Google Cloud. Por eso está el TOTP.
- **El espejo a Google Calendar.** Necesita las conexiones OAuth de cada técnica.
- **El push a Strapi / Actual Budget.** `INGEST_URL` vacía deja el push apagado; el cierre diario
  registra que no salió y se reintenta con su botón.
- **Los recordatorios de WhatsApp.** Falta el alta en Meta y las plantillas aprobadas.
- **El rewrite `/admin` desde la landing.** Se prueba con un preview de Vercel
  (`docs/DEV-LOCAL.md` § Paso 6).

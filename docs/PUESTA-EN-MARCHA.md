# Puesta en marcha — de Agenda Pro a la reserva propia

Lista de pasos, en orden, para desplegar el PR #6 y empezar a usarlo. Cada paso dice **dónde** se
hace y **cómo se comprueba**. Lo que es opcional o puede esperar está marcado.

> Contexto: el detalle de cada pieza vive en `docs/CORTE-AGENDAPRO.md` (el plan), `docs/DEPLOY.md`
> (la VM), `docs/WHATSAPP.md` (Meta) y `AGENTS.md`.

---

## 0. Antes de mergear

1. **CI en verde** en el PR #6: el check `e2e` y el de Vercel. No se mergea con rojo.
2. **Respaldo de hoy.** En la VM: `docker exec gbs-admin-backup cat /backups/last-status.txt` → `0`.
   Si no hay respaldo de las últimas 24 h, correr uno antes (ver `docs/DEPLOY.md` § respaldo).

## 1. Variables nuevas (antes o justo después de mergear)

### En Portainer → stack del panel → Environment variables

| Variable | Valor | ¿Obligatoria? |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Salen de `npx web-push generate-vapid-keys` (correrlo una vez, en cualquier compu) | Para los avisos de reserva al celular |
| `VAPID_SUBJECT` | `mailto:<correo del estudio>` | Con las dos de arriba |
| `WHATSAPP_*` | Ver paso 7 | **Esperar a Meta.** Sin ellas el panel funciona igual y no manda nada |

Sin las VAPID el panel funciona; solo no aparece el interruptor de avisos en Ajustes.

### En Vercel → proyecto de la landing → Settings → Environment Variables (Production)

| Variable | Valor | Cuándo |
| --- | --- | --- |
| `NEXT_PUBLIC_META_PIXEL_ID` | Id del píxel (Events Manager → Orígenes de datos) | Ya |
| `META_CAPI_ACCESS_TOKEN` | Píxel → Configuración → API de conversiones → Generar token | Ya |
| `META_TEST_EVENT_CODE` | Código de "Probar eventos" | Solo un día, para comprobar; después se borra |
| `NEXT_PUBLIC_BOOKING_URL` | `/reservar` | **Paso 5**, no antes |

`ADMIN_ORIGIN` ya existe y no cambia.

## 2. Mergear el PR #6

Botón **Merge** en GitHub. Lo que pasa solo, sin tocar nada:

1. **Vercel** despliega la landing (2–3 min).
2. **GitHub Actions** construye la imagen del panel y commitea el digest en `deploy/compose/.env`
   con `[skip ci]` (5–8 min). Mirar Actions → `admin-image`.
3. **Portainer** detecta el commit en su próximo sondeo y redespliega el stack. Al arrancar,
   `admin-migrate` aplica las migraciones **019 a 024**; si una falla, el panel no arranca (a
   propósito).
4. Aparece el servicio nuevo **`admin-recordatorios`** (queda quieto hasta configurar WhatsApp).

**Comprobación:**
- `https://www.goldenbeautystudio.com.co/admin/diagnostico` → todo en verde, y la fila de WhatsApp
  dice "sin configurar".
- `docker logs gbs-admin-migrate` termina en "gbs_admin actualizado".
- La landing pública **sigue mandando a Agenda Pro**: el cambio de destino es el paso 5.

> **Orden:** si por algo la landing sale antes que el panel, no pasa nada: la landing solo ofrece
> "manos + pies sin combo" cuando el panel nuevo le dice que sabe agendarlos.

## 3. Ajustes de Easy!Appointments (una vez, en la VM)

1. **Estados de cita.** En seco primero, después de verdad:
   ```bash
   docker exec gbs-admin node scripts/estados.js
   docker exec gbs-admin node scripts/estados.js --aplicar
   ```
2. **El catálogo de servicios en EA.** Una EA recién instalada no tiene ninguno: este comando
   crea los de la lista de precios (combos incluidos) con sus nombres de la landing, los vincula
   y se los asigna a la profesional. En seco primero —muestra, por servicio, "crear", "ya
   vinculado" o "bloqueado" con el motivo—, después de verdad:
   ```bash
   docker exec gbs-admin node scripts/catalogo.js
   docker exec gbs-admin node scripts/catalogo.js --aplicar --asignar=4
   ```
   `4` es el id de Mariana en EA (varias profesionales: `--asignar=4,7`). Es idempotente: una
   segunda corrida no hace nada, y si algo falló a mitad se vuelve a correr. "Diseño / decoración
   por uña" sale **bloqueado** a propósito: no tiene duración propia, se cobra dentro de otra cita.
   Al final, Panel → **Servicios** no debe mostrar nada "sin vincular" fuera de ése.
3. **Plan de trabajo de cada profesional** (días y horas) en EA: es lo que apaga los días cerrados
   en la reserva.
4. **Fijar la versión de EA** (`EA_VERSION=1.6.0` en el stack de la agenda). Ver `docs/DEPLOY.md`
   § Paso 1.
5. **Apagar la página pública de reservas de EA** (Ajustes de EA): la landing es el único
   formulario.

## 4. Traer la historia de Agenda Pro

Con un export **reciente** de reservas de Agenda Pro, el mismo tipo de archivo que los
`reservas_*.xlsx` que ya están en `exports/` (el importador lee el `.xlsx` directo):

```bash
docker cp reservas.xlsx gbs-admin:/tmp/reservas.xlsx
docker exec gbs-admin node scripts/importar.js /tmp/reservas.xlsx --solo-clientas            # en seco
docker exec gbs-admin node scripts/importar.js /tmp/reservas.xlsx --solo-clientas --aplicar
```

Revisar en el panel → **Clientes** que estén bien (y la lista de "sin teléfono" que imprime el
script). Después, la historia:

```bash
docker exec gbs-admin node scripts/importar.js /tmp/reservas.xlsx --solo-historia            # en seco
docker exec gbs-admin node scripts/importar.js /tmp/reservas.xlsx --solo-historia --aplicar
```

Correrlo dos veces no duplica nada. Las citas **futuras** que ya estaban agendadas en Agenda Pro
no se crean solas: pasarlas a mano a la agenda del panel.

### 4.1 Cómo se pagó cada venta (efectivo, transferencia, cortesías)

El export de reservas no dice **cómo** se pagó. Eso sale de los reportes de plata de Agenda Pro
—**Ventas** (`ventas_<inicio>_<fin>.xlsx`) y **Transacciones** (`transacciones_<inicio>_<fin>.xlsx`)—,
que Agenda Pro deja bajar de a ~1 mes: se bajan todos los tramos y se pasan juntos (los que se pisan
no duplican nada). Va **después** de la historia de arriba, porque casa cada pago con su cita.

El archivo de correcciones (`agendapro-correcciones.json`, solo ids, sin datos de clientas) trae lo
que la dueña corrigió a mano en Actual Budget: el medio real donde Agenda Pro dice otro, el pago de
la venta 1119 partido en efectivo + transferencia, y las cortesías (sin cobro a la clienta). Los
archivos tienen nombres de clientas: no se commitean ni se dejan en la VM al terminar.

```bash
# En la VM, con los archivos ya subidos (scp) a `exports/` y `agendapro-correcciones.json`.
docker exec gbs-admin mkdir -p /tmp/finanzas
docker cp exports/agendapro-finanzas/. gbs-admin:/tmp/finanzas/
docker cp agendapro-correcciones.json gbs-admin:/tmp/finanzas/correcciones.json
# `docker cp` deja los archivos de root; el panel corre como `node`.
docker exec -u root gbs-admin chown -R node:node /tmp/finanzas

# En seco: imprime bruto, cortesías, neto y neto por medio, por mes, y cuántos pagos casaron.
docker exec gbs-admin node scripts/historial-pagos.js /tmp/finanzas --correcciones=/tmp/finanzas/correcciones.json
```

Cotejar con Actual Budget antes de aplicar. Con los tramos del 2026-03-21 al 2026-10-16 tiene que
decir **182 transacciones**, bruto **$14.789.600**, cortesías **9 · $630.000**, neto
**$14.159.600** (efectivo $3.965.000 · transferencia $10.194.600), y casar los 182 con su cita. Si
avisa una corrección "con otra venta que la del archivo", no aplica: hay que revisarla.

```bash
docker exec gbs-admin node scripts/historial-pagos.js /tmp/finanzas --correcciones=/tmp/finanzas/correcciones.json --aplicar
docker exec -u root gbs-admin rm -rf /tmp/finanzas
```

Correrlo dos veces no duplica nada, y correrlo con un archivo de correcciones nuevo deja la tabla
como dice el archivo nuevo. **Nada de esto va a Actual ni a comisiones**: esa plata ya está allá. Se
ve en **Reportes** («Cómo se pagó · historial de Agenda Pro») y en la ficha de cada clienta.

## 5. Prender la reserva propia

1. **Probarla en producción antes de anunciarla:** abrir
   `https://www.goldenbeautystudio.com.co/es/reservar` y hacer una reserva real a nombre propio.
   Comprobar que aparece en la agenda del panel y borrarla.
2. Vercel → `NEXT_PUBLIC_BOOKING_URL` = `/reservar` → **Redeploy** (las variables
   `NEXT_PUBLIC_*` se hornean en el build: sin redeploy no cambia nada).
3. Comprobar que "Agendar" (header, hero, lista de precios, botón flotante, `/bio`) lleva a
   `/es/reservar` y no a Agenda Pro.
4. En Meta → Events Manager → **Probar eventos**: hacer una reserva y ver llegar `ViewContent`,
   `InitiateCheckout` y `Schedule` (navegador **y** servidor, deduplicados). Después borrar
   `META_TEST_EVENT_CODE` de Vercel.

## 6. El celular de la dueña

1. En el celular, abrir `https://www.goldenbeautystudio.com.co/admin` e iniciar sesión.
2. **iPhone:** Safari → Compartir → **Agregar a inicio** (iOS 16.4 o más; sin esto, iOS no permite
   avisos). **Android:** Chrome ofrece "Instalar".
3. Abrir el panel **desde el ícono**, ir a **Ajustes** → "Avisarme cuando alguien reserve en la
   página" → permitir → **Probar aviso**.
4. Repetir en el celular de recepción si aplica.

## 7. WhatsApp automático (cuando Meta lo apruebe)

Todo el trámite paso a paso está en **`docs/WHATSAPP.md`**: verificación del negocio, número en
coexistencia, token permanente, las dos plantillas (`confirmacion_cita`, `recordatorio_cita`),
webhook (`https://www.goldenbeautystudio.com.co/admin/api/public/whatsapp/webhook`, campo
`messages`) y método de pago. Al terminar, cargar en Portainer `WHATSAPP_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` y redesplegar.

**Mientras tanto** los recordatorios se mandan a mano desde **Recordatorios** en el panel (un
toque por cita, abre WhatsApp con el texto listo). Es lo que evita que alguien se quede sin aviso
el día que se cancela Agenda Pro.

## 8. Cancelar Agenda Pro

Solo cuando:

- [ ] Un ciclo de cobro completo (una quincena) pasó por el panel y cuadra contra Agenda Pro
      (Caja, cierre diario, comisiones).
- [ ] Se probó **restaurar** un respaldo (`docs/DEPLOY.md` § ensayo) y `BACKUP_OFFSITE_URI` está
      configurado.
- [ ] Los recordatorios salen, automáticos o a mano.
- [ ] La landing lleva una semana mandando a `/reservar` sin problemas.

Entonces: desactivar el workflow `agendapro-pull` del CRM, revocar sus credenciales y cancelar la
suscripción.

## Si algo sale mal

- **El panel nuevo falla:** revertir en GitHub el commit `deploy: admin <sha>` que escribió CI.
  Portainer vuelve a la imagen anterior en el próximo sondeo. Las migraciones son compatibles
  hacia atrás (no borran columnas), así que la imagen vieja arranca sobre la base nueva.
- **La reserva propia falla:** en Vercel, devolver `NEXT_PUBLIC_BOOKING_URL` a la URL de Agenda
  Pro y redesplegar. Todos los botones vuelven a Agenda Pro.
- **Llegan avisos raros o de más:** quitar las variables `VAPID_*` o `WHATSAPP_*` y redesplegar:
  cada función se apaga sola sin ellas.

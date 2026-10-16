# WhatsApp automático: confirmaciones y recordatorios

Agenda Pro le mandaba a cada clienta la confirmación de su cita y los recordatorios. El panel ya
tiene todo el código para hacerlo solo, por la **API oficial de WhatsApp (Cloud API de Meta)**, desde
el **mismo número que el estudio usa hoy** (modo *Coexistence*). Mientras no termines los pasos de
abajo, el código está apagado y los recordatorios se mandan a mano desde
`/admin/recordatorios`, igual que ahora. Nada se rompe.

Esta guía es para la dueña. Los pasos 1 a 6 se hacen en Meta y tardan días por las revisiones de
Meta, no por nosotros: **conviene empezar ya**.

---

## Qué hace el panel cuando esté prendido

| Mensaje | Cuándo sale | Plantilla |
| --- | --- | --- |
| Confirmación | Apenas la clienta reserva en la página. También al crear una cita en la agenda del panel, si la casilla **"Enviar confirmación por WhatsApp"** está marcada (viene marcada) | `confirmacion_cita` |
| Recordatorio de 24 h | Un día antes de la cita | `recordatorio_cita` |
| Recordatorio de 2 h | Dos horas antes de la cita | `recordatorio_cita` |

- Ningún mensaje lleva **precio**.
- A una misma cita nunca le llega dos veces el mismo aviso: si recepción ya lo mandó a mano desde
  `/admin/recordatorios`, el automático no lo repite, y al revés.
- Si una clienta responde **BAJA** (o STOP, o NO como mensaje solo), deja de recibir
  recordatorios. Queda registrado y se ve en `/admin/recordatorios`.
- Si Meta no deja salir un mensaje (número sin WhatsApp, token vencido…), la cita aparece en
  `/admin/recordatorios` con el motivo y el botón para mandarlo a mano.
- `/admin/diagnostico` tiene un renglón "Los recordatorios por WhatsApp salen solos" que dice si
  está prendido, cuándo corrió por última vez y cuántos mensajes fallaron en 24 h.

---

## Paso 1 — Verificar el negocio en Meta

1. Entra a **business.facebook.com** con la cuenta que administra la página del estudio.
   Si no hay un *portafolio comercial* (antes "Business Manager"), créalo a nombre de
   Golden Beauty Studio.
2. **Configuración del negocio → Centro de seguridad → Verificación del negocio → Iniciar.**
   Te va a pedir razón social, NIT o RUT, dirección, teléfono y un sitio web
   (`goldenbeautystudio.com.co`) donde se vea el mismo nombre y datos. Lo más rápido suele ser
   verificar por correo de dominio o por teléfono.
3. Meta tarda entre unos días y un par de semanas. Sin verificación se puede probar, pero con
   límites muy bajos de envío.

## Paso 2 — Crear la app de Meta

1. Entra a **developers.facebook.com → Mis apps → Crear app**. Tipo: **Empresa / Business**.
   Asóciala al portafolio del paso 1.
2. En la app, **Agregar producto → WhatsApp → Configurar**. Meta crea una *cuenta de WhatsApp
   Business* (WABA) y te da un **número de prueba**. Sirve para el paso 7.
3. Anota el **secreto de la app**: *Configuración de la app → Básica → Clave secreta de la app*.
   Es `WHATSAPP_APP_SECRET`.

## Paso 3 — Conectar el número actual con Coexistence

*Coexistence* conecta el número que hoy usa la app **WhatsApp Business** del celular a la Cloud
API **sin sacarlo de la app**. El estudio sigue chateando desde el celular como siempre, y el panel
manda las plantillas por la API desde ese mismo número. Lo que se sabe de cómo funciona (revísalo en
la pantalla de Meta al momento de hacerlo, porque Meta cambia estas condiciones):

- **La app del celular sigue funcionando.** Los mensajes que manda el panel aparecen en el chat de
  la clienta en el celular, y lo que la clienta responde llega al celular como siempre. Recepción
  sigue atendiendo por ahí.
- Durante el alta, Meta ofrece **sincronizar contactos y el historial de chats** (hasta unos meses
  atrás) con la cuenta de la API. Es opcional.
- Requiere la **app WhatsApp Business actualizada** y un número que ya esté en uso activo en esa
  app. Meta ha pedido además que la app se abra con regularidad (del orden de cada dos semanas)
  para que la conexión no se caiga. *Verificar el plazo exacto en el alta.*
- Algunas funciones de la app quedan limitadas mientras el número está conectado (por ejemplo,
  mensajes temporales o de "ver una vez", y ciertos dispositivos vinculados). *La lista exacta la
  muestra Meta en el alta; léela antes de aceptar.*
- El número conectado tiene un **límite de envío por segundo más bajo** que un número solo de API.
  Para el volumen del estudio (decenas de mensajes al día) no importa.
- Los mensajes que se mandan **desde la app del celular siguen siendo gratis**; los que manda el
  panel por la API se cobran según la tarifa de Meta (ver "Costos").

**Cómo se hace.** El alta de Coexistence se hace con el flujo *Embedded Signup* de Meta, eligiendo
la opción de **conectar un número existente de la app WhatsApp Business**, y escaneando un código QR
desde la app del celular (*Configuración → Cuenta → Plataforma de negocios* o similar). ⚠️ **Punto a
confirmar:** Meta ha ofrecido este flujo principalmente a través de *proveedores de soluciones /
Tech Providers*. Si en tu app no aparece la opción de conectar un número existente de la app,
hay dos caminos: (a) usar un proveedor de soluciones de Meta solo para el alta (el panel sigue
usando la API directa con el token del paso 4), o (b) registrar la app como *Tech Provider* en
developers.facebook.com. No elimines ni migres el número de la app por tu cuenta: perderías el
historial del celular.

Al terminar, en **WhatsApp → Configuración de la API** vas a ver el número del estudio con su
**Identificador del número de teléfono** (*Phone number ID*, un número largo, **no** el teléfono).
Ese es `WHATSAPP_PHONE_NUMBER_ID`.

## Paso 4 — Token permanente (usuario del sistema)

El token temporal que muestra la pantalla de la API vence en 24 horas. El panel necesita uno
permanente:

1. **business.facebook.com → Configuración del negocio → Usuarios → Usuarios del sistema →
   Agregar.** Nombre: `panel-gbs`. Rol: **Administrador**.
2. **Asignar activos**: la **app** del paso 2 (control total) y la **cuenta de WhatsApp** (control
   total).
3. **Generar token**: elige la app, vencimiento **Nunca**, y marca los permisos
   **`whatsapp_business_messaging`** y **`whatsapp_business_management`**.
4. Copia el token **una sola vez** y guárdalo con los demás secretos. Es `WHATSAPP_TOKEN`. No lo
   pegues en chats ni correos.

## Paso 5 — Crear las dos plantillas

**WhatsApp Manager → Plantillas de mensajes → Crear plantilla.** Para cada una:

- **Categoría: Utilidad** (*Utility*). No marketing: estas son avisos de una cita que la clienta
  pidió. Meta rechaza o recategoriza una plantilla de utilidad que tenga contenido promocional
  (descuentos, "aprovecha", emojis de oferta), así que el texto es sobrio a propósito.
- **Idioma: Español** (código `es`). Si eliges otra variante de español, el código tiene que ir en
  `WHATSAPP_TEMPLATE_LANG` exactamente igual.
- **Tipo de variable: Número** (`{{1}}`, `{{2}}`…).
- **Sin encabezado, sin pie, sin botones.**
- Pega el cuerpo **exacto** de abajo, con los saltos de línea. Meta pide un ejemplo por variable:
  usa los de la tabla.

### `confirmacion_cita`

```text
Hola {{1}}, tu cita de {{2}} en Golden Beauty Studio quedó confirmada para {{3}}, con {{4}}.

Te esperamos en Calle 69 Sur #43a - 41, primer piso, Sabaneta.

Si necesitas cambiarla, responde a este mensaje.
```

### `recordatorio_cita`

```text
Hola {{1}}, te recordamos tu cita de {{2}} en Golden Beauty Studio {{3}}, con {{4}}.

Te esperamos en Calle 69 Sur #43a - 41, primer piso, Sabaneta.

Si necesitas cambiarla, responde a este mensaje. Si prefieres no recibir más recordatorios, responde BAJA.
```

### Ejemplos para la revisión de Meta

| Variable | Qué lleva | Ejemplo para `confirmacion_cita` | Ejemplo para `recordatorio_cita` |
| --- | --- | --- | --- |
| `{{1}}` | Primer nombre de la clienta | `Laura` | `Laura` |
| `{{2}}` | Servicio | `Semipermanente manos` | `Semipermanente manos` |
| `{{3}}` | Día y hora, ya escritos | `el viernes 16 de octubre a las 10:00 a. m.` | `mañana viernes 16 de octubre a las 10:00 a. m.` |
| `{{4}}` | Primer nombre de la profesional | `Lina` | `Lina` |

Por qué el día y la hora van juntos en `{{3}}`: Meta no acepta dos variables pegadas, y con la hora
aparte ("a las {{4}}") la una de la tarde saldría "a las 1:00 p. m.". El panel ya la escribe bien
("a la 1:00 p. m."). En el recordatorio, `{{3}}` dice "hoy a las…", "mañana viernes 16 de octubre a
las…" o la fecha, según el día. Sin nombre de clienta, `{{1}}` es "qué tal"; sin profesional,
`{{4}}` es "nuestro equipo".

Si cambias un texto **después** de aprobado, Meta lo vuelve a revisar. Si cambias la cantidad de
variables, hay que cambiar también el código (`admin/src/lib/whatsapp/template-params.ts`): Meta
rechaza el envío si no coinciden. Los nombres pueden ser otros; en ese caso van en
`WHATSAPP_TPL_CONFIRMACION` y `WHATSAPP_TPL_RECORDATORIO`.

## Paso 6 — El webhook (estados de entrega y bajas)

Sirve para que el panel sepa si el mensaje **llegó** y si alguien respondió **BAJA**. Sin webhook
los mensajes salen igual, pero `/admin/recordatorios` solo puede decir "enviado".

1. Inventa una frase larga y aleatoria. Es `WHATSAPP_VERIFY_TOKEN` (no es un secreto de Meta: es
   una contraseña que tú eliges y pones en los dos lados).
2. Primero pon las variables en Portainer (paso 8), para que el panel sepa responder.
3. **developers.facebook.com → tu app → WhatsApp → Configuración → Webhook → Editar**:
   - URL de devolución de llamada:
     **`https://www.goldenbeautystudio.com.co/admin/api/public/whatsapp/webhook`**
   - Token de verificación: el mismo `WHATSAPP_VERIFY_TOKEN`.
   - **Verificar y guardar.** Si falla, el panel no tiene las variables o la URL está mal.
4. En **Campos del webhook**, suscribe **`messages`** (solo ese).
5. Comprueba que la app quedó suscrita a la cuenta de WhatsApp. Normalmente lo hace el alta; si los
   eventos no llegan, en el Explorador de la API Graph: `POST /{WABA-ID}/subscribed_apps` con el
   token del paso 4.

La URL pasa por la página (Vercel) hasta el panel. A diferencia del webhook de la agenda, este sí
tiene que ser público: Meta lo llama desde internet, y cada aviso viene **firmado** con el secreto
de la app (`X-Hub-Signature-256`), que el panel verifica antes de leer nada.

## Paso 7 — Probar con el número de prueba primero

Antes de tocar el número real:

1. En **WhatsApp → Configuración de la API**, con el número de prueba, agrega tu propio celular
   como destinatario permitido (hasta 5).
2. Crea las dos plantillas también en la cuenta de prueba, o prueba primero con la plantilla
   `hello_world` desde esa misma pantalla.
3. Pon en Portainer el token y el *Phone number ID* **del número de prueba**, haz una reserva en
   la página con tu celular, y revisa que llegue la confirmación.
4. Un número que no esté en la lista de prueba da el error `131030`, que se ve en
   `/admin/recordatorios`. Es lo esperado.
5. Cuando funcione, cambia `WHATSAPP_PHONE_NUMBER_ID` al del número real.

## Paso 8 — Variables en Portainer

**Stacks → gbs-admin → Environment variables**, y **Update the stack**:

| Variable | Valor | Obligatoria |
| --- | --- | --- |
| `WHATSAPP_TOKEN` | El token permanente del paso 4 | Sí, para mandar |
| `WHATSAPP_PHONE_NUMBER_ID` | El *Phone number ID* del paso 3 (solo dígitos) | Sí, para mandar |
| `WHATSAPP_APP_SECRET` | Clave secreta de la app (paso 2) | Sí, para el webhook |
| `WHATSAPP_VERIFY_TOKEN` | La frase que elegiste en el paso 6 | Sí, para el webhook |
| `WHATSAPP_TEMPLATE_LANG` | `es` por defecto | No |
| `WHATSAPP_TPL_CONFIRMACION` | `confirmacion_cita` por defecto | No |
| `WHATSAPP_TPL_RECORDATORIO` | `recordatorio_cita` por defecto | No |
| `WHATSAPP_GRAPH_VERSION` | `v23.0` por defecto | No |

Con `WHATSAPP_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID` puestos:

- la reserva de la página manda la confirmación (y la pantalla de éxito de la página dice "Te
  enviamos la confirmación por WhatsApp");
- la agenda del panel muestra la casilla de confirmación al crear una cita;
- el servicio `admin-recordatorios` empieza a correr cada 30 minutos;
- `/admin/diagnostico` pasa el renglón de WhatsApp de amarillo a verde (después de la primera
  corrida).

## Costos

Meta cobra **por mensaje de plantilla entregado**, con una tarifa por país y por categoría
(utilidad es más barata que marketing). Los mensajes de utilidad que se mandan mientras la clienta
tiene una conversación abierta con el estudio (respondió en las últimas 24 h) han sido gratuitos.
Los precios cambian: **revisa la tarifa vigente para Colombia** en la página de precios de WhatsApp
Business Platform de Meta antes de prender, y agrega un método de pago en *WhatsApp Manager →
Configuración de pagos*. Sin método de pago, los envíos fallan con el error `131042`.

Para estimar: el estudio manda como máximo tres mensajes por cita (confirmación + dos
recordatorios).

## Apagarlo (rollback)

Borra `WHATSAPP_TOKEN` (o `WHATSAPP_PHONE_NUMBER_ID`) en Portainer y actualiza el stack. Al instante:

- ninguna reserva intenta mandar confirmación, y la página deja de prometerla;
- el servicio de recordatorios se queda quieto;
- `/admin/recordatorios` vuelve a ser el canal manual de siempre, con los mismos registros: lo que
  ya salió automático se sigue viendo como "Recordada automáticamente".

El número sigue conectado a la API en Meta y la app del celular sigue funcionando. Para
desconectarlo del todo, hazlo desde WhatsApp Manager.

## Si algo falla

| Síntoma | Causa probable |
| --- | --- |
| Diagnóstico: "nunca corrió" | El servicio `admin-recordatorios` no está corriendo. Revisarlo en Portainer |
| Todos fallan con "token" | El token venció o se regeneró. Paso 4 de nuevo |
| Fallan con "La plantilla no existe" | Nombre o idioma distinto al aprobado, o todavía en revisión |
| Fallan con "cantidad de parámetros" | La plantilla en Meta tiene otra cantidad de variables que el código |
| Fallan con "método de pago" | Falta tarjeta en WhatsApp Manager |
| Solo "Enviado", nunca "Entregado" | El webhook no está configurado o no está suscrito a `messages` |
| Una clienta "pidió no recibir" sin querer | Respondió "NO" a secas. Hablar con ella; la baja se quita en la tabla `wa_optout` |

Detalle técnico (para quien mantenga el código): `admin/src/lib/whatsapp/` (cliente, parámetros,
webhook), `admin/src/jobs/reminders.ts` (las ventanas) y `reminders-run.ts` (el job),
`admin/src/app/api/public/whatsapp/webhook/route.ts`.

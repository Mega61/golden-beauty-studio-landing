# Meta Ads — slate creativa (Golden Beauty Studio)

Cuenta `4898081566944349` · COP · America/Bogota · datos leídos 2026-09-04 vía
NotFair MCP (`meta_ads_runScript`). Ventana: `date_preset: maximum` (primera
entrega 2026-05-16, última 2026-09-03).

> **Estado de la base de evidencia.** `~/.notfair/meta/business-context.json` y
> `~/.notfair/meta/personas/` están vacíos — nunca se corrió `/meta-ads-audit`.
> Por eso las audiencias de abajo se definen por **comportamiento observado en la
> cuenta** (quién escribió por WhatsApp, quién llegó a la landing), no por
> demografía inventada. Correr el audit antes de escalar presupuesto.

## Unidad monetaria

El offset de COP en esta cuenta es **1** (pesos enteros, sin decimales).
Verificado por aritmética, no por supuesto: `Campaña Promo dias` tiene
`daily_budget: 15000` y gastó 56.535 en ~7 días ≈ 8.076/día — consistente con
15.000 COP/día. Con offset 100 el techo habría sido 150 COP/día y el gasto real
lo habría violado 54×. Todas las cifras de este documento son pesos enteros.

---

## 1. Diagnóstico: qué dicen los números

### La cuenta está apagada

Agosto gastó 163.639, y ese total se explica **exactamente** por dos campañas:
`Busqueda de trabajo` (107.104) + `Campaña Promo dias` (56.535) = 163.639. Las
dos están **PAUSED** hoy.

Las 5 campañas marcadas `ACTIVE` — `Campaña Always on`, tres `Agenda abierta!` y
un `Instagram Post` — **entregaron cero en los últimos 30 días**. Tienen
`lifetime_budget` agotado. `ACTIVE` en Ads Manager no significa que estén
corriendo.

**Consecuencia:** ahora mismo no hay pauta viva. Lo único que funcionó en agosto
está pausado.

### Gasto y CTR por mes

| Mes      | Gasto   | CTR        | CPM    | Alcance |
| -------- | ------- | ---------- | ------ | ------- |
| May 2026 | 239.125 | **8,79 %** | 9.834  | 16.158  |
| Jun 2026 | 309.613 | 1,82 %     | 15.826 | 7.384   |
| Jul 2026 | 525.959 | 1,59 %     | 9.110  | 24.507  |
| Ago 2026 | 163.639 | 3,29 %     | 6.873  | 11.926  |

Julio fue el mes de más gasto (43 % del total histórico) y el de peor CTR.

### El objetivo de campaña es la palanca más grande

CTR de enlace = `link_click / impressions`, calculado por campaña:

| Campaña                  | Objetivo             | Gasto   | CTR enlace  |
| ------------------------ | -------------------- | ------- | ----------- |
| Instagram Post           | `LINK_CLICKS`        | 49.631  | **12,63 %** |
| Instagram Post           | `LINK_CLICKS`        | 15.521  | **10,16 %** |
| Instagram post: Visita…  | `LINK_CLICKS`        | 10.923  | **10,01 %** |
| Instagram post: Visita…  | `LINK_CLICKS`        | 87.147  | **9,24 %**  |
| Campaña Promo dias       | `OUTCOME_ENGAGEMENT` | 56.535  | 2,17 %      |
| Busqueda de trabajo      | `OUTCOME_ENGAGEMENT` | 107.104 | 1,40 %      |
| Instagram Post (75.903)  | `OUTCOME_ENGAGEMENT` | 75.903  | 0,96 %      |
| Agenda abierta! (63.039) | `OUTCOME_ENGAGEMENT` | 63.039  | 0,82 %      |
| Campaña Always on        | `OUTCOME_ENGAGEMENT` | 236.338 | 0,79 %      |
| Aprovecha el 10 % …      | `OUTCOME_ENGAGEMENT` | 289.621 | **0,68 %**  |

Las cuatro campañas de tráfico dieron 9–12,6 %. Las de engagement, 0,68–2,17 %.
Diferencia de ~10–18×. Además las de tráfico son las **únicas** con
`landing_page_view`: 470 + 89 + 75 = 634 visitas reales a la landing.

**Salvedad honesta:** son objetivos distintos, así que Meta optimizó la entrega
distinto y el CTR no es comparable 1:1 como señal de reservas. Pero las cuatro
de tráfico están **pausadas**, y son las que llevaban gente al sitio.

### Costo por conversación iniciada (`messaging_conversation_started_7d`)

Solo campañas orientadas a clientas (excluye la de contratación):

| Campaña                    | Gasto   | Conversaciones | COP / conversación |
| -------------------------- | ------- | -------------- | ------------------ |
| **Campaña Promo dias**     | 56.535  | 33             | **1.713**          |
| Agenda abierta! (63.039)   | 63.039  | 14             | 4.503              |
| Instagram Post (75.903)    | 75.903  | 16             | 4.744              |
| Campaña Always on          | 236.338 | 32             | 7.386              |
| Porque creemos en el amor… | 74.763  | 9              | 8.307              |
| **Aprovecha el 10 % …**    | 289.621 | 34             | **8.518**          |
| Agenda abierta! (59.947)   | 59.947  | 7              | 8.564              |
| Agenda abierta! (73.276)   | 73.276  | 6              | 12.213             |
| Agenda abierta! (38.588)   | 38.588  | 1              | 38.588             |

`Campaña Promo dias` es **5,0× más barata** por conversación que
`Aprovecha el 10 %` y **4,3× más barata** que `Always on`.

### El mejor anuncio de la cuenta

Los tres anuncios de `Campaña Promo dias`:

| Anuncio               | Gasto  | CTR        | CPM       | Conv. | COP / conv. |
| --------------------- | ------ | ---------- | --------- | ----- | ----------- |
| **Miercoles de pies** | 27.529 | **5,03 %** | 7.870     | 21    | **1.311**   |
| Us vs Them            | 15.246 | 2,76 %     | **3.754** | 7     | 2.178       |
| Sabado de press       | 13.760 | 2,84 %     | 7.986     | 5     | 2.752       |

`Miercoles de pies` — **día concreto + servicio concreto** — es el mejor peso
gastado en toda la cuenta para conversaciones de clientas. `Us vs Them` compró
el alcance más barato del histórico (CPM 3.754, menos de la mitad del promedio
de 9.873).

Lo que perdió: los cuatro `Agenda abierta!` (oferta genérica, sin servicio ni
día) costaron 4.503–38.588 por conversación. La especificidad ganó 3–29×.

### El descuento del 10 % fue el peor dinero de la cuenta

`Instagram post: Aprovecha el 10% de descuento en…` gastó **289.621** — 23 % de
todo el histórico, la línea más grande — con el **peor CTR de enlace de la
cuenta (0,68 %)** y 8.518 por conversación. Frecuencia 2,49.

Esto importa porque `primera-visita` (10 % en la primera cita) es la promo
evergreen viva en la landing. La evidencia dice que **liderar con el descuento
rindió 5× peor que liderar con un servicio y un día concretos**. El descuento
funciona mejor como cierre que como gancho.

### La pauta de contratación rinde mejor que la de clientas

`Busqueda de trabajo`: 26 leads a 4.119 c/u, 77 conversaciones a 1.391 c/u.

| Anuncio                     | Gasto  | Leads | COP / lead | Conv. | COP / conv. |
| --------------------------- | ------ | ----- | ---------- | ----- | ----------- |
| **Foto de la contratación** | 51.372 | 14    | **3.669**  | 46    | **1.117**   |
| Video de la contratación    | 44.004 | 8     | 5.500      | 18    | 2.445       |
| Carrusel de la contratación | 11.728 | 4     | 2.932      | 13    | 902         |

La **foto estática** superó al video 1,5× en costo por lead. (El carrusel se ve
mejor por conversación, pero con 11.728 de gasto y 4 leads la muestra es
demasiado chica para declararlo ganador — es un retador, no un resultado.)

### 🐛 Bug: la landing anuncia una promo vencida

`NEXT_PUBLIC_ACTIVE_PROMO=apertura,primera-visita`, y `apertura` tiene
`ends_at: "2026-07-15T23:59:59.000Z"` — hace 7 semanas.

`getActiveScenarios()` en `src/data/promos.ts:29` filtra por `active` y por
contenido, pero **no filtra por `starts_at` / `ends_at`**. Ese filtro de fechas
solo existe en el bloque comentado del swap a Strapi, más abajo en el mismo
archivo. Así que hoy la página sigue mostrando *"Las primeras 100 clientas
reciben el kit de bienvenida Golden"*.

**Impacto en la pauta:** cualquier anuncio que apunte a `#promos` aterriza en una
oferta vencida. Arreglar antes de mandar tráfico pago. Dos opciones:
`NEXT_PUBLIC_ACTIVE_PROMO=primera-visita` (inmediato, sin deploy de código), o
portar el filtro de fechas a `getActiveScenarios` (correcto, evita que vuelva a
pasar con `madre` y `navidad`).

---

## 2. Slate de conceptos

Tres hipótesis distintas, no tres versiones de la misma.
Formato: `audiencia × motivación × ángulo × formato × variable a probar`.

### Concepto A — `DIA-PIES` · Escalar el ganador

| Campo                 | Contenido                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Hipótesis**         | Para mujeres en Bogotá que ya escriben por WhatsApp pero postergan la cita, un **día fijo + un servicio concreto + precio a la vista** baja la fricción de decisión más que una invitación abierta. Debería funcionar porque ya funcionó: `Miercoles de pies` dio 1.311 COP/conversación contra 4.503–38.588 de los `Agenda abierta!`.                                                                                                                                               |
| **Variable a probar** | **Solo el objetivo de campaña.** Mismo concepto creativo: `OUTCOME_ENGAGEMENT` (control, replica agosto) vs tráfico a la landing (retador). Nada más cambia.                                                                                                                                                                                                                                                                                                                         |
| **Evidencia**         | Anuncio `Miercoles de pies`, campaña `Campaña Promo dias` (id `120246010877210139`), 2026-08-27→09-03: gasto 27.529, CTR 5,03 %, CPM 7.870, 21 conversaciones, 1.311 COP/conv. Contraste: los 4 `Agenda abierta!`, 234.850 de gasto combinado, 28 conversaciones.                                                                                                                                                                                                                    |
| **Gancho**            | Primer frame: **«Miércoles de pies.»** — tres palabras, tipografía grande sobre el trabajo real. Sin logo en el primer frame.                                                                                                                                                                                                                                                                                                                                                        |
| **Texto principal**   | *«Miércoles de pies en Golden. Semipermanente en pies $55.000 · 75 min. Tradicional $35.000 · 60 min. Escríbenos y te decimos qué horas quedan libres esta semana.»*                                                                                                                                                                                                                                                                                                                 |
| **Brief visual**      | Plano cenital de un pie terminado sobre lino crudo, luz lateral suave, paleta de la marca (dorado/mocha). Prueba en pantalla: **el precio y la duración impresos en el arte**, no solo en el copy — el copy se corta en Reels. Fuente: `public/lookbook/**`. Cortes 1:1 y 9:16 con margen seguro en los 250 px superiores e inferiores para Reels.                                                                                                                                   |
| **CTA y destino**     | Control: `Enviar mensaje` → WhatsApp `3014648943`. Retador: `Reservar` → landing `#servicios` (**no** `#promos` hasta arreglar el bug de `apertura`).                                                                                                                                                                                                                                                                                                                                |
| **Ledger de claims**  | `$55.000 / 75 min` → `pricing.ts` → `semi-permanent-feet` ✅ · `$35.000 / 60 min` → `traditional-feet` ✅ · WhatsApp `3014648943` → `.env` ✅ · **«Miércoles de pies» como descuento recurrente → `needs_substantiation`**: el nombre del anuncio de agosto lo sugiere, pero no hay términos aprobados en el repo ni en la cuenta. El copy de arriba lo trata como **agenda temática, no como descuento** — si existe un descuento real de miércoles, dame los términos y lo reescribo. |
| **Plan de lectura**   | Primario: COP/conversación iniciada. Guardrail: CPM ≤ 12.000. Duración: 14 días o 40 conversaciones por celda, lo que llegue primero. **Falsaría la hipótesis:** el retador de tráfico por encima de 2.500 COP/conversación, o CTR de enlace bajo 4 %.                                                                                                                                                                                                                               |

### Concepto B — `PRECIO-CLARO` · Revivir el objetivo de tráfico

| Campo                 | Contenido                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hipótesis**         | Para quien está comparando estudios y quiere saber cuánto cuesta **antes** de escribir, una campaña de tráfico a la lista de precios convierte mejor que un boost que la obliga a preguntar. Debería funcionar porque las 4 campañas `LINK_CLICKS` dieron 9–12,6 % de CTR de enlace y 634 `landing_page_view` — y las apagaron todas.                                                                                                                                                                                      |
| **Variable a probar** | **La transparencia de precio como gancho** — rango de precios explícito en el arte vs el gancho de invitación que corre hoy. Objetivo fijo en tráfico en las dos celdas.                                                                                                                                                                                                                                                                                                                                                   |
| **Evidencia**         | `Instagram Post` (`LINK_CLICKS`, id `120241230071930139`): 49.631 de gasto, 12,63 % CTR enlace, CPM 8.060. `Instagram post: Visita…` (id `120241155585200139`): 87.147, 9,24 %, **470 landing_page_view** de 867 clics (54 % de continuidad). Ambas PAUSED. En mayo, cuando estas corrían, el CTR de cuenta fue 8,79 %.                                                                                                                                                                                                    |
| **Gancho**            | Primera línea: **«Los precios, sin que tengas que preguntar.»**                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Texto principal**   | *«Uñas en Bogotá con precio publicado. Montaje en acrílico $115.000 · 2 h 30. Polygel $120.000. Semipermanente en manos $50.000. Combo manos + pies $95.000. Toda la lista está en la página — mírala antes de escribir.»*                                                                                                                                                                                                                                                                                                 |
| **Brief visual**      | Carrusel de 3 tarjetas, una por rango: *Sencillos desde $20.000* / *Forrados desde $70.000* / *Montajes desde $100.000*. Cada tarjeta = una foto real del lookbook + el precio en tipografía grande. Última tarjeta: captura de la sección de precios de la landing, para que el anuncio y el destino coincidan visualmente (message match).                                                                                                                                                                               |
| **CTA y destino**     | `Más información` → `https://goldenbeautystudio.com.co/es#servicios`. La sección ya renderiza precios desde `pricing.ts`, así que el destino nunca contradice al anuncio.                                                                                                                                                                                                                                                                                                                                                  |
| **Ledger de claims**  | `$115.000 / 150 min` → `acrylic-sculpted` ✅ · `$120.000` → `polygel-sculpted` ✅ · `$50.000` → `semi-permanent-hands` ✅ · `$95.000` → `semi-permanent-hands-feet` ✅ · `desde $20.000` → `hands-cleanup-only`, = `getStartingPriceCOP()` ✅ · `desde $70.000` → `rubber-base-leveling` ✅ · `desde $100.000` → `press-on` ✅ · **«precio publicado» como diferenciador frente a la competencia → `needs_substantiation`**: no verifiqué qué publican los demás estudios de Bogotá. El copy afirma solo lo propio, sin comparar. |
| **Plan de lectura**   | Primario: COP/`landing_page_view`. Secundario: continuidad clic→LPV (línea base **54 %**, del histórico de `Visita…`). Guardrail: frecuencia ≤ 2,0. Duración: 14 días o 300 LPV por celda. **Falsaría la hipótesis:** continuidad bajo 40 %, o CTR de enlace bajo 5 % (la mitad de la línea base).                                                                                                                                                                                                                         |

### Concepto C — `ALCANCE-BARATO` · Contraste de calidad

| Campo                 | Contenido                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hipótesis**         | Para quien tuvo una mala experiencia en otro lado (uña levantada, esmalte que duró tres días), un contraste **día 1 vs semana 3-4** compra atención más barata que la oferta directa. Debería funcionar porque `Us vs Them` logró CPM 3.754 — menos de la mitad del promedio de 9.873 — con 2.178 COP/conversación.                                                                                                                                                                                                                                                       |
| **Variable a probar** | **El formato del gancho**: contraste en imagen estática vs el mismo contraste en video corto. La evidencia de contratación dice que la foto le gana al video en esta cuenta (3.669 vs 5.500 por lead); vale saber si eso también aplica a clientas.                                                                                                                                                                                                                                                                                                                       |
| **Evidencia**         | Anuncio `Us vs Them`, `Campaña Promo dias`: 15.246 de gasto, **CPM 3.754** (el más bajo del histórico), 4.061 impresiones, 7 conversaciones, 2.178 COP/conv. Foto vs video: `Foto de la contratación` 3.669/lead contra `Video de la contratación` 5.500/lead, misma campaña, mismas fechas.                                                                                                                                                                                                                                                                              |
| **Gancho**            | **«A las tres semanas se nota quién te las hizo.»**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Texto principal**   | *«Preparación de la lámina, producto que no levanta, y un retoque a las 3–4 semanas — no una uña nueva. Retoque en acrílico $80.000 · 2 h. Polygel $90.000. Escríbenos y te contamos cómo trabajamos.»*                                                                                                                                                                                                                                                                                                                                                                   |
| **Brief visual**      | Dos paneles, división vertical con hairline dorada (el mismo lenguaje de `scripts/build-promo-collage.mjs`). **Los dos paneles son trabajo propio de Golden:** día 1 y semana 3–4 de la *misma* clienta. Nota de producción: nunca fotos de trabajo ajeno como el «antes» — sin derechos, y como afirmación es indefendible. Si no existe la foto de semana 3-4, el concepto **no se produce** hasta tenerla.                                                                                                                                                             |
| **CTA y destino**     | `Enviar mensaje` → WhatsApp. Este ángulo abre conversación; no manda a precio.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Ledger de claims**  | `$80.000 / 120 min` → `acrylic-refill` ✅ · `$90.000` → `polygel-refill` ✅ · `retoque a las 3–4 semanas` → **`needs_substantiation`**: es el intervalo estándar del oficio, pero no está escrito en el repo; confirmar con la dueña o quitar el número · **cualquier «dura más que en otro lado» → `needs_substantiation`** y no se usa: no hay dato de retención propio ni de terceros. El copy habla de *método* (preparación, retoque), que es verificable, no de duración comparada. · Foto de una clienta real → requiere **autorización escrita** antes de publicar. |
| **Plan de lectura**   | Primario: COP/conversación iniciada. Secundario: CPM (línea base 3.754 del propio `Us vs Them`). Guardrail: negativos — parar si `post_unlike` y ocultamientos suben notoriamente. Duración: 14 días o 40 conversaciones por celda. **Falsaría la hipótesis:** CPM por encima de 8.000 (perdió su única ventaja) o COP/conversación arriba de 3.000.                                                                                                                                                                                                                      |

---

## 3. Realidad del presupuesto

Esto no es opcional, es la restricción que manda.

Gasto histórico total: **1.238.336 COP en ~4 meses** (~310.000/mes). Los
`daily_budget` de la cuenta son 15.000–20.000/día.

A 15.000/día y con el mejor costo probado (1.311 COP/conversación), el techo son
~11 conversaciones diarias en el mejor escenario, y más realista 4–6. Para leer
una celda con 40 conversaciones hacen falta ~8–10 días **por celda**.

**Por eso: máximo 2 celdas a la vez.** Los tres conceptos simultáneos con este
presupuesto no producen una lectura, producen tres muestras demasiado chicas
para decidir nada. Orden sugerido:

1. **Semanas 1–2** — Concepto A, 2 celdas (engagement vs tráfico). Reactiva lo
   único probado y responde la pregunta más grande de la cuenta: el objetivo.
2. **Semanas 3–4** — Concepto B contra el ganador de A.
3. **Semana 5+** — Concepto C, solo si existe foto propia de semana 3-4 con
   autorización.

## 4. Antes de publicar (revisión humana)

- [ ] Arreglar el bug de `apertura` — o `NEXT_PUBLIC_ACTIVE_PROMO=primera-visita`, o el filtro de fechas en `getActiveScenarios`. **Bloqueante** para cualquier anuncio que apunte a `#promos`.
- [ ] Resolver los `needs_substantiation`: términos del miércoles, intervalo de retoque, y la existencia de la foto de semana 3-4.
- [ ] Autorización escrita de cualquier clienta cuya foto salga en el arte.
- [ ] Decidir si el 10 % de `primera-visita` va como **cierre** (en la respuesta de WhatsApp) y no como gancho. La evidencia de `Aprovecha el 10 %` (0,68 % CTR, 289.621 de gasto) apoya bajarlo del titular.
- [ ] Cortes seguros por ubicación: 1:1 feed, 9:16 Reels/Stories con margen arriba y abajo.
- [ ] Correr `/meta-ads-audit` para llenar `business-context.json` y las personas antes de subir presupuesto.

## 5. Log de iteración

| Concepto | Lanzado | Audiencia | Gasto | Resultado | Decisión | Siguiente retador |
| -------- | ------- | --------- | ----- | --------- | -------- | ----------------- |
|          |         |           |       |           |          |                   |

---

**Límite de ejecución:** el MCP de Meta es de lectura y operación acotada — no
sube creativos ni crea campañas. Este documento es un brief para el flujo de
diseño y Ads Manager de la dueña. Las mutaciones disponibles son
pausar/activar, renombrar y cambiar presupuesto.

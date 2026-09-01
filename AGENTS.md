<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Updating prices

Prices and durations live in **`src/data/pricing.ts`** — one number per service, language-agnostic. The formatter renders `"desde $180.000"` for `/es` and `"from $180,000 COP"` for `/en` from the same `priceCOP` value.

- **Yearly inflation bump:** edit `priceCOP` numbers in `src/data/pricing.ts`, commit, push. Vercel redeploys both languages.
- **New / renamed / removed service:** add or remove the entry in `src/data/pricing.ts`, then add/rename/remove the matching `{ name, desc }` under `servicios.categories.<catId>.items.<itemId>` in **both** `es.json` and `en.json`. The ids must match exactly.
- **Build guard:** `scripts/check-pricing.mjs` runs in `predev` and `prebuild` and fails fast if a pricing id has no translation, or a translation has no pricing entry. Run manually with `npm run check-pricing`.

## Preguntas frecuentes (FAQ)

La sección vive en `src/app/[lang]/_components/Faq.tsx` y su copy en la clave `faq` de `dictionaries/{es,en}.json`. Se renderiza entre Servicios y Diccionario, y se apaga con `NEXT_PUBLIC_SECTION_FAQ=false`.

- **Por qué existe:** es la única sección escrita en lenguaje literal de búsqueda ("¿cuánto cuestan las uñas acrílicas?") en vez de la voz evocativa del resto de la página. Ese es su trabajo — que un motor de respuestas encuentre una pregunta que coincide con la del usuario. No la reescribas en voz de marca.
- **Formato de las respuestas:** autocontenidas, 40–60 palabras, sin "como mencionamos arriba" ni pronombres que apunten a otra sección. Un pasaje extraído solo debe seguir teniendo sentido.
- **Precios en el texto:** nunca escribas un número a mano. Usa el token `{price:<id>}` con un id de `src/data/pricing.ts` (ej. `{price:acrylic-sculpted}`) — `resolvePriceTokens()` en `src/lib/seo.ts` lo reemplaza por el precio formateado según el idioma. Un id inexistente se deja literal en pantalla, para que el error se vea en revisión en vez de publicar un precio falso.
- **JSON-LD:** `lib/schema.ts` emite un nodo `FAQPage` construido desde el mismo diccionario y con los mismos tokens resueltos, así el markup nunca afirma algo que la página visible no diga. Google ya casi no muestra rich results de FAQ; esto es para los motores de respuesta (ChatGPT, Perplexity, AI Overviews).

## Promociones de temporada

Las promos viven en `src/data/promos.{es,en}.ts` (mismas keys de escenario en ambos archivos). El selector `getActiveScenarios(lang)` en `src/data/promos.ts` lee la env var `NEXT_PUBLIC_ACTIVE_PROMO` para decidir qué escenarios están activos. La shape por-escenario (un solo `strip`) ya espeja la del futuro Collection Type `promo-scenario` en Strapi; cuando se conecte el CMS solo se reemplaza el cuerpo de `getActiveScenarios` (hay un bloque comentado con la implementación lista al final del archivo). `getActiveScenario(lang)` sigue existiendo como wrapper que devuelve el primero — lo usa el `/bio`.

- **Cambiar el/los escenario(s) activo(s):** `NEXT_PUBLIC_ACTIVE_PROMO` acepta una **lista separada por comas** (ej. `apertura,primera-visita`). Con 2+ slugs los escenarios corren a la vez como **carrusel rotatorio** — tanto en el strip superior como en la sección Highlights; el orden de la lista es el orden del carrusel y el primer slug es el que muestra el teaser del `/bio`. Un solo slug se renderiza sin carrusel (sin dots ni rotación). Valores `vacio`, `none`, `off` o ausencia de env var = sin promoción (ni strip ni Highlights se renderizan). El carrusel rota automáticamente (strip ~6s, sección ~7s, bio ~6s); los dots permiten saltar manualmente.
- **Promo evergreen `primera-visita`:** descuento 10% en la primera cita; pensada para correr todo el año junto a la promo de temporada (no tiene `starts_at`/`ends_at`).
- **Editar el contenido por-escenario:** modificar `promos.es.ts` y `promos.en.ts`. Manten las mismas `slug` keys en ambos.
- **Chrome estático** (eyebrow de la sección, footer): vive en `promos` dentro de `dictionaries/{es,en}.json`.
- **Imagen del featured:** si `image_url` está vacío, el card cae a un placeholder de mármol — sin romper layout. Reemplazar agregando el archivo a `/public/` y seteando `image_url: "/ruta.jpg"` en el item correspondiente.
## Anuncio "estamos contratando"

Separado de las promos: no rota, no es un escenario, y no depende de `NEXT_PUBLIC_ACTIVE_PROMO`. Aparece en dos lugares — la banda de carbón dentro de `#promos` en la landing (`VacantesBand.tsx`) y una slide en el carrusel del banner de `/bio` (`BioPromoBanner.tsx`).

- **Apagarlo:** `NEXT_PUBLIC_HIRING_BANNER=false`. Desaparece el anuncio en ambas superficies; la página `/trabaja-con-nosotros`, el formulario y la fila "Trabaja con nosotras" del `/bio` siguen arriba, para que quien llegue tarde aterrice en algo real. Para bajar también el formulario: `NEXT_PUBLIC_SECTION_TRABAJA=false` (que además apaga el anuncio — nunca se anuncia un formulario que no existe).
- **Editar el copy:** clave `vacantes` en `dictionaries/{es,en}.json`. Vive fuera de `trabaja` a propósito: ese bloque se entrega entero al componente cliente del formulario, y meter aquí el copy lo enviaría al navegador de cada visitante para no renderizar nada.
- **Los cargos que lista la banda** salen de Strapi (`getJobRoles`), así que abrir o cerrar una vacante no necesita deploy. El cargo `otro` se filtra — es una opción real del formulario, no una vacante que se anuncie.
- **La slide del `/bio` abre el formulario en la misma página**, no navega a `/trabaja-con-nosotros`. Usa hash + evento (ver `src/lib/careers-panel.ts`): `…/bio#trabaja` es un link compartible que abre el panel en frío, y el evento cubre el clic in-page, donde el hash no cambia y `hashchange` nunca dispara.
- **Sin promo activa** la sección `#promos` sigue renderizando, solo con la banda y padding reducido. Sin promo *y* sin anuncio, la sección desaparece entera.

- **Collage de `primera-visita`:** el hero 16:9 de la promo evergreen (`/public/primera-visita.jpg`) se genera con `npm run build-promo-collage` (`scripts/build-promo-collage.mjs`) — compone 5 paneles del lookbook limpio (`public/lookbook/**`) separados por hairlines dorados. Para cambiar los diseños mostrados, editar el array `SOURCES` del script y re-correrlo.

## Tests

`npm test` (Vitest, `vitest.config.mts`). `npm run test:watch` para iterar, `npm run test:coverage` para el reporte.

- **Qué se testea:** la lógica pura de `src/data`, `src/lib` y `src/config` — el formateador de precios, el resolvedor de tokens `{price:<id>}`, el selector de escenarios de promo y el parseo de env de `siteConfig`. Son las partes donde una regresión publica un precio equivocado o esconde una sección en silencio, en vez de reventar de forma visible.
- **Qué NO se testea acá:** componentes y Server Components `async` — Vitest no puede renderizar los `async`, y la guía de Next manda E2E para eso.
- **`server-only` está aliaseado** a `test/stubs/server-only.ts` en la config de Vitest. Nueve módulos de datos lo importan como guarda y el paquete real lanza fuera de un RSC, así que sin el alias su lógica sería intesteable. La guarda sigue viva en los builds reales.
- **La config es `.mts`, no `.ts`.** El loader nativo de Vite trata un `.ts` en un paquete CommonJS como CJS y avisa que el `import.meta.url` de ahí va a dejar de funcionar. Poner `"type": "module"` no es opción: rompe `next.config.ts`, que usa `__dirname`.
- **Los tests no corren en `prebuild`.** Un test lento o inestable no debe poder bloquear un deploy de la landing; corren en CI.

La estrategia de testing del panel de administración (motor de comisiones, reparto de combos, llaves de ingest, contrato contra EA) vive en `docs/ADMIN-PANEL.md` § Testing.

## Panel de administración (`/admin`)

El plan completo vive en **`docs/ADMIN-PANEL.md`** — topología, modelo de datos, fases y verificación. El reparto en paquetes de trabajo y las reglas de propiedad de archivos viven en **`docs/WORK-PACKAGES.md`**, con cuatro agentes en `.claude/agents/` (`gbs-builder`, `gbs-money-auditor`, `gbs-verifier`, `gbs-ea-scout`). El runbook de despliegue en la VM (pinear EA, el SQL de `mysql-transversal`, el stack en Portainer, Caddy, y los ensayos de rollback y de restauración) vive en **`docs/DEPLOY.md`**. Cómo levantar el entorno local, qué va en cada `.env.local` y cómo validar cada paquete: **`docs/DEV-LOCAL.md`** (`deploy/compose/dev-stack.yml` levanta EA + MySQL + Mailpit; el panel corre en el host con `npm run dev`). Léelos antes de tocar nada bajo `admin/`. Lo mínimo para no romper cosas desde este repo:

- **`admin/` es una app Next hermana, no un workspace.** Nada dentro de `src/` se mueve. El build de la landing la ignora (`.vercelignore`, `tsconfig`, `eslint`), y `vercel.json` trae un `ignoreCommand` para que un push que solo toca `admin/` no dispare deploy de la landing.
- **El panel corre en la VM, no en Vercel.** Los reportes necesitan agregación SQL sobre las tablas de Easy!Appointments, y la API REST de EA no agrega. La landing hace un rewrite `beforeFiles` de `/admin/:path*` hacia `ADMIN_ORIGIN`; la app admin usa `basePath: "/admin"` para que sus chunks queden bajo `/admin/_next/*` y un solo rewrite cubra páginas y assets.
- **Es un servicio más del stack de Compose de EA, desplegado por Portainer desde Git.** CI construye la imagen, la empuja a GHCR y escribe el **digest** en `deploy/compose/.env`; Portainer CE hace polling del repo y redespliega (CE no tiene stack webhooks). De ahí dos reglas: **nunca `docker compose up` a mano en la VM** — el siguiente polling lo borra sin aviso — y `vercel.json` tiene que excluir también `deploy/`, o cada despliegue del panel redesplegaría la landing.
- **La API REST de EA no valida choques de horario** (el backend propio de EA sí, con `has_provider_conflict` + `force_save`; `Appointments_api_v1` no). Toda la detección de solapes es del panel, en `lib/conflict.ts`.
- **El sync con Google es de un solo sentido, a propósito.** Un calendario por técnica, todos propiedad de la cuenta de Workspace del estudio, conectados a EA con esa misma cuenta y compartidos en **solo lectura** al correo personal de cada una. El pull de EA (botón "Sincronizar" o comando de consola) **borra citas locales** cuando el evento ya no está en Google, y sin disparar webhook: no se corre nunca. El push falla en silencio — `id_google_calendar` vacío es la única señal.
- **Los webhooks de EA no reintentan**: `Webhooks_client::call()` traga la excepción y solo la loguea. Un panel caído pierde esos eventos para siempre, así que el reconcile nocturno es el mecanismo principal y el webhook solo lo adelanta. El payload es la fila cruda de la BD en snake_case, no la forma camelCase de la API.
- **`src/proxy.ts` tiene que excluir `admin` del matcher.** Next 16 corre `proxy` *antes* de los rewrites `beforeFiles`, así que sin eso `/admin` se redirige a `/es/admin` y el rewrite nunca dispara. Es el error silencioso más fácil de cometer aquí.
- **Las escrituras a EA van siempre por su API REST**, nunca a sus tablas — así disparan notificaciones y el sync de Google Calendar. MySQL se lee directo (usuario de solo lectura) únicamente para reportes.
- **Los combos son un servicio de EA cada uno**, no dos citas enlazadas: los ítems de la categoría `combos` en `src/data/pricing.ts` tienen precio y duración propios, *menores* que la suma de sus partes. Precio y duración son criterio de la dueña, no fórmula — nunca los auto-calcules.
- **La cuenta la cierra la técnica, y lo agendado no es lo realizado.** `appointment_finance` es un encabezado con renglones (`appointment_finance_item`): servicio realizado + adicionales de la categoría `extras`. Comisiones y reportes leen el servicio **realizado**, nunca el agendado, y la cita de EA no se reescribe. El push a Strapi va **por cierre diario**, no por cita: Actual Budget no actualiza el monto de una transacción ya importada.
- **Ningún precio se recalcula en retrospectiva.** `ea_appointments` no guarda dinero, así que el panel congela el precio del servicio al agendar. Una comisión calculada con el precio de hoy sobre una cita vieja está mal.

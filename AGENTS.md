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

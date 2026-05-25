<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Updating prices

Prices and durations live in **`src/data/pricing.ts`** — one number per service, language-agnostic. The formatter renders `"desde $180.000"` for `/es` and `"from $180,000 COP"` for `/en` from the same `priceCOP` value.

- **Yearly inflation bump:** edit `priceCOP` numbers in `src/data/pricing.ts`, commit, push. Vercel redeploys both languages.
- **New / renamed / removed service:** add or remove the entry in `src/data/pricing.ts`, then add/rename/remove the matching `{ name, desc }` under `servicios.categories.<catId>.items.<itemId>` in **both** `es.json` and `en.json`. The ids must match exactly.
- **Build guard:** `scripts/check-pricing.mjs` runs in `predev` and `prebuild` and fails fast if a pricing id has no translation, or a translation has no pricing entry. Run manually with `npm run check-pricing`.

## Promociones de temporada

Las promos viven en `src/data/promos.{es,en}.ts` (mismas keys de escenario en ambos archivos). El selector `getActiveScenario(lang)` en `src/data/promos.ts` lee la env var `NEXT_PUBLIC_ACTIVE_PROMO` para decidir qué escenario está activo. La shape ya espeja la del futuro Collection Type `promo-scenario` en Strapi; cuando se conecte el CMS solo se reemplaza el cuerpo de `getActiveScenario` (hay un bloque comentado con la implementación lista al final del archivo).

- **Cambiar el escenario activo:** poner `NEXT_PUBLIC_ACTIVE_PROMO=apertura` (o `madre`, `navidad`) en `.env.local` y reiniciar dev. Valores `vacio`, `none`, `off` o ausencia de env var = sin promoción (ni strip ni Highlights se renderizan).
- **Editar el contenido por-escenario:** modificar `promos.es.ts` y `promos.en.ts`. Manten las mismas `slug` keys en ambos.
- **Chrome estático** (eyebrow de la sección, footer): vive en `promos` dentro de `dictionaries/{es,en}.json`.
- **Imagen del featured:** si `image_url` está vacío, el card cae a un placeholder de mármol — sin romper layout. Reemplazar agregando el archivo a `/public/` y seteando `image_url: "/ruta.jpg"` en el item correspondiente.

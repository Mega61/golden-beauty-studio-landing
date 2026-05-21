<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Updating prices

Prices and durations live in **`src/data/pricing.ts`** — one number per service, language-agnostic. The formatter renders `"desde $180.000"` for `/es` and `"from $180,000 COP"` for `/en` from the same `priceCOP` value.

- **Yearly inflation bump:** edit `priceCOP` numbers in `src/data/pricing.ts`, commit, push. Vercel redeploys both languages.
- **New / renamed / removed service:** add or remove the entry in `src/data/pricing.ts`, then add/rename/remove the matching `{ name, desc }` under `servicios.categories.<catId>.items.<itemId>` in **both** `es.json` and `en.json`. The ids must match exactly.
- **Build guard:** `scripts/check-pricing.mjs` runs in `predev` and `prebuild` and fails fast if a pricing id has no translation, or a translation has no pricing entry. Run manually with `npm run check-pricing`.

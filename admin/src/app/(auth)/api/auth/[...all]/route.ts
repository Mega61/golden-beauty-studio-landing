import { toNextJsHandler } from "better-auth/next-js";

import { getAuth, panelBasePath } from "@/lib/auth";

/**
 * El montaje de Better Auth: `/admin/api/auth/*`.
 *
 * Vive dentro del grupo `(auth)` — los grupos de rutas no aparecen en la URL,
 * así que el path real es `/api/auth/[...all]` y, con el `basePath: "/admin"` de
 * `next.config.ts`, queda en `https://goldenbeautystudio.com.co/admin/api/auth/*`.
 * Es exactamente lo que promete `authMountUrl()` y lo que el redirect URI del
 * cliente de Google tiene registrado.
 *
 * El handler se resuelve por request y no en el import: `getAuth()` construye la
 * instancia la primera vez, y construirla exige las variables del stack que
 * `next build` no tiene.
 *
 * ## Por qué se le devuelve el `basePath` a la request
 *
 * **Next recorta el `basePath` del `request.url` que recibe un Route Handler.**
 * Verificado corriéndolo: pidiendo `/admin/api/auth/get-session`, el handler ve
 * `http://host/api/auth/get-session`, sin `/admin`.
 *
 * Better Auth usa un solo valor, `baseURL`, para dos cosas que acá difieren:
 * enruta recortando `new URL(ctx.baseURL).pathname`
 * (`node_modules/better-auth/dist/api/index.mjs:152`) y arma con ese mismo
 * prefijo las URLs absolutas del OAuth (`redirectURI` en
 * `dist/api/routes/sign-in.mjs` y `dist/api/routes/callback.mjs`). Si `baseURL`
 * no llevara `/admin`, el `redirect_uri` que se le manda a Google perdería el
 * prefijo y la vuelta caería en la landing; si lo lleva —que es lo correcto—
 * ninguna ruta matchea contra la URL recortada y **todo responde 404 en
 * silencio**, que es exactamente lo que pasaba antes de esta línea.
 *
 * Así que la request se reescribe con el prefijo puesto, que es la forma que la
 * clienta pidió de verdad, y `baseURL` puede ser la URL pública completa. El
 * prefijo sale de `BETTER_AUTH_URL`, no de una constante escrita dos veces.
 *
 * Runtime Node y no Edge: el adaptador habla con MySQL por `mysql2`, que es un
 * socket TCP.
 */
export const runtime = "nodejs";

// Nada de esto se cachea: son respuestas con credenciales adentro.
export const dynamic = "force-dynamic";

function restoreBasePath(request: Request): Request {
  const base = panelBasePath();
  if (base === "") return request;

  const url = new URL(request.url);
  if (url.pathname === base || url.pathname.startsWith(`${base}/`)) return request;
  url.pathname = `${base}${url.pathname}`;

  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    // `duplex` es parte del estándar de fetch y undici lo exige cuando el
    // cuerpo es un stream —el caso de cualquier POST que llegue acá—, pero
    // todavía no está en los tipos de `RequestInit` de TypeScript.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

export async function GET(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth().handler).GET(restoreBasePath(request));
}

export async function POST(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth().handler).POST(restoreBasePath(request));
}

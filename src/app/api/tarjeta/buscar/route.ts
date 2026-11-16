import { type NextRequest, NextResponse } from "next/server";

import { adminOrigin, clientIp, fail, rateLimited } from "../../reservas/guards";

/**
 * "Encuentra tu tarjeta Golden": celular + primer nombre → link de la tarjeta
 * de sellos. Proxy de solo lectura al panel (`/admin/api/public/tarjeta/buscar`),
 * que lee Stampee y decide; las reglas y el riesgo aceptado están en el panel,
 * `admin/src/lib/stampee/card-lookup.ts`.
 *
 * Su propio cupo y apretado: ocho búsquedas en diez minutos sobran para una
 * persona que se equivocó escribiendo y no le sirven a quien quiera barrer
 * números. El panel bloquea además el celular tras cinco nombres errados.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_MAX = 8;

export async function POST(req: NextRequest) {
  if (rateLimited(clientIp(req), RATE_MAX, "tarjeta")) return fail("rate_limited", 429);

  const origin = adminOrigin();
  if (!origin) return fail("unavailable", 503);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null) return fail("validation", 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return fail("validation", 400);
  }

  const payload = {
    phone: typeof body.phone === "string" ? body.phone.trim().slice(0, 60) : "",
    name: typeof body.name === "string" ? body.name.trim().slice(0, 60) : "",
  };

  try {
    const res = await fetch(`${origin}/admin/api/public/tarjeta/buscar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    if (res.status === 400) return fail("validation", 400);
    if (!res.ok) return fail("unavailable", res.status === 503 ? 503 : 502);
    const data = (await res.json()) as Record<string, unknown>;
    // Solo los campos que la sección muestra, aunque el panel mande más.
    const out =
      data.found === true
        ? {
            found: true,
            url: data.url,
            stamps: data.stamps,
            totalStamps: data.totalStamps,
            rewardName: data.rewardName,
          }
        : { found: false };
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[tarjeta/buscar] el panel no respondió", error);
    return fail("unavailable", 503);
  }
}

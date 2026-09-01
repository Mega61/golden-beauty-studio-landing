import { NextResponse } from "next/server";

import { buildHealthReport } from "@/lib/health";

/**
 * Sonda de salud del contenedor. La lee el `healthcheck` del compose, y de
 * rebote Portainer, que es donde la dueña ve si el panel está vivo.
 *
 * Hoy solo reporta que el proceso responde. A medida que lleguen las
 * dependencias reales, `buildHealthReport()` va sumando comprobaciones
 * (MySQL, API de EA) — la forma de la respuesta no cambia, así que el
 * healthcheck del compose no hay que tocarlo nunca más.
 *
 * `dynamic = "force-dynamic"`: sin esto Next podría servir una respuesta
 * cacheada en el build, y un healthcheck cacheado responde 200 con el proceso
 * muerto.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const report = await buildHealthReport();

  return NextResponse.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}

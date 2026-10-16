import type { NextRequest } from "next/server";

import { getDb } from "@/db/client";
import { auditLogRepository } from "@/db/repositories";
import { can } from "@/lib/auth-policy";
import { verifySession } from "@/lib/dal";

import { buildMetaCsv, metaFilename, parseSegment, selectSegment } from "../../meta-export";
import { loadMetaAudience } from "../../meta-export-data";

/**
 * `GET /admin/clientes/exportar-meta/descargar?segmento=…` — el CSV cifrado
 * para una audiencia personalizada de Meta.
 *
 * Es de la dueña (`clientes:exportar`) y se pregunta **acá**, no solo en la
 * pantalla: el enlace se puede escribir a mano. Sin sesión, 401; con sesión
 * sin el permiso, 403 — un Route Handler contesta con códigos, no con
 * redirecciones a una pantalla.
 *
 * ## La bitácora, antes de entregar
 *
 * Cada descarga deja una fila en `audit_log` con el segmento y cuántas filas
 * salieron, **nunca** los datos: la bitácora no puede ser otra copia de la
 * clientela. Se escribe antes de responder, y si no se puede escribir no hay
 * archivo: una exportación masiva de datos personales sin rastro es
 * exactamente lo que la bitácora existe para impedir.
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const session = await verifySession();
  if (session === null) {
    return new Response("Hace falta iniciar sesión.", { status: 401 });
  }
  if (!can(session.role, "clientes:exportar")) {
    return new Response("Exportar la lista de clientas es de la dueña.", { status: 403 });
  }

  const segment = parseSegment(request.nextUrl.searchParams.get("segmento"));
  if (segment === null) {
    return new Response("Segmento desconocido. Es todas, ultimos-180 o inactivas-60.", {
      status: 400,
    });
  }

  const load = await loadMetaAudience();
  if (!load.ok) return new Response(load.message, { status: 503 });

  const people = selectSegment(load.audience.people, segment, load.today);
  const csv = buildMetaCsv(people);
  const filename = metaFilename(segment, load.today);

  try {
    await auditLogRepository(getDb()).append({
      actorUserId: session.userId,
      action: "clientes.export_meta",
      entity: "clientes",
      entityId: segment,
      after: {
        segmento: segment,
        filas: people.length,
        sin_telefono_ea: load.audience.customersWithoutPhone,
        sin_telefono_historico: load.audience.legacyWithoutPhone,
        archivo: filename,
      },
      at: new Date(),
    });
  } catch (error) {
    console.error("[clientes] no se pudo anotar la exportación en la bitácora", error);
    return new Response(
      "No se pudo anotar la exportación en la bitácora, así que no se entrega el archivo. Intenta de nuevo.",
      { status: 503 },
    );
  }

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Datos personales, aunque vayan cifrados: ni el navegador ni un proxy
      // intermedio se quedan con una copia.
      "Cache-Control": "no-store",
    },
  });
}

import "server-only";

import { loadHistoryByPhone } from "@/app/(panel)/clientes/data";
import { hasVisitedBefore } from "@/app/(panel)/clientes/history";
import { normalizePhoneE164 } from "@/app/(panel)/clientes/identity";
import { getDb } from "@/db/client";
import { serviceMapRepository } from "@/db/repositories";
import { createCachedEaClient, type EaClient } from "@/lib/ea/client";
import { instantToEaLocal, type EaLocalDate } from "@/lib/ea/datetime";
import { buildQuoteLines, createLookupGate, quoteVisit, type LookupGate, type Quote } from "./quote";

/**
 * Cuánto cuesta una visita reservada desde la landing, con la promo que le
 * toca. Solo lee: **no decide ninguna escritura**, por eso puede leer de la
 * caché de EA (`createCachedEaClient`). Lo que se cobra lo decide el cierre de
 * la cuenta en el estudio, con datos frescos; esto es lo que se le muestra a
 * la clienta mientras reserva.
 */

export type QuoteInput = {
  serviceId: number;
  thenServiceId: number | null;
  date: EaLocalDate;
  /** Tal como lo escribió. `null` o inválido = no se consulta la primera visita. */
  phone: string | null;
};

export type QuoteResult = { status: "ok"; quote: Quote } | { status: "unknown-service" };

/**
 * Seis consultas nuevas cada dos minutos, como mucho. Una consulta son hasta
 * seis búsquedas de clientas (las variantes del número) más sus citas: con
 * este tope el peor caso se lleva menos de la mitad del cupo de EA y le deja
 * el resto a la agenda. Diez minutos de recuerdo por teléfono.
 */
const GATE_KEY = Symbol.for("gbs.public-quote.first-visit-gate");

function gate(): LookupGate {
  const g = globalThis as unknown as Record<symbol, LookupGate | undefined>;
  return (g[GATE_KEY] ??= createLookupGate({ maxLookups: 6, windowMs: 120_000, memoMs: 10 * 60_000 }));
}

export async function loadQuote(input: QuoteInput): Promise<QuoteResult> {
  const client = createCachedEaClient();
  const [services, serviceMap] = await Promise.all([
    client.services.list(),
    serviceMapRepository(getDb())
      .listAll()
      .catch((error: unknown) => {
        // Sin mapa no hay ids de vitrina, y sin ellos no hay promo del día: se
        // cotiza a precio de lista, que es lo que se cobraba antes de esto.
        console.error("[public/booking/cotizar] sin service_map", error);
        return [];
      }),
  ]);

  const slugOf = new Map(serviceMap.map((row) => [row.ea_service_id, row.pricing_id]));
  const lines = buildQuoteLines(input, services, slugOf);
  if (lines === null) return { status: "unknown-service" };

  const firstVisit = await resolveFirstVisit(input.phone, client);
  return { status: "ok", quote: quoteVisit(lines, input.date, firstVisit) };
}

/**
 * ¿Es su primera visita? `null` cuando no se puede afirmar ni negar: sin
 * número válido, sin cupo para preguntarle a EA, o con el historial a medias.
 * Prometer un 10% que el estudio después no reconoce es peor que no mostrarlo.
 */
async function resolveFirstVisit(raw: string | null, client: EaClient): Promise<boolean | null> {
  const phone = raw === null ? null : normalizePhoneE164(raw);
  if (phone === null) return null;

  const known = gate().remembered(phone);
  if (known !== undefined) return known;
  if (!gate().take()) return null;

  try {
    const { history, partial } = await loadHistoryByPhone(phone, client);
    if (partial) return null;
    // Lo que ya pasó hasta ahora. Una cita futura que todavía no se atendió no
    // la vuelve conocida: quien reservó y no ha venido sigue siendo nueva.
    const firstVisit = !hasVisitedBefore(history.entries, instantToEaLocal(new Date()));
    gate().remember(phone, firstVisit);
    return firstVisit;
  } catch (error) {
    console.error("[public/booking/cotizar] no se pudo leer el historial", error);
    return null;
  }
}

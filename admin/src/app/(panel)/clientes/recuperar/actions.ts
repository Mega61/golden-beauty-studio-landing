"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { FIRST_VISIT_PERCENT } from "@/data/promo-rules";
import { getDb } from "@/db/client";
import { auditLogRepository, waMessageRepository, winbackRepository } from "@/db/repositories";
import { ForbiddenError, requireCapability } from "@/lib/dal";
import { instantToEaDate } from "@/lib/ea";
import { issueWinbackCard, loadLoyalty } from "@/lib/stampee/client";
import { waMeLink } from "@/lib/whatsapp/manual-reminder";
import {
  addCalendarDays,
  formatDayMonth,
  renderWinbackMessage,
  unknownFields,
  WINBACK_BOOKING_URL,
} from "@/lib/winback";

import type { SendOutcome } from "../../recordatorios/open-whatsapp";
import { normalizePhoneE164 } from "../identity";
import { loadMetaAudience } from "../meta-export-data";
import { settingsFrom } from "./data";

/**
 * "Enviar regalo": le emite a la clienta la tarjeta de "Te extrañamos" en
 * Stampee, anota la oferta (y con ella el 10 %) y devuelve el chat de WhatsApp
 * con el mensaje ya escrito.
 *
 * El servidor decide todo: la clienta sale de la audiencia (no del navegador),
 * la campaña y el texto de la configuración, el link de la tarjeta de Stampee.
 * La fila va **antes** de abrir WhatsApp, como en los recordatorios. Una
 * segunda vez reusa la misma tarjeta y lo prometido la primera vez; solo
 * actualiza cuándo se reenvió.
 */
export async function enviarRegalo(phoneRaw: string): Promise<SendOutcome> {
  try {
    const session = await requireCapability("recuperar:enviar");
    const phone = normalizePhoneE164(phoneRaw);
    if (phone === null) return { ok: false, message: "Ese número no se reconoce." };

    const db = getDb();
    const repo = winbackRepository(db);
    const settings = settingsFrom(await repo.getConfig());
    if (settings.campaignId === null) {
      return { ok: false, message: "Primero elige la campaña de Stampee en la configuración de abajo." };
    }
    if ((await waMessageRepository(db).listOptedOut([phone])).has(phone)) {
      return { ok: false, message: "Esta clienta pidió no recibir mensajes por WhatsApp." };
    }

    const audience = await loadMetaAudience();
    if (!audience.ok) return { ok: false, message: audience.message };
    const person = audience.audience.people.find((p) => p.phone === phone);
    if (!person) return { ok: false, message: "Esa clienta ya no está en la lista." };
    const fullName = `${person.firstName} ${person.lastName}`.trim();

    const now = new Date();
    const today = instantToEaDate(now);
    const previous = await repo.findOffer(phone);

    const issued = await issueWinbackCard({
      phone,
      name: fullName,
      campaignId: previous?.stampeeCardId ? (await campaignOf(previous.stampeeCardId)) ?? settings.campaignId : settings.campaignId,
      actorName: session.name || session.email,
      today,
    });
    if (!issued.ok) return { ok: false, message: issued.message };

    const discountPercent = previous ? previous.discountPercent : settings.discountEnabled ? FIRST_VISIT_PERCENT : 0;
    const expiresOn = previous
      ? previous.expiresOn
      : settings.validDays && discountPercent > 0
        ? addCalendarDays(today, settings.validDays)
        : null;

    await repo.recordSent(
      {
        phone,
        clientName: fullName || null,
        stampeeCustomerId: issued.customerId,
        stampeeCardId: issued.card.id,
        stampeeCardUniqueId: issued.card.uniqueId,
        giftedStamps: previous?.giftedStamps ?? issued.card.stamps,
        discountPercent,
        expiresOn,
      },
      session.userId,
      now,
    );

    await auditLogRepository(db)
      .append({
        actorUserId: session.userId,
        action: previous ? "recuperar.reenviar" : "recuperar.enviar",
        entity: "winback_offer",
        entityId: phone,
        after: { card: issued.card.id, created: issued.created, discountPercent, expiresOn },
        at: now,
      })
      .catch((error) => console.error("[recuperar] no se pudo anotar en la bitácora", error));

    const text = renderWinbackMessage(settings.template, {
      nombre: person.firstName || null,
      sellos: String(previous?.giftedStamps ?? issued.card.stamps),
      meta: String(issued.card.totalStamps),
      premio: issued.card.rewardName || null,
      descuento: discountPercent > 0 ? String(discountPercent) : null,
      vence: expiresOn ? formatDayMonth(expiresOn) : null,
      link: `${issued.cardBaseUrl}/${issued.card.uniqueId}?src=whatsapp`,
      reservar: WINBACK_BOOKING_URL,
    });
    const url = waMeLink(phone, text);
    if (url === null) return { ok: false, message: "Ese número no sirve para WhatsApp." };

    revalidatePath("/clientes/recuperar");
    revalidatePath("/fidelidad");
    return { ok: true, url, already: previous !== null, sentLabel: "Regalo enviado" };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Mandar el regalo es de la dueña o de recepción." };
    }
    console.error("[recuperar] no se pudo preparar el regalo", error);
    return { ok: false, message: "No se pudo preparar el mensaje. Intenta de nuevo." };
  }
}

/** La campaña de una tarjeta ya emitida, para que reenviar no emita otra si cambió la configuración. */
async function campaignOf(cardId: string): Promise<string | null> {
  const loyalty = await loadLoyalty();
  if (!loyalty.ok) return null;
  for (const client of loyalty.data.clients) {
    const card = client.cards.find((c) => c.id === cardId);
    if (card) return card.campaignId;
  }
  return null;
}

// ── Configuración ───────────────────────────────────────────────────────────

export type ConfigResult = { ok: boolean; message: string };

const ConfigInput = z.object({
  campaignId: z.string().trim().max(120),
  template: z.string().max(2000),
  discountEnabled: z.boolean(),
  validDays: z.number().int().min(0).max(365),
  lapsedDays: z.number().int().min(14).max(730),
});

export async function guardarConfigRecuperar(input: z.input<typeof ConfigInput>): Promise<ConfigResult> {
  try {
    const session = await requireCapability("recuperar:configurar");
    const parsed = ConfigInput.safeParse(input);
    if (!parsed.success) return { ok: false, message: "Revisa los números: algo quedó fuera de rango." };
    const data = parsed.data;

    const typos = unknownFields(data.template);
    if (typos.length > 0) {
      return { ok: false, message: `El mensaje usa ${typos.map((t) => `{${t}}`).join(", ")}, que no existe.` };
    }
    if (!data.template.includes("{link}")) {
      return { ok: false, message: "El mensaje tiene que llevar {link}: sin él la clienta no ve su tarjeta." };
    }

    if (data.campaignId !== "") {
      const loyalty = await loadLoyalty();
      if (loyalty.ok && !loyalty.data.campaigns.some((c) => c.id === data.campaignId)) {
        return { ok: false, message: "Esa campaña ya no está en Stampee." };
      }
    }

    const now = new Date();
    await winbackRepository(getDb()).saveConfig(
      {
        stampeeCampaignId: data.campaignId || null,
        messageTemplate: data.template,
        discountEnabled: data.discountEnabled,
        validDays: data.validDays === 0 ? null : data.validDays,
        lapsedDays: data.lapsedDays,
      },
      session.userId,
      now,
    );
    await auditLogRepository(getDb())
      .append({
        actorUserId: session.userId,
        action: "recuperar.configurar",
        entity: "winback_config",
        entityId: "1",
        after: { ...data, template: undefined },
        at: now,
      })
      .catch((error) => console.error("[recuperar] no se pudo anotar en la bitácora", error));

    revalidatePath("/clientes/recuperar");
    return { ok: true, message: "Configuración guardada." };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) return { ok: false, message: "La configuración es de la dueña." };
    console.error("[recuperar] no se pudo guardar la configuración", error);
    return { ok: false, message: "No se pudo guardar. Intenta de nuevo." };
  }
}

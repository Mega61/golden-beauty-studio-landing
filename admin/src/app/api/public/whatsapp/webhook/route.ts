import type { NextRequest } from "next/server";

import { normalizePhoneE164 } from "@/app/(panel)/clientes/identity";
import { getDb } from "@/db";
import { repositories } from "@/db/repositories";
import { parseWhatsappWebhookEnv } from "@/lib/whatsapp/config";
import {
  applyWebhook,
  parseWebhookPayload,
  verificationChallenge,
  verifyMetaSignature,
} from "@/lib/whatsapp/webhook";

/**
 * `/admin/api/public/whatsapp/webhook` — los eventos de WhatsApp (Meta).
 *
 * URL pública para registrar en Meta:
 * `https://www.goldenbeautystudio.com.co/admin/api/public/whatsapp/webhook`.
 * Llega por el rewrite de `/admin/:path*` de la landing (Vercel) → Caddy →
 * este contenedor. Vive bajo `api/public/` y **no** bajo `api/webhooks/` a
 * propósito: Caddy responde 404 a `/admin/api/webhooks/*` desde afuera (el de
 * EA no se firma y solo se atiende por la red interna), y este sí tiene que
 * llegar desde internet. Ver `docs/WHATSAPP.md`.
 *
 * - `GET`: el saludo de suscripción. Meta manda `hub.verify_token` y espera
 *   `hub.challenge` de vuelta.
 * - `POST`: estados de los mensajes que mandamos y mensajes entrantes. Se
 *   verifica `X-Hub-Signature-256` contra el cuerpo **crudo** antes de leer
 *   nada; lo que importa se aplica (`lib/whatsapp/webhook.ts`) y el resto se
 *   ignora con 200.
 *
 * Si la escritura en la base falla se responde 500: Meta reintenta los
 * webhooks que no reciben 200, y todo lo que se aplica acá es idempotente
 * (estados solo hacia adelante, baja con llave primaria).
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: NextRequest): Promise<Response> {
  const config = parseWhatsappWebhookEnv(process.env);
  if (config === null) return new Response("not configured", { status: 503, headers: NO_STORE });

  const challenge = verificationChallenge(request.nextUrl.searchParams, config.verifyToken);
  if (challenge === null) return new Response("forbidden", { status: 403, headers: NO_STORE });
  return new Response(challenge, {
    status: 200,
    headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const config = parseWhatsappWebhookEnv(process.env);
  // Sin secreto no hay cómo distinguir a Meta de cualquiera: se rechaza todo.
  if (config === null) return Response.json({ status: "misconfigured" }, { status: 503, headers: NO_STORE });

  const raw = await request.text();
  const signature = verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"), config.appSecret);
  if (!signature.ok) {
    console.warn(`[whatsapp] webhook rechazado: firma ${signature.reason}`);
    return Response.json({ status: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // Firmado pero ilegible: no va a mejorar reintentando.
    return Response.json({ status: "ignored" }, { status: 200, headers: NO_STORE });
  }

  try {
    const parsed = parseWebhookPayload(body, config.phoneNumberId);
    const applied = await applyWebhook(parsed, repositories(getDb()).waMessages, (value) =>
      normalizePhoneE164(value),
    );
    return Response.json({ status: "ok", ...applied }, { status: 200, headers: NO_STORE });
  } catch (error) {
    console.error("[whatsapp] no se pudo aplicar el webhook; Meta lo va a reintentar", error);
    return Response.json({ status: "error" }, { status: 500, headers: NO_STORE });
  }
}

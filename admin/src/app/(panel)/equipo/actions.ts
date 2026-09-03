"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { allowedUserRepository, auditLogRepository, staffTotpRepository } from "@/db/repositories";
import { confirmStaffTotp, enrollStaffTotp } from "@/lib/auth";
import { requireCapability } from "@/lib/dal";

/**
 * Las escrituras de Equipo.
 *
 * Todas piden `equipo:administrar`, que en la matriz de `auth-policy.ts` es
 * **solo de la dueña**: la recepción opera el día completo pero no administra a
 * las personas. La comprobación va acá y no en el botón — esconder el botón es
 * cortesía con la usuaria; la Server Action sigue existiendo sin él.
 *
 * ## Lo que no está acá, y por qué
 *
 * **No se edita el plan de trabajo ni los servicios asignados.** Los dos se
 * configuran una vez y se tocan cada varios meses; reconstruir sus formularios
 * es reconstruir dos pantallas de EA que hay que volver a verificar en cada
 * upgrade suyo. La ficha los muestra y enlaza a EA para cambiarlos, que es la
 * regla de § Paridad con EA.
 *
 * **No se conecta ni se desconecta Google.** El token vive en EA; el panel
 * enlaza a su flujo. Reconstruir OAuth de otra aplicación para poder romperlo
 * desde dos lugares no le compra nada a nadie.
 */

export type ActionResult = { ok: boolean; message: string };

/**
 * Alta de una técnica en el panel.
 *
 * ⚠ **Inserta la fila de `user` de Better Auth directamente.** No hay otra
 * forma hoy: `lib/auth.ts` expone `enrollStaffTotp()` y `confirmStaffTotp()`,
 * que ya asumen un `user` existente, y una técnica **nunca** crea el suyo por
 * OAuth — la compuerta de Workspace la deja afuera por diseño, que es
 * exactamente el motivo de que exista el TOTP. Sin esta alta, el enrolamiento
 * no tendría a quién enrolar.
 *
 * La fila es inerte para Better Auth: sin `account`, sin contraseña, y con un
 * correo personal que la compuerta de Workspace rechaza. Su único trabajo es
 * ser la llave foránea de `staff_totp` y llevar el nombre que se ve en la
 * grilla del login. Aun así **le corresponde a B2**, y queda pedido en el
 * reporte como `createStaffAccount()` en `lib/auth.ts`.
 *
 * **El correo es el personal de la técnica, y es real.** No se inventa: es el
 * mismo al que se le comparte su calendario de Google en solo lectura, y es la
 * llave con la que `verifySession()` cruza la allowlist en cada request.
 */
export async function crearCuentaTecnica(
  _previo: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await requireCapability("equipo:administrar");

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const rawProvider = String(formData.get("eaProviderId") ?? "").trim();

  if (name === "") return { ok: false, message: "Falta el nombre." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: "El correo no tiene forma de correo." };
  }
  const eaProviderId = rawProvider === "" ? null : Number(rawProvider);
  if (eaProviderId !== null && !Number.isSafeInteger(eaProviderId)) {
    return { ok: false, message: "El id de la profesional no es válido." };
  }

  const db = getDb();

  try {
    const existing = await allowedUserRepository(db).findByEmail(email);
    if (existing) {
      return { ok: false, message: `${email} ya tiene cuenta en el panel.` };
    }

    const already = await db
      .selectFrom("user")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirst();

    const userId = already?.id ?? randomUUID();
    if (!already) {
      const now = new Date();
      await db
        .insertInto("user")
        .values({
          id: userId,
          name,
          email,
          // Nunca pasó por Google: decir lo contrario sería mentirle a la
          // compuerta de Workspace, que es lo único que la mira.
          emailVerified: 0,
          image: null,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
    }

    await allowedUserRepository(db).insert({
      email,
      role: "staff",
      ea_provider_id: eaProviderId,
    });

    await auditLogRepository(db).append({
      actorUserId: session.userId,
      action: "equipo.alta",
      entity: "allowed_user",
      entityId: email,
      after: { role: "staff", ea_provider_id: eaProviderId },
      at: new Date(),
    });

    revalidatePath("/equipo");
    return {
      ok: true,
      message: `${name} ya está en el panel. Falta enrolarle el código.`,
    };
  } catch (error) {
    console.error("[equipo] no se pudo crear la cuenta", error);
    return { ok: false, message: "No se pudo crear la cuenta." };
  }
}

/**
 * Genera el secreto y devuelve el `otpauth://`. **Se muestra una sola vez.**
 *
 * El URI vuelve al componente cliente y vive solo en su estado: no se guarda,
 * no viaja en la URL y no sobrevive a recargar la página. Después de esto el
 * secreto solo existe cifrado en `staff_totp` y en el celular de la técnica.
 *
 * Re-enrolar **es** el mecanismo de recuperación: si el celular se pierde, los
 * códigos de respaldo se pierden con él, y un QR nuevo en treinta segundos
 * resuelve más que un papel impreso. Por eso esta acción pisa el secreto
 * anterior sin preguntar dos veces, y la cuenta vuelve a quedar sin confirmar
 * hasta que llegue un código válido.
 */
export async function enrolarTotp(
  userId: string,
  accountLabel: string,
): Promise<{ ok: true; otpauthUrl: string } | { ok: false; message: string }> {
  const session = await requireCapability("equipo:administrar");

  try {
    const { otpauthUrl } = await enrollStaffTotp({ userId, accountLabel });
    await auditLogRepository(getDb()).append({
      actorUserId: session.userId,
      action: "equipo.totp.enrolar",
      entity: "staff_totp",
      entityId: userId,
      at: new Date(),
    });
    revalidatePath("/equipo");
    return { ok: true, otpauthUrl };
  } catch (error) {
    console.error("[equipo] no se pudo enrolar", error);
    return { ok: false, message: "No se pudo generar el código de enrolamiento." };
  }
}

/**
 * El primer código válido cierra el alta.
 *
 * Hasta acá la cuenta **no entra**: `listTotpLoginCandidates()` solo muestra en
 * la grilla del login a quien tenga `confirmed_at`. Es lo que evita que un QR
 * generado y nunca escaneado deje una cuenta a medio hacer que igual aparece
 * como si sirviera.
 */
export async function confirmarTotp(
  userId: string,
  code: string,
): Promise<ActionResult> {
  const session = await requireCapability("equipo:administrar");

  try {
    const ok = await confirmStaffTotp({ userId, code });
    if (!ok) {
      return {
        ok: false,
        message: "Ese código no sirvió. Revisa la app y prueba con el siguiente.",
      };
    }
    await auditLogRepository(getDb()).append({
      actorUserId: session.userId,
      action: "equipo.totp.confirmar",
      entity: "staff_totp",
      entityId: userId,
      at: new Date(),
    });
    revalidatePath("/equipo");
    return { ok: true, message: "Listo: la cuenta ya puede entrar con su código." };
  } catch (error) {
    console.error("[equipo] no se pudo confirmar el enrolamiento", error);
    return { ok: false, message: "No se pudo confirmar el enrolamiento." };
  }
}

/** Soltar una cuenta bloqueada por intentos fallidos. */
export async function desbloquearTotp(userId: string): Promise<ActionResult> {
  const session = await requireCapability("equipo:administrar");

  try {
    const db = getDb();
    await staffTotpRepository(db).unlock(userId);
    await auditLogRepository(db).append({
      actorUserId: session.userId,
      action: "equipo.totp.desbloquear",
      entity: "staff_totp",
      entityId: userId,
      at: new Date(),
    });
    revalidatePath("/equipo");
    return { ok: true, message: "Cuenta desbloqueada." };
  } catch (error) {
    console.error("[equipo] no se pudo desbloquear", error);
    return { ok: false, message: "No se pudo desbloquear la cuenta." };
  }
}

/**
 * Cerrar todas las sesiones abiertas de una persona.
 *
 * Es lo que se hace el día que alguien pierde el teléfono. **Sacarla de la
 * allowlist y revocarle la sesión son dos actos distintos** (así lo dejó A2), y
 * a veces solo se quiere el segundo: la sesión dura 30 días deslizantes y el
 * teléfono perdido la lleva puesta.
 */
export async function revocarSesiones(userId: string): Promise<ActionResult> {
  const session = await requireCapability("equipo:administrar");

  try {
    const db = getDb();
    const result = await db
      .deleteFrom("session")
      .where("userId", "=", userId)
      .executeTakeFirst();
    await auditLogRepository(db).append({
      actorUserId: session.userId,
      action: "equipo.sesiones.revocar",
      entity: "user",
      entityId: userId,
      at: new Date(),
    });
    revalidatePath("/equipo");
    const count = Number(result.numDeletedRows ?? 0);
    return {
      ok: true,
      message:
        count === 0
          ? "No había sesiones abiertas."
          : `Se cerraron ${count} sesiones. Va a tener que entrar de nuevo.`,
    };
  } catch (error) {
    console.error("[equipo] no se pudieron revocar las sesiones", error);
    return { ok: false, message: "No se pudieron cerrar las sesiones." };
  }
}

/**
 * Quitar a alguien del panel.
 *
 * Borra la fila de la allowlist y nada más: el provider sigue en EA con sus
 * citas y su historia, y su fila de `user` sigue existiendo. El efecto es
 * inmediato igual — `verifySession()` lee la allowlist en **cada** request, así
 * que la sesión abierta deja de valer en la siguiente.
 */
export async function quitarDelPanel(
  allowedUserId: number,
  email: string,
): Promise<ActionResult> {
  const session = await requireCapability("equipo:administrar");

  if (email.toLowerCase() === session.email.toLowerCase()) {
    return {
      ok: false,
      message: "No te puedes quitar a vos misma: quedaría el panel sin dueña.",
    };
  }

  try {
    const db = getDb();
    await allowedUserRepository(db).remove(allowedUserId);
    await auditLogRepository(db).append({
      actorUserId: session.userId,
      action: "equipo.baja",
      entity: "allowed_user",
      entityId: email,
      before: { id: allowedUserId, email },
      at: new Date(),
    });
    revalidatePath("/equipo");
    return {
      ok: true,
      message: `${email} ya no entra al panel. Sus sesiones abiertas dejan de valer en la request siguiente.`,
    };
  } catch (error) {
    console.error("[equipo] no se pudo quitar del panel", error);
    return { ok: false, message: "No se pudo quitar del panel." };
  }
}

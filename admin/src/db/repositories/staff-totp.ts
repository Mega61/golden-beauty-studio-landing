import type { AuthId, StaffTotp } from "../types";
import type { Db } from "./shared";

/**
 * El enrolamiento TOTP de las técnicas.
 *
 * **La verificación del código no está acá.** Comparar en tiempo constante,
 * tolerar ±1 step y no más, y rechazar un step ya consumido son decisiones de
 * `lib/totp.ts`, que es código de autenticación escrito a mano y entra completo
 * a la capa 1 de tests. Este repositorio lee y escribe el estado sobre el que
 * esa función decide.
 *
 * El secreto entra y sale cifrado. Este módulo nunca ve el valor en claro: la
 * llave es `TOTP_ENC_KEY` y vive en `lib/totp.ts`.
 */
export function staffTotpRepository(db: Db) {
  return {
    async findByUserId(userId: AuthId): Promise<StaffTotp | undefined> {
      return db
        .selectFrom("staff_totp")
        .selectAll()
        .where("user_id", "=", userId)
        .executeTakeFirst();
    },

    /**
     * Enrolar (o re-enrolar) a una técnica.
     *
     * La recuperación **es** el re-enrolamiento: si el celular se pierde, los
     * códigos de respaldo se pierden con él, y un QR nuevo en treinta segundos
     * resuelve más. Por eso esto pisa el secreto anterior y reinicia el estado
     * completo — incluido `last_used_step`, que pertenecía al secreto viejo y
     * sobre el nuevo no significa nada.
     *
     * Queda **sin confirmar**: hasta que la técnica escanee el QR y mande un
     * código válido, la cuenta no entra.
     */
    async enroll(userId: AuthId, secretEncrypted: Buffer): Promise<void> {
      const existing = await db
        .selectFrom("staff_totp")
        .select("user_id")
        .where("user_id", "=", userId)
        .executeTakeFirst();

      const fresh = {
        secret_encrypted: secretEncrypted,
        confirmed_at: null,
        last_used_step: null,
        failed_attempts: 0,
        first_failed_at: null,
        locked_until: null,
      };

      if (!existing) {
        await db
          .insertInto("staff_totp")
          .values({ user_id: userId, ...fresh })
          .execute();
        return;
      }
      await db
        .updateTable("staff_totp")
        .set(fresh)
        .where("user_id", "=", userId)
        .execute();
    },

    /** El primer código válido confirma el enrolamiento y consume su step. */
    async confirm(userId: AuthId, at: Date, step: number): Promise<void> {
      await db
        .updateTable("staff_totp")
        .set({
          confirmed_at: at,
          last_used_step: step,
          failed_attempts: 0,
          first_failed_at: null,
          locked_until: null,
        })
        .where("user_id", "=", userId)
        .execute();
    },

    /**
     * Login exitoso: consume el step y limpia la racha de fallos.
     *
     * Guardar el step es la anti-repetición, y es obligatoria: un código vive
     * 30 segundos, y alguien que lo vea por encima del hombro podría reusarlo
     * dentro de esa ventana.
     */
    async recordSuccess(userId: AuthId, step: number): Promise<void> {
      await db
        .updateTable("staff_totp")
        .set({
          last_used_step: step,
          failed_attempts: 0,
          first_failed_at: null,
          locked_until: null,
        })
        .where("user_id", "=", userId)
        .execute();
    },

    /**
     * Escribe el estado de la racha de fallos que calculó `lib/totp.ts`.
     *
     * El repositorio no cuenta ni decide el bloqueo. "5 fallos en 15 minutos"
     * es una ventana deslizante y una decisión de política: se calcula en una
     * función pura, con el reloj inyectado, y se testea; acá se guarda el
     * resultado.
     */
    async recordFailure(
      userId: AuthId,
      state: {
        failedAttempts: number;
        firstFailedAt: Date | null;
        lockedUntil: Date | null;
      },
    ): Promise<void> {
      await db
        .updateTable("staff_totp")
        .set({
          failed_attempts: state.failedAttempts,
          first_failed_at: state.firstFailedAt,
          locked_until: state.lockedUntil,
        })
        .where("user_id", "=", userId)
        .execute();
    },

    /** La dueña suelta una cuenta bloqueada desde Equipo. */
    async unlock(userId: AuthId): Promise<void> {
      await db
        .updateTable("staff_totp")
        .set({ failed_attempts: 0, first_failed_at: null, locked_until: null })
        .where("user_id", "=", userId)
        .execute();
    },
  };
}

export type StaffTotpRepository = ReturnType<typeof staffTotpRepository>;

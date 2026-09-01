import type {
  AllowedUser,
  AllowedUserUpdate,
  NewAllowedUser,
  UserRole,
} from "../types";
import { toId, type Db } from "./shared";

/**
 * La allowlist. La consulta que importa es `findByEmail`: la corre `lib/dal.ts`
 * en cada verificación de sesión, y es la segunda de las dos compuertas de
 * Workspace.
 */
export function allowedUserRepository(db: Db) {
  return {
    /**
     * El correo se busca en minúsculas.
     *
     * La colación de la columna es `utf8mb4_0900_ai_ci`, así que MySQL ya
     * compara sin distinguir mayúsculas — pero la normalización se hace igual
     * acá, porque el que compara del otro lado (el claim del ID token contra la
     * fila) es JavaScript, y ahí `A@x.com !== a@x.com`.
     */
    async findByEmail(email: string): Promise<AllowedUser | undefined> {
      return db
        .selectFrom("allowed_user")
        .selectAll()
        .where("email", "=", email.trim().toLowerCase())
        .executeTakeFirst();
    },

    async findByEaProviderId(
      eaProviderId: number,
    ): Promise<AllowedUser | undefined> {
      return db
        .selectFrom("allowed_user")
        .selectAll()
        .where("ea_provider_id", "=", eaProviderId)
        .executeTakeFirst();
    },

    /** Para la pantalla de Equipo. Orden estable por rol y luego por correo. */
    async list(role?: UserRole): Promise<AllowedUser[]> {
      let q = db.selectFrom("allowed_user").selectAll();
      if (role) q = q.where("role", "=", role);
      return q.orderBy("role").orderBy("email").execute();
    },

    async insert(row: NewAllowedUser): Promise<number> {
      const result = await db
        .insertInto("allowed_user")
        .values({ ...row, email: row.email.trim().toLowerCase() })
        .executeTakeFirstOrThrow();
      return toId(result.insertId);
    },

    async update(id: number, patch: AllowedUserUpdate): Promise<void> {
      await db
        .updateTable("allowed_user")
        .set(patch)
        .where("id", "=", id)
        .execute();
    },

    /**
     * Quitar a alguien de la allowlist.
     *
     * Borra la fila y nada más: las sesiones vivas de esa persona son de Better
     * Auth y se revocan aparte, desde Equipo. Que sean dos actos distintos es a
     * propósito — sacar a alguien de la lista y echarlo de la sesión abierta
     * son dos decisiones, y a veces solo se quiere la primera.
     */
    async remove(id: number): Promise<void> {
      await db.deleteFrom("allowed_user").where("id", "=", id).execute();
    },
  };
}

export type AllowedUserRepository = ReturnType<typeof allowedUserRepository>;

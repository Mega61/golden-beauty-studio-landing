import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getDb } from "@/db/client";
import { allowedUserRepository } from "@/db/repositories";
import type { UserRole } from "@/db/types";
import { getAuth, LOGIN_PATH } from "./auth";
import type { Capability } from "./auth-policy";
import { can, findAllowedEntry, ownsProvider } from "./auth-policy";

/**
 * El Data Access Layer del panel.
 *
 * **Todo Server Component, toda Server Action y todo Route Handler empieza
 * acá.** No es una recomendación de estilo: es dónde vive la autorización.
 *
 * ## Por qué no en el proxy
 *
 * El chequeo del proxy de Next es un **redirect optimista** y nada más: manda al
 * login a quien no trae cookie, para que nadie vea parpadear una pantalla vacía.
 * Corre sobre rutas prefetcheadas, no puede pegarle a la base sin encarecer cada
 * navegación, y una request que no pasa por el router — una Server Action
 * invocada directo, un Route Handler — no lo cruza. Un panel cuya única
 * compuerta es el proxy está abierto.
 *
 * ## Por qué `cache()`
 *
 * Un árbol de Server Components llama `verifySession()` en cada nodo que
 * necesita saber quién es. Sin memoización eso son diez consultas a `session`
 * más diez a `allowed_user` por pintura de pantalla. `cache()` de React lo
 * resuelve una vez **por request**, no por proceso: dos personas concurrentes
 * no comparten resultado, y la sesión revocada hace un minuto no sobrevive a la
 * navegación siguiente.
 *
 * ## Por qué el rol se lee de `allowed_user` y no de la sesión
 *
 * La tabla `user` de Better Auth no guarda rol (ver la migración `001` de A2):
 * el rol vive en `allowed_user`, junto con el `ea_provider_id`. Leerlo en cada
 * verificación cuesta una consulta indexada y compra algo que una copia dentro
 * de la sesión no da: **quitar a alguien de la allowlist lo saca del panel en la
 * request siguiente**, sin esperar a que venza una sesión de treinta días.
 */

export type PanelSession = {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  /**
   * El puente hacia Easy!Appointments. Es lo que hace que una técnica vea su
   * agenda y su liquidación y no las de las demás. `null` en la recepción y en
   * la dueña, que no atienden en silla.
   */
  eaProviderId: number | null;
};

/**
 * `TICKET_STAFF_COBRA` — si la técnica registra el método de pago.
 *
 * Existe porque la respuesta cambia con la operación del estudio, no con el
 * código: en un estudio de dos personas la técnica cobra; con recepción de
 * planta, no. Se lee acá y se le pasa a `can()`, que sigue siendo pura.
 *
 * Ausente o cualquier cosa que no sea `"true"` es **no**. Un permiso se
 * concede; no se supone.
 */
function staffCobra(): boolean {
  return process.env.TICKET_STAFF_COBRA === "true";
}

/**
 * Quién está pidiendo, o `null`.
 *
 * Devuelve en vez de redirigir para que un Route Handler pueda contestar 401 y
 * una pantalla pueda decidir mostrar el login. `requireSession()` es el envoltorio
 * que redirige, y es el que usa casi todo.
 */
export const verifySession = cache(async (): Promise<PanelSession | null> => {
  const requestHeaders = await headers();

  // **Falla cerrada.** Si `gbs_admin` no responde, no hay forma de saber si esta
  // cookie corresponde a una sesión viva, y la respuesta segura a "no sé" es
  // que no. Un throw acá sería un 500 en cada pantalla, incluida la de entrada:
  // la dueña no podría ni llegar al login para diagnosticar. El error va al log
  // del servidor, que es donde alguien lo va a buscar.
  try {
    const result = await getAuth().api.getSession({ headers: requestHeaders });
    if (!result) return null;

    const allowlist = await allowedUserRepository(getDb()).list();
    const entry = findAllowedEntry(result.user.email, allowlist);
    // Sesión viva de alguien que ya no está autorizado. Pasa el día que la
    // dueña saca a alguien de Equipo: la fila desaparece y la sesión abierta
    // deja de valer en la request siguiente.
    if (entry === null) return null;

    return {
      userId: result.user.id,
      email: entry.email,
      name: result.user.name,
      role: entry.role,
      eaProviderId: entry.ea_provider_id,
    };
  } catch (error) {
    console.error("[dal] no se pudo verificar la sesión", error);
    return null;
  }
});

/**
 * La sesión, o al login.
 *
 * Es la primera línea de cada pantalla del panel y de cada Server Action que
 * escribe algo.
 */
export async function requireSession(): Promise<PanelSession> {
  const session = await verifySession();
  if (!session) redirect(LOGIN_PATH);
  return session;
}

/**
 * Error de autorización.
 *
 * Se distingue de un fallo cualquiera para que un Route Handler pueda mapearlo a
 * 403 y una pantalla pueda mostrar el vacío correcto en vez de una pantalla de
 * error genérica.
 */
export class ForbiddenError extends Error {
  readonly capability: Capability;

  constructor(capability: Capability) {
    super(`El rol de esta sesión no alcanza para "${capability}".`);
    this.name = "ForbiddenError";
    this.capability = capability;
  }
}

/**
 * La sesión **y** el permiso.
 *
 * Esto es lo que separa un permiso de un botón escondido. Esconder el botón es
 * cortesía con la usuaria; la Server Action que había detrás sigue existiendo y
 * se puede invocar sin él. Si la comprobación no está acá, no está.
 *
 * ```ts
 * export async function cerrarDia(fecha: string) {
 *   const session = await requireCapability("caja:cerrar-dia");
 *   …
 * }
 * ```
 */
export async function requireCapability(
  capability: Capability,
): Promise<PanelSession> {
  const session = await requireSession();
  if (!can(session.role, capability, { staffCobra: staffCobra() })) {
    throw new ForbiddenError(capability);
  }
  return session;
}

/**
 * ¿Esta sesión alcanza esta operación? Sin lanzar.
 *
 * Para decidir qué se dibuja. **No sustituye a `requireCapability()`** en la
 * acción que hay detrás: preguntar dos veces es el diseño, no una redundancia.
 */
export async function sessionCan(capability: Capability): Promise<boolean> {
  const session = await verifySession();
  if (!session) return false;
  return can(session.role, capability, { staffCobra: staffCobra() });
}

/**
 * La segunda mitad del alcance de una técnica: **cuál** cita, no solo qué
 * operación.
 *
 * `can()` dice que una `staff` puede cerrar una cuenta; esto dice que tiene que
 * ser la suya. Sin este chequeo, "cerrar la cuenta de su cita" y "cerrar la
 * cuenta de cualquiera" son el mismo permiso, y la diferencia entre los dos es
 * el `id` que venga en el formulario.
 *
 * `owner` y `admin` pasan siempre. Una `staff` sin `ea_provider_id` no alcanza
 * nada: es una fila a medio configurar en Equipo, y la respuesta segura ahí es
 * que no.
 */
export async function requireOwnProvider(
  targetEaProviderId: number | null,
): Promise<PanelSession> {
  const session = await requireSession();
  if (!ownsProvider(session.role, session.eaProviderId, targetEaProviderId)) {
    throw new ForbiddenError("cuenta:cerrar-ajena");
  }
  return session;
}

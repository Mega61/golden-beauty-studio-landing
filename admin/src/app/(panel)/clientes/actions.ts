"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { auditLogRepository } from "@/db/repositories";
import { EaApiError } from "@/lib/ea";
import { createEaClient } from "@/lib/ea/client";
import { ForbiddenError, requireCapability } from "@/lib/dal";

import { splitName } from "@/jobs/import-agendapro";

import { normalizePhoneE164 } from "./identity";
import { describeMerge, planMerge } from "./merge";

/**
 * Las escrituras de la pantalla de Clientas.
 *
 * Hasta acá el módulo era de solo lectura, y eso obligaba a entrar a la
 * interfaz de EA para corregir un teléfono mal digitado o dar de alta a una
 * clienta que entró caminando — que es justamente lo que el panel existe para
 * no tener que hacer.
 *
 * ## El teléfono se normaliza en el servidor, siempre
 *
 * La pantalla puede mandar `"300 123 4567"`. Lo que llega a EA es
 * `"+573001234567"`, porque **la identidad de la clienta es el teléfono
 * normalizado** y guardar variantes es cómo se fabrican duplicados que después
 * hay que fusionar. Un número que no se puede normalizar se rechaza: un número
 * a medias deduplica mal, que es peor que no deduplicar.
 *
 * ## Las tres escrituras van a EA, no a `gbs_admin`
 *
 * La clienta vive en EA: es quien manda sobre las citas y quien sincroniza con
 * Google. `gbs_admin` solo guarda la bitácora de quién tocó qué.
 */

export type ClientActionResult = {
  ok: boolean;
  message: string;
  /**
   * La clienta recién creada, solo en el alta y solo cuando salió bien.
   *
   * Existe porque el formulario de **cita** crea clientas sin salir de la
   * pantalla: sin el id habría que buscarla de nuevo justo después de crearla,
   * y esa segunda búsqueda puede no encontrarla —la de EA es por texto y el
   * nombre recién escrito puede estar mal tipeado— dejando a alguien con la
   * clienta creada y la cita sin poder armarse.
   */
  customer?: { id: number; name: string };
};

const MAX_NAME = 120;

const ClientSchema = z.object({
  firstName: z.string().trim().min(1, "Falta el nombre").max(MAX_NAME),
  /**
   * Puede llegar vacío y **no puede viajar vacío a EA**: su API exige
   * `last_name` y responde **500** sin él, con el cuerpo `"Not all required
   * fields are provided"`. Un 500 se clasifica como error transitorio, así que
   * el panel decía "la agenda no respondió" sobre algo que no se arreglaba
   * reintentando nunca. Ver `toEaPayload()`.
   */
  lastName: z.string().trim().max(MAX_NAME),
  phone: z.string().trim().min(1, "Falta el teléfono"),
  email: z.string().trim().max(200),
  notes: z.string().trim().max(2000),
});

export type ClientInput = z.input<typeof ClientSchema>;

/**
 * El fallo de una escritura, dicho para quien está con la clienta enfrente.
 *
 * ⚠ **Un 500 de EA no siempre es "reintenta".** `isTransient` agrupa red,
 * timeout y `server`, y EA responde **500 a un payload que rechaza** — por
 * ejemplo sin `last_name`, con el cuerpo `"Not all required fields are
 * provided"`. Decirle a alguien "la agenda no respondió" sobre eso lo manda a
 * reintentar un error que no se arregla nunca reintentando, y esconde la
 * causa. Cuando el cuerpo delata un rechazo, se dice que es un rechazo.
 *
 * Y siempre se registra en el log del servidor: esta función traga el error
 * original para dar un mensaje legible, y sin el `console.error` la causa se
 * pierde entera — que fue exactamente lo que costó encontrar este bug.
 */
function describeEaFailure(error: unknown, fallback: string): string {
  console.error("[clientes] la escritura a la agenda falló", error);

  if (error instanceof EaApiError) {
    if (error.isConfiguration) {
      return "El panel no puede autenticarse contra la agenda. Es configuración, no un caído.";
    }

    // EA usa 500 para "no me diste un campo obligatorio". Reintentarlo no
    // cambia nada; lo que hace falta es el dato.
    if (/required fields|not all required/i.test(error.message)) {
      return `La agenda rechazó los datos: ${error.message.slice(0, 200)}`;
    }

    if (error.isTransient) {
      return "La agenda no respondió. Se puede reintentar en un momento.";
    }
    return `${fallback} La agenda respondió: ${error.message}`;
  }
  return fallback;
}

/**
 * Los campos que viajan a EA, con el teléfono ya normalizado.
 *
 * El correo vacío viaja como `null` y **no** como `""`: EA deduplica por correo
 * y una cadena vacía repetida en veinte clientas es una colisión esperando.
 * Campo vacío es más honesto que campo inventado — la misma regla de
 * `identity.ts`.
 */
/**
 * Los campos que viajan a EA, con el teléfono normalizado y el nombre partido.
 *
 * Devuelve el motivo en vez del payload cuando algo no puede viajar, para que
 * el mensaje lo dé quien tiene el contexto y no un `null` mudo.
 *
 * ## El apellido es obligatorio, y lo impone EA
 *
 * Su API responde **500** con `last_name` nulo o vacío —`"Not all required
 * fields are provided"`— y acepta `" "`, un espacio. Mandar ese espacio sería
 * inventar un apellido que después aparece en la ficha y en la confirmación de
 * la cita como un nombre con una cola rara. Se pide de frente: en el mostrador
 * se pregunta el nombre completo igual.
 *
 * ## El correo vacío viaja como `null`, no como `""`
 *
 * EA deduplica por correo, y una cadena vacía repetida en veinte clientas es
 * una colisión esperando. Campo vacío es más honesto que campo inventado.
 */
function toEaPayload(
  data: z.output<typeof ClientSchema>,
): { payload: EaCustomerPayload } | { error: string } {
  const phone = normalizePhoneE164(data.phone);
  if (phone === null) {
    return {
      error:
        "Ese teléfono no se puede usar como identidad. Tiene que ser un número real: " +
        "un celular de diez dígitos, o un fijo con indicativo.",
    };
  }

  // Quien escribe "Ana Ríos" en un solo campo está dando nombre y apellido, y
  // guardarlo entero como nombre de pila deja la ficha mal partida para
  // siempre. Se separa en el primer espacio: "Ana María Ríos" queda "Ana" +
  // "María Ríos" — imperfecto, y conserva el nombre completo, que es lo que la
  // clienta lee en su confirmación.
  const { firstName, lastName } = splitName(data.firstName, data.lastName);

  if (firstName === "") return { error: "Falta el nombre." };
  if (lastName === "") {
    return {
      error: `Falta el apellido de ${firstName}. La agenda lo exige para poder guardar la ficha.`,
    };
  }

  return {
    payload: {
      firstName,
      lastName,
      phone,
      email: data.email === "" ? null : data.email,
      notes: data.notes === "" ? null : data.notes,
    },
  };
}

type EaCustomerPayload = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  notes: string | null;
};

export async function crearClienta(input: ClientInput): Promise<ClientActionResult> {
  let session;
  try {
    session = await requireCapability("clientes:editar");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) return { ok: false, message: "Tu rol no puede crear clientas." };
    return { ok: false, message: "No se pudo verificar la sesión." };
  }

  const parsed = ClientSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Faltan datos." };
  }

  const built = toEaPayload(parsed.data);
  if ("error" in built) return { ok: false, message: built.error };
  const { payload } = built;

  try {
    const ea = createEaClient();

    // Antes de crear se busca por teléfono. EA **no** deduplica por número —lo
    // hace por correo— así que sin este chequeo dos altas con el mismo número
    // crean dos clientas, y la que llama aparece dos veces en la agenda.
    const existing = await ea.customers.list({});
    const duplicate = existing.find(
      (customer) => normalizePhoneE164(customer.phone) === payload.phone,
    );

    if (duplicate) {
      return {
        ok: false,
        message:
          `Ese número ya es de ${[duplicate.firstName, duplicate.lastName].filter(Boolean).join(" ") || `#${duplicate.id}`}. ` +
          "Si son la misma persona, edítala; si no, hay que confirmar el número.",
      };
    }

    const created = await ea.customers.create(payload);

    await auditLogRepository(getDb()).append({
      actorUserId: session.userId,
      action: "clienta.crear",
      entity: "ea_customer",
      entityId: String(created.id),
      after: payload,
      at: new Date(),
    });

    revalidatePath("/clientes");
    return {
      ok: true,
      message: `${[payload.firstName, payload.lastName].filter(Boolean).join(" ")} quedó creada.`,
      customer: {
        id: created.id,
        name: [payload.firstName, payload.lastName].filter(Boolean).join(" "),
      },
    };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: describeEaFailure(error, "No se pudo crear la clienta.") };
  }
}

/**
 * Corregir una clienta.
 *
 * ⚠ **Edita una fila de EA, no "la clienta" de la ficha.** Una ficha puede venir
 * de tres filas (ver `identity.ts`), y editar una sola dejaría las otras dos con
 * el dato viejo — que es exactamente cómo se pierde una corrección. Por eso la
 * pantalla ofrece editar cuando hay una sola fila, y **fusionar** cuando hay
 * más: primero se unen, después se corrige.
 */
export async function editarClienta(
  eaCustomerId: number,
  input: ClientInput,
): Promise<ClientActionResult> {
  let session;
  try {
    session = await requireCapability("clientes:editar");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) return { ok: false, message: "Tu rol no puede editar clientas." };
    return { ok: false, message: "No se pudo verificar la sesión." };
  }

  if (!Number.isSafeInteger(eaCustomerId) || eaCustomerId <= 0) {
    return { ok: false, message: "El id de la clienta llegó mal." };
  }

  const parsed = ClientSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Faltan datos." };
  }

  const built = toEaPayload(parsed.data);
  if ("error" in built) return { ok: false, message: built.error };
  const { payload } = built;

  try {
    const ea = createEaClient();
    const before = await ea.customers.get(eaCustomerId);

    // Cambiarle el número a una clienta para dárselo a otra que ya lo tiene
    // fabrica el duplicado que la fusión después tiene que deshacer.
    if (normalizePhoneE164(before.phone) !== payload.phone) {
      const existing = await ea.customers.list({});
      const clash = existing.find(
        (customer) =>
          customer.id !== eaCustomerId && normalizePhoneE164(customer.phone) === payload.phone,
      );
      if (clash) {
        return {
          ok: false,
          message: `Ese número ya es de #${clash.id}. Si son la misma persona, fusiónalas.`,
        };
      }
    }

    await ea.customers.update(eaCustomerId, payload);

    await auditLogRepository(getDb()).append({
      actorUserId: session.userId,
      action: "clienta.editar",
      entity: "ea_customer",
      entityId: String(eaCustomerId),
      before: {
        firstName: before.firstName,
        lastName: before.lastName,
        phone: before.phone,
        email: before.email,
        notes: before.notes,
      },
      after: payload,
      at: new Date(),
    });

    revalidatePath("/clientes");
    return { ok: true, message: "Quedó corregida." };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, message: describeEaFailure(error, "No se pudo corregir la clienta.") };
  }
}

/**
 * Unir en una sola las filas de EA que son la misma clienta.
 *
 * Es la operación más destructiva del panel —borra filas de EA— y por eso es de
 * la dueña. El orden es el de `merge.ts` y no es negociable:
 *
 * 1. copiarle a la superviviente lo que solo tenían las perdedoras,
 * 2. mover las citas,
 * 3. **verificar** que se movieron,
 * 4. recién ahí borrar.
 *
 * Si algo falla antes del paso 4, no se borra nada y la clienta queda como
 * estaba. Ninguna secuencia de fallas pierde una cita, que es la única
 * propiedad que importa acá.
 */
export async function fusionarClienta(
  eaCustomerIds: number[],
): Promise<ClientActionResult> {
  let session;
  try {
    session = await requireCapability("clientes:fusionar");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Solo la dueña puede fusionar clientas: borra filas de la agenda." };
    }
    return { ok: false, message: "No se pudo verificar la sesión." };
  }

  const ids = [...new Set(eaCustomerIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length < 2) {
    return { ok: false, message: "Hacen falta al menos dos filas para fusionar." };
  }

  try {
    const ea = createEaClient();
    const customers = await Promise.all(ids.map((id) => ea.customers.get(id)));

    const plan = planMerge(customers);
    if ("blocker" in plan) {
      return { ok: false, message: "No hay nada que fusionar." };
    }

    // 1. Enriquecer primero. Si esto falla, no se movió ni se borró nada.
    if (Object.keys(plan.enrich).length > 0) {
      await ea.customers.update(plan.survivor.id, plan.enrich);
    }

    // 2. Mover las citas, de a una perdedora.
    let moved = 0;
    for (const loser of plan.losers) {
      const appointments = await ea.appointments.list({ customerId: loser.id });

      for (const appointment of appointments) {
        await ea.appointments.update(appointment.id, { customerId: plan.survivor.id });
        moved += 1;
      }

      // 3. Verificar **antes de borrar esta perdedora**, no al final: borrar
      // una fila cuyas citas no se movieron las borraría con ella. La consulta
      // se repite a propósito en vez de confiar en el 200 del PUT.
      const remaining = await ea.appointments.list({ customerId: loser.id });
      if (remaining.length > 0) {
        return {
          ok: false,
          message:
            `Se movieron ${moved} cita(s), pero a #${loser.id} le quedan ${remaining.length}. ` +
            "No se borró ninguna fila. Volver a intentar.",
        };
      }
    }

    // 4. Borrar. Cada una por separado: si la tercera falla, las dos primeras
    // ya están hechas y volver a correr la fusión termina el trabajo.
    const deleted: number[] = [];
    for (const loser of plan.losers) {
      await ea.customers.remove(loser.id);
      deleted.push(loser.id);
    }

    await auditLogRepository(getDb()).append({
      actorUserId: session.userId,
      action: "clienta.fusionar",
      entity: "ea_customer",
      entityId: String(plan.survivor.id),
      before: { deleted, enrich: plan.enrich },
      after: { survivor: plan.survivor.id, movedAppointments: moved },
      at: new Date(),
    });

    revalidatePath("/clientes");
    return {
      ok: true,
      message: `Fusionadas. ${describeMerge(plan)} Se movieron ${moved} cita(s).`,
    };
  } catch (error) {
    unstable_rethrow(error);
    return {
      ok: false,
      message: describeEaFailure(
        error,
        "No se pudo fusionar. Si quedó a medias, volver a intentarlo termina el trabajo: " +
          "el orden garantiza que ninguna cita se pierde.",
      ),
    };
  }
}

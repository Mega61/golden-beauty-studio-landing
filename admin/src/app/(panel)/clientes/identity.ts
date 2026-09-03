/**
 * La identidad de la clienta es el **teléfono normalizado a E.164**.
 *
 * No el correo. EA deduplica por correo —`Customers_model::exists()` y
 * `find_record_id()` lanzan si el email viene vacío— y muchas clientas del
 * estudio no tienen correo, o dan el del esposo. El flujo viejo resolvía eso
 * inventando direcciones, y ése es justamente el error que este módulo existe
 * para no repetir: **un correo falso viaja como *attendee* del evento de
 * Google, rebota, y ensucia la ficha para siempre.** Campo vacío es más
 * honesto que campo inventado.
 *
 * De ahí las tres cosas que hace este archivo, todas puras y todas testeadas:
 *
 * 1. **Normalizar** cualquier cosa que alguien haya escrito en la casilla de
 *    teléfono a un E.164, o devolver `null` — nunca un número a medias, porque
 *    un número a medias deduplica mal, que es peor que no deduplicar.
 * 2. **Agrupar** las filas de EA que comparten teléfono en una sola clienta
 *    (`mergeCustomers`). EA no lo hace y no lo va a hacer; el panel lo hace al
 *    leer, sin tocar sus tablas.
 * 3. **Marcar** los correos que huelen a relleno, en vez de borrarlos. Lo que
 *    se esconde no se limpia nunca.
 */

import type { Customer } from "@/lib/ea";

// ---------------------------------------------------------------------------
// E.164
// ---------------------------------------------------------------------------

declare const e164Brand: unique symbol;

/**
 * `"+573001234567"`. Marcado como tipo aparte por la misma razón que
 * `EaLocalDateTime` en A1: sin la marca, pasar el número tal cual lo escribió
 * la recepción donde va la llave de deduplicación compila sin chistar.
 */
export type E164 = string & { readonly [e164Brand]: "e164" };

/** Indicativo por defecto cuando el número viene sin él. */
export const DEFAULT_COUNTRY_CODE = "57";

/**
 * Largo del número nacional colombiano: diez dígitos, celular (`3…`) o fijo
 * con el indicativo de diez cifras (`60…`).
 */
const CO_NSN_LENGTH = 10;

/** E.164 admite entre 8 y 15 dígitos contando el indicativo. */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

/**
 * Cualquier cosa → E.164, o `null`.
 *
 * `null` no es un caso raro: es lo que devuelve para `""`, `"N/A"`,
 * `"sin teléfono"`, un interno de cuatro cifras o un número con letras. Todos
 * esos existen en un export viejo de agenda, y ninguno puede servir de llave.
 *
 * Lo que sí acepta, porque es lo que la gente escribe:
 *
 * | Entrada | Salida |
 * | --- | --- |
 * | `"3001234567"` | `"+573001234567"` |
 * | `"300 123 4567"` | `"+573001234567"` |
 * | `"(601) 234 5678"` | `"+576012345678"` |
 * | `"+57 300 123 4567"` | `"+573001234567"` |
 * | `"57 300 123 4567"` | `"+573001234567"` |
 * | `"0057 3001234567"` | `"+573001234567"` |
 * | `"+1 305 555 0123"` | `"+13055550123"` |
 *
 * **El `+` explícito manda.** Si alguien escribió `+1…`, se respeta: agregarle
 * `57` a un número de Miami sería inventar un dato, y este módulo existe
 * precisamente para no inventar datos.
 */
export function normalizePhoneE164(
  raw: string | null | undefined,
  defaultCountryCode: string = DEFAULT_COUNTRY_CODE,
): E164 | null {
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // Una letra en el medio no es un número mal escrito: es otra cosa
  // ("ext. 210", "no tiene", "casa"). Se descarta entero en vez de quedarse
  // con los dígitos que sobrevivan, que producirían una llave falsa.
  if (/\p{L}/u.test(trimmed)) return null;

  let digits = trimmed.replace(/\D/g, "");
  if (digits === "") return null;

  // Prefijo internacional a la vieja usanza: `00` no es parte del número, pero
  // sí es una declaración de que lo que sigue trae indicativo.
  const oldStyleIntl = !trimmed.startsWith("+") && digits.startsWith("00");
  if (oldStyleIntl) digits = digits.slice(2);
  const international = trimmed.startsWith("+") || oldStyleIntl;

  if (!international) {
    // El `0` de larga distancia de antes. No es parte del número, pero tampoco
    // se puede quitar sin adivinar cuánto de lo que sigue es prefijo de
    // operador (`03`, `05`, `09`…). Se rechaza y se pide el número bien.
    if (digits.startsWith("0")) return null;

    // **Sin `+` la tolerancia es corta a propósito.** Un número nacional tiene
    // diez dígitos; nueve u once es un dedazo, y un dedazo aceptado se
    // convierte en una llave de identidad que fusiona o separa personas mal.
    // Rechazar acá es lo que hace que "la ficha está incompleta" sea visible en
    // vez de "la ficha es de otra".
    if (digits.length === CO_NSN_LENGTH) {
      digits = `${defaultCountryCode}${digits}`;
    } else if (
      !(
        digits.length === defaultCountryCode.length + CO_NSN_LENGTH &&
        digits.startsWith(defaultCountryCode)
      )
    ) {
      return null;
    }
  }

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  // Ningún indicativo de país empieza en cero.
  if (digits.startsWith("0")) return null;

  return `+${digits}` as E164;
}

/** ¿Esta cadena ya es un E.164? Para los datos que vienen de `gbs_admin`. */
export function isE164(value: unknown): value is E164 {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value);
}

// ---------------------------------------------------------------------------
// La llave de la ficha
// ---------------------------------------------------------------------------

/**
 * Cómo se identifica una clienta en una URL.
 *
 * Hay dos casos y conviene que la URL los distinga, porque significan cosas
 * distintas: `tel` es una **persona** (puede tener varias filas en EA), `ea` es
 * una fila suelta que **no se pudo deduplicar** porque no tiene teléfono. Esa
 * segunda es una ficha degradada a propósito — y verla degradada es la señal de
 * que a esa clienta le falta el dato que la vuelve una persona.
 */
export type ClientKey =
  | { kind: "tel"; phone: E164 }
  | { kind: "ea"; eaCustomerId: number };

/**
 * La llave como segmento de URL: `57300123456` o `ea-482`.
 *
 * Sin el `+`: en un path se codifica como `%2B`, y la mitad de las herramientas
 * lo vuelve a decodificar como espacio. Los dígitos pelados no tienen esa clase
 * de problema.
 */
export function clientKeyToParam(key: ClientKey): string {
  return key.kind === "tel" ? key.phone.slice(1) : `ea-${key.eaCustomerId}`;
}

/** El camino de vuelta. `null` si el segmento no es ninguna de las dos formas. */
export function parseClientKeyParam(param: string): ClientKey | null {
  const ea = /^ea-(\d{1,10})$/.exec(param);
  if (ea) {
    const id = Number(ea[1]);
    return Number.isSafeInteger(id) && id > 0
      ? { kind: "ea", eaCustomerId: id }
      : null;
  }
  if (!/^\d{8,15}$/.test(param)) return null;
  const phone = `+${param}`;
  return isE164(phone) ? { kind: "tel", phone } : null;
}

export function sameClientKey(a: ClientKey, b: ClientKey): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "tel" && b.kind === "tel"
    ? a.phone === b.phone
    : clientKeyToParam(a) === clientKeyToParam(b);
}

/**
 * Las formas en que ese mismo número puede estar escrito en EA.
 *
 * Hace falta porque **la búsqueda de EA es un `LIKE %q%` sobre el texto crudo**:
 * buscar `3001234567` no encuentra a quien quedó guardada como
 * `300 123 4567`. El panel normaliza al leer, pero para poder normalizar
 * primero tiene que traer la fila, y para traerla hay que preguntar como está
 * escrita.
 *
 * Son consultas, no verdades: lo que decide si dos filas son la misma clienta
 * sigue siendo `normalizePhoneE164`, después de traerlas.
 */
export function phoneSearchVariants(phone: E164): string[] {
  const digits = phone.slice(1);
  const variants = new Set<string>([phone, digits]);

  const national =
    digits.startsWith(DEFAULT_COUNTRY_CODE) &&
    digits.length === DEFAULT_COUNTRY_CODE.length + CO_NSN_LENGTH
      ? digits.slice(DEFAULT_COUNTRY_CODE.length)
      : null;

  if (national !== null) {
    const a = national.slice(0, 3);
    const b = national.slice(3, 6);
    const c = national.slice(6);
    variants.add(national);
    variants.add(`${a} ${b} ${c}`);
    variants.add(`${a}-${b}-${c}`);
    variants.add(`${a} ${b}${c}`);
  }

  return [...variants];
}

// ---------------------------------------------------------------------------
// Correos de relleno
// ---------------------------------------------------------------------------

/**
 * Dominios que delatan un correo inventado para pasar la validación de otro
 * sistema.
 *
 * La lista es corta y concreta a propósito: una heurística agresiva marcaría
 * como falso el correo real de alguien, y el costo de eso —dejar de escribirle
 * a una clienta— es peor que el de no marcar uno falso.
 */
const FILLER_DOMAINS = new Set([
  "example.com",
  "example.org",
  "test.com",
  "noemail.com",
  "no-email.com",
  "sincorreo.com",
  "localhost",
  "invalid",
  "none.com",
]);

const FILLER_LOCALPARTS =
  /^(no-?reply|noemail|no-?email|sin-?correo|nomail|null|na|n-?a|test|default)$/i;

/**
 * ¿Este correo parece inventado?
 *
 * Se **marca**, no se borra. La ficha lo muestra con un aviso para que alguien
 * lo corrija en EA; borrarlo en silencio dejaría a la clienta con el campo
 * vacío y a nadie enterado de que ahí había basura.
 *
 * También cuenta como relleno el correo cuya parte local es el teléfono
 * (`3001234567@algo.com`), que es la forma exacta que producía el flujo viejo.
 */
export function looksFabricatedEmail(email: string | null | undefined): boolean {
  if (typeof email !== "string") return false;
  const value = email.trim().toLowerCase();
  if (value === "") return false;

  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return true; // ni siquiera es un correo

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);

  if (FILLER_DOMAINS.has(domain)) return true;
  if (
    domain.endsWith(".invalid") ||
    domain.endsWith(".local") ||
    domain.endsWith(".test")
  ) {
    return true;
  }
  if (FILLER_LOCALPARTS.test(local)) return true;
  // El teléfono usado como parte local: diez dígitos o más y nada más.
  if (/^\+?\d{10,}$/.test(local)) return true;

  return false;
}

/** El correo que se puede mostrar y usar, o `null`. Nunca inventa uno. */
export function usableEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const value = email.trim();
  if (value === "") return null;
  return looksFabricatedEmail(value) ? null : value;
}

// ---------------------------------------------------------------------------
// Fusión: N filas de EA → una clienta
// ---------------------------------------------------------------------------

/**
 * Una clienta, ya resuelta.
 *
 * `eaCustomerIds` en plural no es un detalle de implementación: es el dato que
 * hace que la historia se pueda armar. Dos filas en EA con el mismo teléfono
 * tienen citas repartidas entre las dos, y la ficha las tiene que pedir todas.
 */
export type ResolvedClient = {
  key: ClientKey;
  /** `null` cuando la fila de EA no tiene teléfono utilizable. */
  phone: E164 | null;
  name: string;
  /** El correo que se puede usar. `null` si no hay o si parece inventado. */
  email: string | null;
  /** Correos que se descartaron por parecer relleno. Se muestran, con aviso. */
  suspiciousEmails: string[];
  /** Todas las filas de EA que resultaron ser esta persona, en orden de id. */
  eaCustomerIds: number[];
  notes: string | null;
  /**
   * `true` cuando la ficha viene de más de una fila de EA. Es lo que la
   * pantalla usa para decir "esta clienta está duplicada en la agenda".
   */
  merged: boolean;
};

/** Nombre visible de una fila de EA, sin inventar nada. */
export function displayName(customer: Pick<Customer, "firstName" | "lastName">): string {
  return [customer.firstName, customer.lastName]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part !== "")
    .join(" ");
}

/** Cuánta información trae un nombre. Decide cuál gana en la fusión. */
function nameScore(customer: Customer): number {
  const first = (customer.firstName ?? "").trim();
  const last = (customer.lastName ?? "").trim();
  return (first === "" ? 0 : 2) + (last === "" ? 0 : 1);
}

/**
 * **El caso que importa: dos clientas con el mismo teléfono se resuelven a una.**
 *
 * Agrupa por teléfono normalizado. Las filas sin teléfono utilizable **no se
 * agrupan entre sí** — quedan cada una por su lado, con llave `ea`. Agruparlas
 * por nombre sería la tentación obvia y es exactamente lo que no hay que hacer:
 * dos "María González" distintas se volverían una sola clienta con la historia
 * de las dos, y ese error no se ve nunca porque la ficha resultante se ve bien.
 *
 * Reglas de fusión, todas deterministas:
 *
 * - **Nombre:** gana el más completo (nombre + apellido antes que solo nombre);
 *   a igual completitud, gana el de la fila de id **mayor**, que es la más
 *   reciente y la que más probablemente refleja cómo se llama hoy.
 * - **Correo:** el primero utilizable en orden de id. Los que parecen relleno no
 *   ascienden nunca a correo principal, pero se conservan en
 *   `suspiciousEmails` para que alguien los limpie en EA.
 * - **Notas:** se concatenan las distintas, en orden de id. Perder una nota al
 *   fusionar sería borrar información de la clienta desde una pantalla de solo
 *   lectura.
 *
 * El orden de salida es el de la primera aparición, así una lista de resultados
 * de búsqueda no se reordena sola.
 */
export function mergeCustomers(customers: readonly Customer[]): ResolvedClient[] {
  const byPhone = new Map<string, Customer[]>();
  const order: Array<
    { kind: "tel"; phone: E164 } | { kind: "ea"; customer: Customer }
  > = [];

  for (const customer of customers) {
    const phone = normalizePhoneE164(customer.phone);
    if (phone === null) {
      order.push({ kind: "ea", customer });
      continue;
    }
    const bucket = byPhone.get(phone);
    if (bucket) {
      bucket.push(customer);
    } else {
      byPhone.set(phone, [customer]);
      order.push({ kind: "tel", phone });
    }
  }

  return order.map((entry) =>
    entry.kind === "tel"
      ? fuse(entry.phone, byPhone.get(entry.phone) ?? [])
      : fuse(null, [entry.customer]),
  );
}

function fuse(phone: E164 | null, rows: readonly Customer[]): ResolvedClient {
  const sorted = [...rows].sort((a, b) => a.id - b.id);

  const best = sorted.reduce((winner, candidate) => {
    const diff = nameScore(candidate) - nameScore(winner);
    if (diff > 0) return candidate;
    if (diff < 0) return winner;
    // Empate: la fila más reciente. `sorted` es ascendente, así que la última
    // que empata es la de id mayor.
    return candidate.id > winner.id ? candidate : winner;
  }, sorted[0]);

  const emails: string[] = [];
  const suspicious: string[] = [];
  for (const row of sorted) {
    const raw = typeof row.email === "string" ? row.email.trim() : "";
    if (raw === "") continue;
    if (looksFabricatedEmail(raw)) {
      if (!suspicious.includes(raw)) suspicious.push(raw);
    } else if (!emails.includes(raw)) {
      emails.push(raw);
    }
  }

  const notes = sorted
    .map((row) => (typeof row.notes === "string" ? row.notes.trim() : ""))
    .filter((note, index, all) => note !== "" && all.indexOf(note) === index);

  return {
    key:
      phone === null
        ? { kind: "ea", eaCustomerId: best.id }
        : { kind: "tel", phone },
    phone,
    name: displayName(best),
    email: emails[0] ?? null,
    suspiciousEmails: suspicious,
    eaCustomerIds: sorted.map((row) => row.id),
    notes: notes.length === 0 ? null : notes.join(" · "),
    merged: sorted.length > 1,
  };
}

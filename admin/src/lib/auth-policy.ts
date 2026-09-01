/**
 * Las decisiones de autenticación y autorización del panel, como funciones
 * puras.
 *
 * **Por qué están acá y no adentro de `auth.ts` o de un componente.** Son las
 * dos preguntas que, contestadas mal, abren el panel: "¿esta identidad de
 * Google puede entrar?" y "¿este rol alcanza esta operación?". Una función pura
 * con el reloj y la allowlist inyectados se testea entera, incluidos los
 * caminos negativos, que son los que importan. Metidas en la configuración de
 * Better Auth o en un `if` de una pantalla, solo se pueden verificar a mano y
 * una sola vez.
 *
 * Nada de este archivo toca la red, la base ni `process.env`. Los valores que
 * dependen del entorno (`GOOGLE_WORKSPACE_DOMAIN`, `TICKET_STAFF_COBRA`) entran
 * como parámetro; leerlos acá haría que el resultado dependiera del proceso y
 * un test verde en local no diría nada del contenedor.
 */

import type { UserRole } from "@/db/types";

// ── Compuerta de Workspace ──────────────────────────────────────────────────

/**
 * Los claims del ID token de Google que nos importan.
 *
 * Están tipados como `unknown` a propósito. Vienen de un JSON de afuera, y la
 * diferencia entre `email_verified: false` y `email_verified: "false"` (que en
 * JavaScript es *verdadero*) es exactamente la clase de detalle que abre una
 * puerta. Acá se estrechan con comparaciones explícitas, no con coerción.
 *
 * Es un subconjunto de `GoogleProfile` de Better Auth: `email`, `email_verified`
 * y `hd`. No se declara como ese tipo porque el gate tiene que poder recibir un
 * objeto incompleto — un token sin `hd` es precisamente el caso que rechaza.
 */
export type WorkspaceClaims = {
  email?: unknown;
  email_verified?: unknown;
  hd?: unknown;
};

/**
 * Una fila de `allowed_user`, reducida a lo que la decisión necesita.
 *
 * Se acepta la forma de la tabla (`ea_provider_id` en snake_case) para que el
 * repositorio de A2 se pueda pasar tal cual, sin un mapeo intermedio que sería
 * un lugar más donde equivocarse.
 */
export type AllowedIdentity = {
  email: string;
  role: UserRole;
  ea_provider_id: number | null;
};

/**
 * Por qué se rechazó. Se distingue en el código y **no** en la pantalla: a
 * quien no puede entrar se le dice "esta cuenta no tiene acceso al panel" y
 * nada más. El motivo va al log del servidor, donde sirve para depurar sin
 * decirle a un desconocido si su correo está o no en la lista.
 */
export type IdentityRejection =
  /** El token no trae correo. */
  | "sin_email"
  /** El claim `hd` falta o no es el dominio de Workspace del estudio. */
  | "dominio"
  /** Google no da el correo por verificado. */
  | "email_sin_verificar"
  /** Identidad legítima de Workspace, pero nadie la autorizó. */
  | "fuera_de_allowlist";

export type IdentityDecision =
  | { ok: true; email: string; role: UserRole; eaProviderId: number | null }
  | { ok: false; reason: IdentityRejection };

/**
 * Normaliza un correo venido de un claim.
 *
 * Minúsculas y sin espacios porque la comparación contra `allowed_user` la hace
 * JavaScript, no MySQL: la colación `_ci` de la columna no ayuda cuando los dos
 * lados ya están en memoria. Devuelve `null` si no es una cadena con forma de
 * correo — un `email: 123` o un `email: ""` no pueden convertirse en una
 * identidad por accidente.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  // Suficiente para descartar basura; la validación real la hizo Google al
  // emitir el token. Lo que se busca acá es que no pase una cadena vacía ni
  // algo sin arroba que después coincida con una fila mal cargada.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/**
 * Las **dos compuertas** de Workspace, sobre el claim firmado.
 *
 * 1. `hd` igual al dominio de Workspace del estudio.
 * 2. `email_verified === true`, estrictamente.
 *
 * Pasar `hd` como parámetro de la request de autorización es para UX — hace que
 * Google preseleccione la cuenta del dominio. **No es una compuerta**: cualquiera
 * puede pedir el mismo endpoint sin ese parámetro. La compuerta es el claim que
 * viene dentro del ID token que Google emitió y firmó, y es el que se compara
 * acá.
 *
 * El dominio también se normaliza: `GOOGLE_WORKSPACE_DOMAIN` lo escribe una
 * persona en un `.env`, y `Estudio.com` contra `estudio.com` sería un rechazo
 * silencioso imposible de diagnosticar.
 */
export function checkWorkspaceClaims(
  claims: WorkspaceClaims,
  workspaceDomain: string,
): { ok: true; email: string } | { ok: false; reason: IdentityRejection } {
  const email = normalizeEmail(claims.email);
  if (email === null) return { ok: false, reason: "sin_email" };

  const domain = workspaceDomain.trim().toLowerCase();
  const hd = typeof claims.hd === "string" ? claims.hd.trim().toLowerCase() : null;
  // Un dominio vacío en el entorno no puede volverse "acepta cualquier cosa":
  // sin dominio configurado no hay compuerta, y sin compuerta no se entra.
  if (domain === "" || hd === null || hd !== domain) {
    return { ok: false, reason: "dominio" };
  }

  // `=== true` y no una verdad blanda: la cadena `"false"` es verdadera en
  // JavaScript, y ese es justo el valor que un proveedor mal parseado manda.
  if (claims.email_verified !== true) {
    return { ok: false, reason: "email_sin_verificar" };
  }

  return { ok: true, email };
}

/**
 * Busca un correo en la allowlist. Devuelve `null` si no está.
 *
 * Es la **tercera** compuerta, y la única que aplica a las técnicas: entran por
 * TOTP con correo personal, así que las dos compuertas de Workspace no las
 * tocan, pero la fila de `allowed_user` sigue siendo lo que dice quiénes son y
 * qué alcanzan. Nadie entra al panel sin una fila que la dueña haya creado.
 */
export function findAllowedEntry(
  email: unknown,
  allowlist: readonly AllowedIdentity[],
): AllowedIdentity | null {
  const needle = normalizeEmail(email);
  if (needle === null) return null;
  return (
    allowlist.find((entry) => entry.email.trim().toLowerCase() === needle) ?? null
  );
}

/**
 * La decisión completa de entrada por Workspace: las dos compuertas del token
 * **y** la allowlist.
 *
 * Las tres son obligatorias y en este orden. Que el correo esté en
 * `allowed_user` no salva a una cuenta de fuera del dominio: la fila de la
 * allowlist dice qué rol tiene alguien, no de qué proveedor de identidad puede
 * venir.
 *
 * La allowlist se recibe completa en vez de como una función de búsqueda porque
 * son tres o cuatro filas y porque una lista es un valor: el test le pasa un
 * arreglo literal y no un doble de repositorio.
 */
export function isAllowedIdentity(
  claims: WorkspaceClaims,
  allowlist: readonly AllowedIdentity[],
  workspaceDomain: string,
): IdentityDecision {
  const gate = checkWorkspaceClaims(claims, workspaceDomain);
  if (!gate.ok) return gate;

  const row = findAllowedEntry(gate.email, allowlist);
  if (row === null) return { ok: false, reason: "fuera_de_allowlist" };

  return {
    ok: true,
    email: gate.email,
    role: row.role,
    eaProviderId: row.ea_provider_id,
  };
}

// ── Matriz de permisos ──────────────────────────────────────────────────────

/**
 * Lo que alguien puede hacer, nombrado por la operación y no por la pantalla.
 *
 * Sale de dos lugares del plan y de ninguno más: la tabla "Quién puede qué" de
 * § Cuenta de servicio y el párrafo del rol `staff` en § Navegación y pantallas.
 * **No se inventan permisos acá.** Cuando un paquete de la ola C necesite uno
 * que no está, se agrega con su fila de la matriz y su test; deducirlo sobre la
 * marcha es cómo una interfaz termina siendo más permisiva que su documento.
 *
 * - `cuenta:cerrar-propia` — cerrar la cuenta de **su** cita del día.
 * - `cuenta:cerrar-ajena` — cerrar (y editar) la cuenta de cualquiera.
 * - `cuenta:cobrar` — registrar el método de pago. Para `staff` depende de
 *   `TICKET_STAFF_COBRA`: en un estudio de dos personas la técnica cobra; con
 *   recepción de planta, no.
 * - `cuenta:corregir-tras-cierre` — tocar una cuenta después del cierre diario,
 *   que genera un ajuste. Solo `owner`: en ese momento los números ya salieron
 *   hacia Strapi y Actual Budget.
 * - `caja:ver` — totales del día y cuentas de las demás.
 * - `caja:cerrar-dia` — el cierre diario.
 * - `reportes:ver` — el set de reportes de la dueña.
 * - `agenda:ver-todas` — la grilla completa, no solo la columna propia.
 * - `liquidacion:ver-propia` — su liquidación y su ticket promedio.
 * - `liquidacion:ver-todas` — la quincena de todo el equipo.
 * - `comisiones:administrar` — reglas y `commission_run`.
 * - `equipo:administrar` — allowlist, enrolamiento TOTP, revocación de sesiones.
 * - `catalogo:publicar` — el diff `pricing.ts` ↔ EA en el sentido de escritura.
 * - `diagnostico:ver` — el tablero de estado del sistema.
 * - `ea:avanzado` — el link a la interfaz de EA.
 */
export type Capability =
  | "cuenta:cerrar-propia"
  | "cuenta:cerrar-ajena"
  | "cuenta:cobrar"
  | "cuenta:corregir-tras-cierre"
  | "caja:ver"
  | "caja:cerrar-dia"
  | "reportes:ver"
  | "agenda:ver-todas"
  | "liquidacion:ver-propia"
  | "liquidacion:ver-todas"
  | "comisiones:administrar"
  | "equipo:administrar"
  | "catalogo:publicar"
  | "diagnostico:ver"
  | "ea:avanzado";

/**
 * Contexto que hace variar una fila de la matriz.
 *
 * Hoy hay uno solo, y existe porque la respuesta cambia con la operación del
 * estudio, no con el código. Entra como parámetro para que `can()` siga siendo
 * pura.
 */
export type PolicyContext = {
  /** `TICKET_STAFF_COBRA`. Por defecto **no**: el permiso se concede, no se supone. */
  staffCobra?: boolean;
};

/**
 * La matriz, escrita como matriz.
 *
 * Una tabla literal y no una cadena de `if`: se lee al lado de la del plan y se
 * ve si coinciden. Un `switch` con `default: return true` en algún ramal es cómo
 * aparece un permiso que nadie concedió.
 *
 * `staff` no tiene `cuenta:cobrar` acá **a propósito**: es la única celda
 * condicional y se resuelve en `can()`, para que la tabla no mienta a medias.
 */
const MATRIX: Record<UserRole, ReadonlySet<Capability>> = {
  owner: new Set<Capability>([
    "cuenta:cerrar-propia",
    "cuenta:cerrar-ajena",
    "cuenta:cobrar",
    "cuenta:corregir-tras-cierre",
    "caja:ver",
    "caja:cerrar-dia",
    "reportes:ver",
    "agenda:ver-todas",
    "liquidacion:ver-propia",
    "liquidacion:ver-todas",
    "comisiones:administrar",
    "equipo:administrar",
    "catalogo:publicar",
    "diagnostico:ver",
    "ea:avanzado",
  ]),

  // Recepción. Opera el día completo y cierra la caja, pero no corrige después
  // del cierre ni administra a las personas: eso es de la dueña.
  admin: new Set<Capability>([
    "cuenta:cerrar-propia",
    "cuenta:cerrar-ajena",
    "cuenta:cobrar",
    "caja:ver",
    "caja:cerrar-dia",
    "reportes:ver",
    "agenda:ver-todas",
    "diagnostico:ver",
  ]),

  // La técnica. Su alcance es su propio día, sus propias cuentas y su propia
  // liquidación — y eso es lo que hace aceptable que su factor de entrada sea
  // solo el TOTP (ver `totp.ts`).
  staff: new Set<Capability>([
    "cuenta:cerrar-propia",
    "liquidacion:ver-propia",
  ]),
};

/**
 * ¿Este rol alcanza esta operación?
 *
 * Se llama desde el DAL, no desde la pantalla. Esconder un botón es un gesto de
 * cortesía con la usuaria; **un botón escondido no es un permiso**, porque la
 * Server Action que había detrás sigue existiendo y se puede invocar sin él.
 */
export function can(
  role: UserRole,
  capability: Capability,
  ctx: PolicyContext = {},
): boolean {
  if (role === "staff" && capability === "cuenta:cobrar") {
    return ctx.staffCobra === true;
  }
  return MATRIX[role].has(capability);
}

/**
 * Lo que un `staff` alcanza **de sí mismo** y de nadie más.
 *
 * Es la segunda mitad del alcance: `can()` dice que la técnica puede cerrar una
 * cuenta, y esto dice *cuál*. Sin este chequeo, "cerrar la cuenta de su cita"
 * y "cerrar la cuenta de cualquiera" son el mismo permiso.
 *
 * `owner` y `admin` pasan siempre; para ellos la pregunta no aplica. Un `staff`
 * sin `ea_provider_id` no alcanza **nada**: es una fila a medio configurar, y
 * la respuesta segura ahí es que no.
 */
export function ownsProvider(
  role: UserRole,
  sessionEaProviderId: number | null,
  targetEaProviderId: number | null,
): boolean {
  if (role !== "staff") return true;
  if (sessionEaProviderId === null) return false;
  return sessionEaProviderId === targetEaProviderId;
}

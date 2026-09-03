import "server-only";

import { getDb } from "@/db/client";
import { allowedUserRepository, staffTotpRepository } from "@/db/repositories";
import type { AllowedUser } from "@/db/types";
import {
  EA_TIME_ZONE,
  EaApiError,
  type Provider,
  type Service,
  type WorkingPlanException,
} from "@/lib/ea";
import { createEaClient } from "@/lib/ea/client";

import { googleSyncStatus, type GoogleSyncStatus } from "./sync";
import {
  buildWeekPlan,
  upcomingExceptions,
  type PlanException,
  type WeekPlan,
} from "./working-plan";

/**
 * Lo que Equipo tiene que juntar.
 *
 * **Dos sistemas de identidad conviven a propósito** (§ Auth): las cuentas de
 * Easy!Appointments (provider / secretary / admin) son las que usan el token de
 * la API y la sincronización con Google, y las cuentas del panel son las de
 * Workspace o TOTP. `allowed_user.ea_provider_id` es el puente, y esta pantalla
 * es donde ese puente se ve.
 *
 * Por eso una fila de Equipo no es "un usuario": es la unión de hasta tres
 * cosas —el provider de EA, la fila de la allowlist y el enrolamiento TOTP— y
 * cualquiera de las tres puede faltar. Que falte es justamente lo que hay que
 * poder ver: una técnica con provider y sin cuenta no puede entrar al panel, y
 * una cuenta sin provider no puede cerrar una cuenta de servicio.
 */

export type EquipoFailure = {
  transient: boolean;
  message: string;
};

export type TotpState = "sin-enrolar" | "pendiente" | "activo" | "bloqueado";

export type PanelAccount = {
  allowed: AllowedUser;
  /** El `user` de Better Auth, si esa persona ya existe como cuenta. */
  userId: string | null;
  name: string | null;
  totp: TotpState;
  lockedUntil: Date | null;
};

export type TeamMember = {
  provider: Provider;
  name: string;
  /** Nombres de los servicios que tiene asignados. Vacío = no puede tomar nada. */
  serviceNames: string[];
  sync: GoogleSyncStatus;
  /** La cuenta del panel enlazada por `ea_provider_id`, si existe. */
  account: PanelAccount | null;
};

export type EquipoView = {
  members: TeamMember[];
  /** Cuentas del panel que no están enlazadas a ningún provider (dueña, recepción). */
  unlinkedAccounts: PanelAccount[];
  /** URL pública de EA para los enlaces a su interfaz. `null` = sin configurar. */
  eaPublicUrl: string | null;
  failures: EquipoFailure[];
};

export type MemberDetail = {
  member: TeamMember;
  plan: WeekPlan;
  exceptions: PlanException[];
  eaPublicUrl: string | null;
};

/**
 * La URL pública de Easy!Appointments.
 *
 * ⚠ **Variable nueva: `EA_PUBLIC_URL`.** No se puede derivar de `EA_API_URL`,
 * que apunta al contenedor por la red interna de Docker
 * (`http://golden-agenda/index.php/api/v1`) y no abre desde el navegador de
 * nadie. Sin ella los enlaces a EA no se dibujan, con un aviso — mandar a
 * alguien a una URL que no resuelve es peor que no ofrecer el enlace.
 */
export function eaPublicUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.EA_PUBLIC_URL?.trim();
  if (!value) return null;
  try {
    new URL(value);
    return value.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function describeEaFailure(error: unknown): EquipoFailure {
  if (error instanceof EaApiError) {
    return {
      transient: error.isTransient,
      message: error.isConfiguration
        ? "El panel no puede autenticarse contra la agenda."
        : "La agenda no está respondiendo.",
    };
  }
  return { transient: true, message: "La agenda no está respondiendo." };
}

/** Las cuentas del panel, con su estado de enrolamiento. */
async function loadPanelAccounts(): Promise<PanelAccount[]> {
  const db = getDb();
  const allowlist = await allowedUserRepository(db).list();

  // Un solo viaje por los `user` de Better Auth: la allowlist tiene tres o
  // cuatro filas, y un `IN` sobre correos es más barato que una consulta por
  // persona.
  const emails = allowlist.map((entry) => entry.email);
  const users =
    emails.length === 0
      ? []
      : await db
          .selectFrom("user")
          .select(["id", "email", "name"])
          .where("email", "in", emails)
          .execute();

  const userByEmail = new Map(users.map((row) => [row.email.toLowerCase(), row]));
  const totp = staffTotpRepository(db);
  const now = Date.now();

  return Promise.all(
    allowlist.map(async (allowed): Promise<PanelAccount> => {
      const user = userByEmail.get(allowed.email.toLowerCase()) ?? null;
      if (!user) {
        return {
          allowed,
          userId: null,
          name: null,
          totp: "sin-enrolar",
          lockedUntil: null,
        };
      }

      const row = await totp.findByUserId(user.id);
      const lockedUntil = row?.locked_until ?? null;
      const locked = lockedUntil !== null && lockedUntil.getTime() > now;

      return {
        allowed,
        userId: user.id,
        name: user.name,
        totp: !row
          ? "sin-enrolar"
          : locked
            ? "bloqueado"
            : row.confirmed_at === null
              ? "pendiente"
              : "activo",
        lockedUntil,
      };
    }),
  );
}

export async function loadEquipoView(): Promise<EquipoView> {
  const failures: EquipoFailure[] = [];

  let providers: Provider[] = [];
  let services: Service[] = [];
  try {
    const ea = createEaClient();
    [providers, services] = await Promise.all([ea.providers.list(), ea.services.list()]);
  } catch (error) {
    failures.push(describeEaFailure(error));
  }

  let accounts: PanelAccount[] = [];
  try {
    accounts = await loadPanelAccounts();
  } catch (error) {
    failures.push({
      transient: true,
      message: "No se pudieron leer las cuentas del panel.",
    });
    console.error("[equipo] no se pudo leer allowed_user/staff_totp", error);
  }

  const serviceName = new Map(services.map((service) => [service.id, service.name ?? `#${service.id}`]));
  const accountByProvider = new Map<number, PanelAccount>();
  for (const account of accounts) {
    if (account.allowed.ea_provider_id !== null) {
      accountByProvider.set(account.allowed.ea_provider_id, account);
    }
  }

  const members: TeamMember[] = providers.map((provider) => ({
    provider,
    name: fullName(provider),
    serviceNames: (provider.services ?? []).map(
      (id) => serviceName.get(id) ?? `#${id}`,
    ),
    sync: googleSyncStatus(provider),
    account: accountByProvider.get(provider.id) ?? null,
  }));

  members.sort((a, b) => a.name.localeCompare(b.name, "es"));

  return {
    members,
    unlinkedAccounts: accounts.filter(
      (account) =>
        account.allowed.ea_provider_id === null ||
        !accountByProvider.has(account.allowed.ea_provider_id),
    ),
    eaPublicUrl: eaPublicUrl(),
    failures,
  };
}

export async function loadMemberDetail(
  providerId: number,
): Promise<MemberDetail | null> {
  let provider: Provider;
  let services: Service[] = [];
  let exceptions: WorkingPlanException[] = [];
  try {
    const ea = createEaClient();
    // **Las excepciones se piden por su propio recurso, no se leen del blob de
    // `settings`.** EA las guarda dentro de `user_settings` como JSON y su
    // forma exacta no está garantizada; `GET /working_plan_exceptions` sí
    // tiene codec tipado en A1. El recurso no acepta filtro por profesional,
    // así que se traen todas y se filtra acá: son unas pocas filas.
    [provider, services, exceptions] = await Promise.all([
      ea.providers.get(providerId),
      ea.services.list(),
      ea.workingPlanExceptions.list(),
    ]);
  } catch (error) {
    if (error instanceof EaApiError && error.kind === "not_found") return null;
    throw error;
  }

  let account: PanelAccount | null = null;
  try {
    const accounts = await loadPanelAccounts();
    account =
      accounts.find((row) => row.allowed.ea_provider_id === providerId) ?? null;
  } catch (error) {
    console.error("[equipo] no se pudo leer la cuenta del panel", error);
  }

  const serviceName = new Map(services.map((s) => [s.id, s.name ?? `#${s.id}`]));

  return {
    member: {
      provider,
      name: fullName(provider),
      serviceNames: (provider.services ?? []).map((id) => serviceName.get(id) ?? `#${id}`),
      sync: googleSyncStatus(provider),
      account,
    },
    plan: buildWeekPlan(provider.settings?.workingPlan ?? null),
    exceptions: upcomingExceptions(
      exceptions.filter((exception) => exception.providerId === providerId),
      todayInStudio(),
    ),
    eaPublicUrl: eaPublicUrl(),
  };
}

/**
 * El "hoy" del estudio, no el del proceso.
 *
 * Recortar el pasado con la fecha UTC haría que entre las 7 y las 12 de la
 * noche de Bogotá la lista escondiera la excepción de mañana.
 */
function todayInStudio(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: EA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function fullName(provider: Provider): string {
  return (
    [provider.firstName, provider.lastName]
      .map((part) => (typeof part === "string" ? part.trim() : ""))
      .filter((part) => part !== "")
      .join(" ") || `Profesional #${provider.id}`
  );
}

import "server-only";

/**
 * Lectura directa de `easyappointments`, por SQL y de solo lectura.
 *
 * ## Por qué SQL y no la API de EA
 *
 * El plan lo decide y es la razón de que el panel viva en la VM y no en Vercel:
 * "los reportes necesitan agregación SQL sobre las tablas de
 * Easy!Appointments, y la API REST de EA no agrega". Un mes de citas por la API
 * son varias páginas de 100 registros por cada recurso, y después habría que
 * agrupar en memoria de todos modos.
 *
 * **Las escrituras van siempre por la API REST**, nunca por acá: es lo que
 * dispara las notificaciones y el sync de Google Calendar. Este módulo no tiene
 * una sola sentencia que no sea `SELECT`, y el usuario de `DATABASE_URL_EA_RO`
 * solo tiene `GRANT SELECT`.
 *
 * ## No hay JOIN entre esquemas
 *
 * `gbs_admin` y `easyappointments` se leen con **usuarios distintos**, así que
 * una consulta no puede cruzarlos. El cruce se hace en memoria por
 * `ea_appointment_id`, que es exactamente para lo que A2 copió `ea_provider_id`
 * y `appointment_start_at` a la fila de plata.
 *
 * ## Los nombres de tabla y de columna están verificados en la fuente de EA
 *
 * No de memoria. EA 1.6.0, prefijo `ea_` (`application/config/database.php`),
 * esquema creado por `application/migrations/001_specific_calendar_sync.php` y
 * mutado por las migraciones siguientes. Lo que se usó acá:
 *
 * | Dato | Dónde | Evidencia |
 * | --- | --- | --- |
 * | Citas | `ea_appointments` | `001:27-79`; `status` VARCHAR(512) por `044` |
 * | Indisponibilidades | la **misma** tabla, `is_unavailability = 1` | `Unavailabilities_model.php:160`; en esas filas `id_services` e `id_users_customer` son NULL (`Google.php:417-418`) |
 * | Bloqueos del estudio | `ea_blocked_periods` | `048:22-57` — **sin** `id_users_provider`: aplican a todo el local |
 * | Técnicas | `ea_users` ⋈ `ea_roles.slug = 'provider'` | `Providers_model.php:157-159`, `constants.php:47-50` |
 * | Plan y sync | `ea_user_settings.working_plan`, `.google_sync`, `.google_calendar`, PK `id_users` | `001:345-381` |
 * | Excepciones | `ea_working_plan_exceptions` | `065:22-84`; `start_time` NULL = día libre (`Working_plan_exceptions_model.php:468-469`) |
 * | Servicios | `ea_services` (`duration` en minutos, `price` DECIMAL(10,2)) | `001:160-195` |
 * | Ajustes | `ea_settings(name, value)` | `001:238-256`, `Settings_model.php:33-36` |
 *
 * Tres hallazgos de esa lectura que cambian el código de acá:
 *
 * 1. **`ea_appointments` no tiene índice en `start_datetime`.** Sus únicas
 *    claves son la PK y las tres FK (`001:81-84`, y ninguna migración agrega
 *    otra). Toda agregación por rango de fechas hace un barrido completo. Con
 *    los miles de filas de un estudio de dos puestos no se nota; está reportado
 *    para el día que se note.
 * 2. **Los `DATETIME` se piden formateados como texto**, no como `DATETIME`. EA
 *    guarda hora de pared local sin zona, y el tipo canónico del dominio en
 *    este proyecto es la hora de pared (A1). Dejar que mysql2 los convierta a
 *    `Date` y volver a formatearlos mete dos conversiones de zona donde no
 *    hacía falta ninguna — que es el bug de cinco horas que este proyecto lleva
 *    persiguiendo desde el principio.
 * 3. **`ea_working_plan_exceptions` existe solo desde EA 1.5.** Si la tabla no
 *    está, la consulta falla y se devuelve vacío con el motivo, en vez de
 *    tumbar el reporte: sin excepciones la ocupación sale un poco alta, y
 *    decirlo es mejor que no mostrar nada.
 */

import type { Pool, RowDataPacket } from "mysql2";

import { createEaReadOnlyPool } from "@/db/client";
import {
  parseEaLocalDate,
  parseEaLocalDateTime,
  type EaLocalDate,
  type EaLocalDateTime,
} from "@/lib/ea";
import type { WorkingPlan, WorkingPlanException } from "@/lib/ea";

import { normalizePhoneE164 } from "../clientes/identity";
import type { AppointmentRow, ServiceRow } from "./aggregate";
import type { Interval } from "@/lib/metrics";

/**
 * El pool, uno por proceso.
 *
 * `createEaReadOnlyPool()` **crea un pool nuevo en cada llamada**, así que
 * invocarla por request abriría cinco conexiones más cada vez que alguien
 * refresca Reportes hasta agotar `max_connections` del servidor compartido. La
 * memoización va acá y no en `db/client.ts` porque ese archivo es de A2; lo
 * natural es que viva allá, junto a la de `getDb()`, y está reportado.
 */
let pool: Pool | null = null;

function eaPool(): Pool {
  if (pool === null) pool = createEaReadOnlyPool();
  return pool;
}

async function select<T extends RowDataPacket>(
  sql: string,
  params: readonly (string | number)[] = [],
): Promise<T[]> {
  // `[...params]`: mysql2 tipa los valores como un arreglo mutable, y todo lo
  // que entra acá es `readonly` a propósito. La copia es de tres elementos.
  const [rows] = await eaPool().promise().query<T[]>(sql, [...params]);
  return rows;
}

/** Lo que devuelve un lote de consultas: los datos, y qué no se pudo traer. */
export type EaLoad<T> = { data: T; problems: string[] };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Citas ───────────────────────────────────────────────────────────────────

interface AppointmentPacket extends RowDataPacket {
  id: number;
  start: string;
  end: string;
  status: string | null;
  id_users_provider: number | null;
  id_services: number | null;
  id_google_calendar: string | null;
  mobile_number: string | null;
  phone_number: string | null;
}

/**
 * Las citas **reales** de un rango de fechas.
 *
 * `is_unavailability = 0` no es opcional: sin ese filtro los bloqueos y las
 * ausencias entran como citas, y el reporte de inasistencia empieza a contar
 * almuerzos.
 *
 * El teléfono se normaliza a E.164 con la función de C4 —la identidad de la
 * clienta es el teléfono y no un correo inventado— y se prefiere el celular al
 * fijo, porque es el que la clienta usa para WhatsApp. `null` cuando no hay
 * ninguno que sirva de llave; contarlo es trabajo del reporte de clientas.
 */
export async function loadAppointments(
  from: EaLocalDate,
  to: EaLocalDate,
): Promise<AppointmentRow[]> {
  const rows = await select<AppointmentPacket>(
    `SELECT a.id,
            DATE_FORMAT(a.start_datetime, '%Y-%m-%d %H:%i:%s') AS start,
            DATE_FORMAT(a.end_datetime,   '%Y-%m-%d %H:%i:%s') AS end,
            a.status,
            a.id_users_provider,
            a.id_services,
            a.id_google_calendar,
            c.mobile_number,
            c.phone_number
       FROM ea_appointments a
       LEFT JOIN ea_users c ON c.id = a.id_users_customer
      WHERE a.is_unavailability = 0
        AND a.start_datetime >= ?
        AND a.start_datetime < DATE_ADD(?, INTERVAL 1 DAY)
      ORDER BY a.start_datetime, a.id`,
    [from, to],
  );

  return rows.map((row): AppointmentRow => {
    const phone =
      normalizePhoneE164(row.mobile_number) ?? normalizePhoneE164(row.phone_number);
    return {
      id: row.id,
      start: parseEaLocalDateTime(row.start),
      end: parseEaLocalDateTime(row.end ?? row.start),
      status: row.status,
      eaProviderId: row.id_users_provider,
      eaServiceId: row.id_services,
      customerKey: phone,
      googleCalendarId: row.id_google_calendar,
    };
  });
}

/**
 * Todas las citas atendidas hasta una fecha, para poder decir si una clienta es
 * nueva.
 *
 * **Sin límite inferior a propósito.** "Clienta nueva = sin ninguna cita previa
 * en la unión EA + `legacy_appointment`", y una ventana recortada convertiría a
 * una clienta de hace un año en nueva. Con los miles de filas de este estudio
 * traerlas todas cuesta menos que la consulta de agregación que haría falta
 * para evitarlo; el día que sean cientos de miles, esto es lo primero que hay
 * que cambiar — y hará falta un índice en `start_datetime`, que EA no trae.
 *
 * `till` llega hasta el final de la ventana de retención, no hasta el fin del
 * periodo: la retención a 60 días necesita ver las visitas *posteriores*.
 */
export async function loadVisitHistory(till: EaLocalDate): Promise<AppointmentRow[]> {
  const rows = await select<AppointmentPacket>(
    `SELECT a.id,
            DATE_FORMAT(a.start_datetime, '%Y-%m-%d %H:%i:%s') AS start,
            DATE_FORMAT(a.end_datetime,   '%Y-%m-%d %H:%i:%s') AS end,
            a.status,
            a.id_users_provider,
            a.id_services,
            a.id_google_calendar,
            c.mobile_number,
            c.phone_number
       FROM ea_appointments a
       LEFT JOIN ea_users c ON c.id = a.id_users_customer
      WHERE a.is_unavailability = 0
        AND a.start_datetime < DATE_ADD(?, INTERVAL 1 DAY)
      ORDER BY a.start_datetime, a.id`,
    [till],
  );

  return rows.map((row): AppointmentRow => {
    const phone =
      normalizePhoneE164(row.mobile_number) ?? normalizePhoneE164(row.phone_number);
    return {
      id: row.id,
      start: parseEaLocalDateTime(row.start),
      end: parseEaLocalDateTime(row.end ?? row.start),
      status: row.status,
      eaProviderId: row.id_users_provider,
      eaServiceId: row.id_services,
      customerKey: phone,
      googleCalendarId: row.id_google_calendar,
    };
  });
}

// ── Técnicas ────────────────────────────────────────────────────────────────

interface ProviderPacket extends RowDataPacket {
  id: number;
  first_name: string | null;
  last_name: string | null;
  working_plan: string | null;
  google_sync: number | null;
  google_calendar: string | null;
}

export type EaProvider = {
  id: number;
  name: string;
  workingPlan: WorkingPlan | null;
  /** `google_sync` activo: es la condición para vigilar el espejo. */
  googleSync: boolean;
  googleCalendar: string | null;
};

/**
 * Las técnicas, con su plan de trabajo y su estado de sync.
 *
 * El `working_plan` es un `TEXT` con JSON editado desde la interfaz de EA, así
 * que un JSON roto es posible: se devuelve `null` en vez de lanzar, y una
 * técnica sin plan sale con cero horas disponibles — que es la lectura segura,
 * no "trabaja de 9 a 6".
 */
export async function loadProviders(): Promise<EaProvider[]> {
  const rows = await select<ProviderPacket>(
    `SELECT u.id, u.first_name, u.last_name,
            s.working_plan, s.google_sync, s.google_calendar
       FROM ea_users u
       INNER JOIN ea_roles r ON r.id = u.id_roles
       LEFT JOIN ea_user_settings s ON s.id_users = u.id
      WHERE r.slug = 'provider'
      ORDER BY u.first_name, u.last_name, u.id`,
  );

  return rows.map((row): EaProvider => {
    const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
    return {
      id: row.id,
      name: name === "" ? `Técnica #${row.id}` : name,
      workingPlan: parsePlan(row.working_plan),
      googleSync: row.google_sync === 1,
      googleCalendar: row.google_calendar,
    };
  });
}

function parsePlan(raw: string | null): WorkingPlan | null {
  if (raw === null || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    // No se valida campo por campo: `dayWindow()` de `occupancy.ts` ya trata
    // cualquier día que no pueda leer como día libre, y validar dos veces la
    // misma cosa en dos archivos es cómo se llega a dos criterios distintos.
    return parsed as WorkingPlan;
  } catch {
    return null;
  }
}

// ── Excepciones al plan ─────────────────────────────────────────────────────

interface ExceptionPacket extends RowDataPacket {
  id: number;
  id_users_provider: number | null;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  breaks: string | null;
}

/**
 * Las excepciones que tocan el rango.
 *
 * **Se lee la tabla, no la columna legada.** `ea_user_settings.working_plan_exceptions`
 * sigue existiendo (la agregó la migración `015` y nadie la borró) pero quedó
 * obsoleta con la `066`, que copió su contenido a la tabla y dejó de
 * escribirla; `Providers_model::get_settings()` incluso sobrescribe el valor en
 * memoria con lo que trae la tabla. Leer la columna daría las excepciones de
 * hace dos años.
 *
 * Si la tabla no existe —EA anterior a 1.5— se devuelve vacío con el motivo.
 * Sin excepciones la ocupación sale un poco alta; decirlo es mejor que no
 * mostrar el reporte.
 */
export async function loadPlanExceptions(
  from: EaLocalDate,
  to: EaLocalDate,
): Promise<EaLoad<WorkingPlanException[]>> {
  try {
    const rows = await select<ExceptionPacket>(
      `SELECT id, id_users_provider,
              DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
              DATE_FORMAT(end_date,   '%Y-%m-%d') AS end_date,
              start_time, end_time, breaks
         FROM ea_working_plan_exceptions
        WHERE end_date >= ? AND start_date <= ?
        ORDER BY id`,
      [from, to],
    );

    return {
      data: rows.map(
        (row): WorkingPlanException => ({
          id: row.id,
          startDate: parseEaLocalDate(row.start_date),
          endDate: parseEaLocalDate(row.end_date),
          startTime: row.start_time,
          endTime: row.end_time,
          breaks: parseBreaks(row.breaks),
          providerId: row.id_users_provider,
        }),
      ),
      problems: [],
    };
  } catch (error) {
    return {
      data: [],
      problems: [
        `No se pudieron leer las excepciones al plan de trabajo (${messageOf(error)}). ` +
          "La ocupación se calcula sin ellas, así que puede salir alta.",
      ],
    };
  }
}

function parseBreaks(raw: string | null): { start: string; end: string }[] {
  if (raw === null || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is { start: string; end: string } =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { start?: unknown }).start === "string" &&
        typeof (item as { end?: unknown }).end === "string",
    );
  } catch {
    return [];
  }
}

// ── Tiempo no disponible ────────────────────────────────────────────────────

interface BlockPacket extends RowDataPacket {
  id_users_provider: number | null;
  start: string;
  end: string;
}

export type EaBlocks = {
  /** Ausencias de una técnica: viven en `ea_appointments`, no en otra tabla. */
  byProvider: Map<number, Interval[]>;
  /**
   * Bloqueos de todo el estudio. `ea_blocked_periods` **no tiene** columna de
   * técnica: aplican al local completo, a diferencia de las ausencias.
   */
  studio: Interval[];
};

export async function loadBlocks(
  from: EaLocalDate,
  to: EaLocalDate,
): Promise<EaLoad<EaBlocks>> {
  const byProvider = new Map<number, Interval[]>();
  const studio: Interval[] = [];
  const problems: string[] = [];

  const unavailable = await select<BlockPacket>(
    `SELECT a.id_users_provider,
            DATE_FORMAT(a.start_datetime, '%Y-%m-%d %H:%i:%s') AS start,
            DATE_FORMAT(a.end_datetime,   '%Y-%m-%d %H:%i:%s') AS end
       FROM ea_appointments a
      WHERE a.is_unavailability = 1
        AND a.start_datetime < DATE_ADD(?, INTERVAL 1 DAY)
        AND a.end_datetime >= ?`,
    [to, from],
  );

  for (const row of unavailable) {
    if (row.id_users_provider === null || row.end === null) continue;
    const bucket = byProvider.get(row.id_users_provider) ?? [];
    bucket.push({
      start: parseEaLocalDateTime(row.start),
      end: parseEaLocalDateTime(row.end),
    });
    byProvider.set(row.id_users_provider, bucket);
  }

  try {
    const blocked = await select<BlockPacket>(
      `SELECT NULL AS id_users_provider,
              DATE_FORMAT(start_datetime, '%Y-%m-%d %H:%i:%s') AS start,
              DATE_FORMAT(end_datetime,   '%Y-%m-%d %H:%i:%s') AS end
         FROM ea_blocked_periods
        WHERE start_datetime < DATE_ADD(?, INTERVAL 1 DAY)
          AND end_datetime >= ?`,
      [to, from],
    );

    for (const row of blocked) {
      if (row.end === null) continue;
      studio.push({
        start: parseEaLocalDateTime(row.start),
        end: parseEaLocalDateTime(row.end),
      });
    }
  } catch (error) {
    // `ea_blocked_periods` la agregó EA 1.5 (`048`). Igual que con las
    // excepciones: sin ella la ocupación sale alta, y decirlo es mejor que
    // esconder el reporte.
    problems.push(
      `No se pudieron leer los bloqueos del estudio (${messageOf(error)}). ` +
        "La ocupación se calcula sin ellos.",
    );
  }

  return { data: { byProvider, studio }, problems };
}

// ── Servicios ───────────────────────────────────────────────────────────────

interface ServicePacket extends RowDataPacket {
  id: number;
  name: string | null;
  duration: number | null;
}

/**
 * El catálogo, con la duración en minutos.
 *
 * `duration` es el denominador del ingreso por hora de silla, así que un
 * servicio con duración nula o cero deja su fila sin rendimiento —
 * `revenuePerChairHour()` devuelve `null` — y el reporte lo cuenta y lo dice.
 * `price` no se lee: el precio que valen los reportes es el **congelado** en
 * `appointment_finance`, no el de lista de hoy.
 */
export async function loadServices(): Promise<ServiceRow[]> {
  const rows = await select<ServicePacket>(
    `SELECT id, name, duration FROM ea_services ORDER BY id`,
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name === null || row.name.trim() === "" ? `Servicio #${row.id}` : row.name,
    durationMin: row.duration ?? 0,
  }));
}

// ── Ajustes ─────────────────────────────────────────────────────────────────

interface SettingPacket extends RowDataPacket {
  value: string | null;
}

/**
 * Un ajuste global de EA, por nombre.
 *
 * Se lee por SQL y no por `GET /settings/{name}` porque Diagnóstico ya tiene el
 * pool abierto y porque la API responde 404 con un nombre que no existe, que es
 * un caso normal acá — un EA anterior a la migración `043` no tiene la lista de
 * estados.
 */
export async function loadSetting(name: string): Promise<string | null> {
  const rows = await select<SettingPacket>(
    `SELECT value FROM ea_settings WHERE name = ? LIMIT 1`,
    [name],
  );
  return rows[0]?.value ?? null;
}

// ── Espejo de Google ────────────────────────────────────────────────────────

interface MirrorPacket extends RowDataPacket {
  id: number;
  start: string;
  id_users_provider: number | null;
}

/**
 * Citas **sin espejar en Google**: `id_google_calendar` vacío en técnicas con
 * `google_sync` activo.
 *
 * Es la **única** señal de que el push a Google falló. `Synchronization` de EA
 * se traga la excepción y solo la escribe en su log: la cita se guarda, la API
 * responde 201, y el espejo queda desincronizado sin que nadie se entere. De
 * ahí que la consulta viva acá y no en un reporte: es material de Diagnóstico.
 *
 * El filtro por `google_sync = 1` es parte de la definición, no una
 * optimización: una técnica sin sync activo **debe** tener el campo vacío, y
 * contarla convertiría el tablero en una alarma permanente que nadie mira.
 */
export async function loadUnmirrored(
  from: EaLocalDate,
  to: EaLocalDate,
): Promise<{ id: number; start: EaLocalDateTime; eaProviderId: number | null }[]> {
  const rows = await select<MirrorPacket>(
    `SELECT a.id,
            DATE_FORMAT(a.start_datetime, '%Y-%m-%d %H:%i:%s') AS start,
            a.id_users_provider
       FROM ea_appointments a
       INNER JOIN ea_user_settings s ON s.id_users = a.id_users_provider
      WHERE a.is_unavailability = 0
        AND s.google_sync = 1
        AND (a.id_google_calendar IS NULL OR a.id_google_calendar = '')
        AND a.start_datetime >= ?
        AND a.start_datetime < DATE_ADD(?, INTERVAL 1 DAY)
      ORDER BY a.start_datetime DESC, a.id DESC`,
    [from, to],
  );

  return rows.map((row) => ({
    id: row.id,
    start: parseEaLocalDateTime(row.start),
    eaProviderId: row.id_users_provider,
  }));
}

/**
 * Los ids de cita que **existen** en EA, entre los que se le pasen.
 *
 * Es la mitad de EA de la búsqueda de filas de plata huérfanas: el pull de
 * Google puede borrar una cita sin disparar `appointment_delete` —el borrado
 * pasa por el modelo y no por el controlador— y la fila de
 * `appointment_finance` queda sin par. La otra mitad la pone `gbs_admin`, y el
 * cruce se hace en memoria porque no hay JOIN entre esquemas.
 */
export async function loadExistingAppointmentIds(
  ids: readonly number[],
): Promise<Set<number>> {
  if (ids.length === 0) return new Set();

  const placeholders = ids.map(() => "?").join(",");
  const rows = await select<RowDataPacket & { id: number }>(
    `SELECT id FROM ea_appointments WHERE id IN (${placeholders})`,
    ids.map(Number),
  );

  return new Set(rows.map((row) => row.id));
}

/**
 * Las cadenas de `status` que existen de verdad en la ventana.
 *
 * `DISTINCT` y no las filas: lo que interesa es **qué valores hay**, y son
 * cinco o seis. Es la mitad de la comprobación de la lista de estados que mira
 * el daño ya hecho: EA no migra el `status` de las citas viejas al renombrar un
 * estado, así que después de un cambio conviven cadenas de las dos épocas.
 *
 * Se devuelve la cadena **cruda**, sin normalizar: quien la lea la va a buscar
 * tal cual en la interfaz de EA. `NULL` y `''` son valores legítimos — una cita
 * creada por la API sin `status` explícito queda en `''` — y viajan como `""`
 * para que el check pueda rotularlos.
 */
export async function loadStatusStrings(
  from: EaLocalDate,
  to: EaLocalDate,
): Promise<string[]> {
  const rows = await select<RowDataPacket & { status: string | null }>(
    `SELECT DISTINCT status
       FROM ea_appointments
      WHERE is_unavailability = 0
        AND start_datetime >= ?
        AND start_datetime < DATE_ADD(?, INTERVAL 1 DAY)`,
    [from, to],
  );

  return rows.map((row) => row.status ?? "");
}

/** ¿Contesta la base de EA? Lo más barato que responde eso de verdad. */
export async function pingEaDatabase(): Promise<void> {
  await select<RowDataPacket & { ok: number }>("SELECT 1 AS ok");
}

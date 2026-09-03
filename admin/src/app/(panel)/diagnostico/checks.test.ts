import { describe, expect, it } from "vitest";

import {
  BACKUP_RED_HOURS,
  backupCheck,
  eaApiCheck,
  eaDatabaseCheck,
  googleMirrorCheck,
  hoursSince,
  ingestPushCheck,
  orphanCheck,
  parseBackupStamp,
  parseBackupStatus,
  reconcileCheck,
  relativeAge,
  snapshotCheck,
  statusOptionsCheck,
  webhookCheck,
  webhookTrafficCheck,
  worstLevel,
  type Check,
  type RegisteredWebhook,
} from "./checks";

const NOW = new Date("2026-08-31T14:00:00-05:00");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const check = (level: Check["level"]): Check => ({
  id: "x",
  title: "x",
  level,
  detail: "x",
});

describe("worstLevel", () => {
  it("el peor gana, en el orden down > warn > unknown > ok", () => {
    // Un solo rojo no puede reportarse como "casi bien".
    expect(worstLevel([check("ok"), check("warn"), check("down")])).toBe("down");
    expect(worstLevel([check("ok"), check("unknown"), check("warn")])).toBe("warn");
    expect(worstLevel([check("ok"), check("unknown")])).toBe("unknown");
    expect(worstLevel([check("ok"), check("ok")])).toBe("ok");
  });

  it("una lista vacía es `ok`: nada que reportar", () => {
    expect(worstLevel([])).toBe("ok");
  });
});

describe("relativeAge", () => {
  it("cuenta minutos, horas y días", () => {
    expect(relativeAge(ago(30_000), NOW)).toBe("hace menos de un minuto");
    expect(relativeAge(ago(MINUTE), NOW)).toBe("hace 1 minuto");
    expect(relativeAge(ago(5 * MINUTE), NOW)).toBe("hace 5 minutos");
    expect(relativeAge(ago(HOUR), NOW)).toBe("hace 1 hora");
    expect(relativeAge(ago(5 * HOUR), NOW)).toBe("hace 5 horas");
    expect(relativeAge(ago(DAY), NOW)).toBe("hace 1 día");
    expect(relativeAge(ago(9 * DAY), NOW)).toBe("hace 9 días");
  });

  it("`null` es **nunca**, no «hace un rato»", () => {
    // "El último respaldo fue nunca" y "fue hace un momento" son las dos puntas
    // del riesgo del proyecto.
    expect(relativeAge(null, NOW)).toBe("nunca");
    expect(relativeAge(undefined, NOW)).toBe("nunca");
  });

  it("una marca en el futuro se rotula, no se muestra en negativo", () => {
    // Pasa cuando el reloj del contenedor y el de MySQL no coinciden, y eso es
    // en sí mismo un hallazgo.
    expect(relativeAge(new Date(NOW.getTime() + 2 * HOUR), NOW)).toBe(
      "en el futuro (revisar el reloj)",
    );
  });

  it("una fecha ilegible no produce «NaN días»", () => {
    expect(relativeAge(new Date("no es una fecha"), NOW)).toBe("fecha ilegible");
  });
});

describe("hoursSince", () => {
  it("devuelve horas fraccionarias", () => {
    expect(hoursSince(ago(90 * MINUTE), NOW)).toBeCloseTo(1.5, 6);
  });

  it("sin marca devuelve `null`, no cero", () => {
    expect(hoursSince(null, NOW)).toBeNull();
  });
});

describe("EA vivo", () => {
  it("verde cuando contesta", () => {
    expect(eaApiCheck({ ok: true, at: NOW, now: NOW }).level).toBe("ok");
    expect(eaDatabaseCheck({ ok: true, at: NOW, now: NOW }).level).toBe("ok");
  });

  it("rojo cuando no, y el detalle trae el motivo", () => {
    const api = eaApiCheck({ ok: false, error: "ECONNREFUSED", at: NOW, now: NOW });
    expect(api.level).toBe("down");
    expect(api.detail).toContain("ECONNREFUSED");
    expect(api.detail).toContain("solo lectura");

    const db = eaDatabaseCheck({ ok: false, at: NOW, now: NOW });
    expect(db.level).toBe("down");
    expect(db.detail).toContain("sin detalle");
  });
});

describe("webhookCheck", () => {
  const hook = (over: Partial<RegisteredWebhook> = {}): RegisteredWebhook => ({
    id: 1,
    name: "panel",
    url: "http://gbs-admin:3000/admin/api/webhooks/ea",
    actions: "appointment_save",
    isSslVerified: false,
    ...over,
  });

  const run = (webhooks: RegisteredWebhook[] | null, error?: string) =>
    webhookCheck({
      webhooks,
      error,
      expectedPath: "/admin/api/webhooks/ea",
      requiredAction: "appointment_save",
      now: NOW,
      at: NOW,
    });

  it("verde cuando está registrado, apunta acá y trae la acción", () => {
    const [registration] = run([hook()]);
    expect(registration.level).toBe("ok");
    expect(registration.detail).toContain("no reintenta");
  });

  it("rojo si ninguno apunta acá", () => {
    const [registration] = run([hook({ url: "https://otro.example/hook" })]);
    expect(registration.level).toBe("down");
    expect(registration.detail).toContain("03:45");
  });

  it("rojo si apunta acá pero le falta `appointment_save`: está mudo", () => {
    // Es exactamente lo que produce el ejemplo del openapi.yml de EA, que lista
    // acciones que no existen. Un webhook así no da error: no hace nada.
    const [registration] = run([
      hook({ actions: "appointment_create,appointment_update" }),
    ]);
    expect(registration.level).toBe("down");
    expect(registration.detail).toContain("mudo");
    expect(registration.figure).toBe("appointment_create,appointment_update");
  });

  it("acepta una lista de acciones con espacios", () => {
    const [registration] = run([hook({ actions: " customer_save , appointment_save " })]);
    expect(registration.level).toBe("ok");
  });

  it("sin acciones registradas es rojo, no verde por omisión", () => {
    const [registration] = run([hook({ actions: null })]);
    expect(registration.level).toBe("down");
  });

  it("una URL nula no cuenta como coincidencia", () => {
    const [registration] = run([hook({ url: null })]);
    expect(registration.level).toBe("down");
  });

  it("si no se pudo consultar es `unknown`, no rojo ni verde", () => {
    const checks = run(null, "401 Unauthorized");
    expect(checks).toHaveLength(1);
    expect(checks[0].level).toBe("unknown");
    expect(checks[0].detail).toContain("401 Unauthorized");
  });

  it("el header secreto siempre sale `unknown`, y dice por qué", () => {
    // La API de EA no emite `secret_header` al leer ni lo acepta al escribir.
    // Pintarlo de verde sería afirmar una comprobación imposible.
    for (const webhooks of [[hook()], [hook({ actions: null })]]) {
      const secret = webhookCheck({
        webhooks,
        expectedPath: "/admin/api/webhooks/ea",
        requiredAction: "appointment_save",
        now: NOW,
        at: NOW,
      }).find((entry) => entry.id === "webhook-secret");

      expect(secret?.level).toBe("unknown");
      expect(secret?.detail).toContain("secret_header");
    }
  });
});

describe("statusOptionsCheck", () => {
  const known = new Set([
    "Booked",
    "Confirmed",
    "Rescheduled",
    "Cancelled",
    "Reservada",
    "Confirmada",
    "Completada",
    "No asistió",
    "Cancelada",
  ]);
  const recognized = (value: string) => known.has(value);

  const run = (raw: string | null, unmapped: string[] = []) =>
    statusOptionsCheck({ raw, recognized, unmapped, now: NOW, at: NOW });

  it("verde cuando toda la lista se puede traducir", () => {
    const result = run('["Reservada", "Confirmada", "Completada", "No asistió", "Cancelada"]');
    expect(result.level).toBe("ok");
    expect(result.figure).toContain("Completada");
  });

  it("acepta el valor que siembra la migración 043 de EA, con sus espacios", () => {
    expect(run('["Booked", "Confirmed", "Rescheduled", "Cancelled"]').level).toBe("ok");
  });

  it("amarillo si la lista trae un estado que el panel no traduce", () => {
    const result = run('["Reservada", "Pendiente de pago"]');
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("Pendiente de pago");
  });

  it("amarillo si hay citas con estados que ya no están en la lista", () => {
    // EA no migra el `status` de las citas viejas al renombrar un estado.
    const result = run('["Reservada"]', ["Booked"]);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("no migra");
  });

  it("rotula el estado vacío como «(vacío)» y no como una cadena en blanco", () => {
    // Una fila creada por la API sin `status` explícito queda en `''`, y
    // mostrar eso como nada sería invisible.
    expect(run('["Reservada"]', [""]).detail).toContain("(vacío)");
  });

  it("amarillo si el ajuste no existe", () => {
    const result = run(null);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("043");
  });

  it("amarillo si el ajuste no es JSON, o no es una lista", () => {
    expect(run("Booked,Confirmed").level).toBe("warn");
    expect(run("Booked,Confirmed").detail).toContain("json_decode");
    expect(run('{"a":1}').level).toBe("warn");
    expect(run('{"a":1}').detail).toContain("arreglo JSON");
  });

  it("ignora los elementos que no son cadenas en vez de romperse", () => {
    expect(run('["Reservada", 7, null]').level).toBe("ok");
  });
});

describe("snapshotCheck", () => {
  it("verde sin cuentas problemáticas", () => {
    const result = snapshotCheck({
      withoutSnapshot: 0,
      fallback: 0,
      total: 12,
      now: NOW,
      at: NOW,
    });
    expect(result.level).toBe("ok");
    expect(result.figure).toBe("0 de 12");
  });

  it("amarillo con `fallback`, y explica que el reconcile las repara", () => {
    // `fallback` es la marca de "se valoró al precio de hoy": sin ella un cero
    // silencioso es indistinguible de un cero correcto.
    const result = snapshotCheck({
      withoutSnapshot: 0,
      fallback: 3,
      total: 12,
      now: NOW,
      at: NOW,
    });
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("reconcile");
  });

  it("amarillo también sin snapshot", () => {
    expect(
      snapshotCheck({ withoutSnapshot: 2, fallback: 0, total: 12, now: NOW, at: NOW }).level,
    ).toBe("warn");
  });
});

describe("googleMirrorCheck", () => {
  it("verde con cero", () => {
    const result = googleMirrorCheck({ unmirrored: 0, windowDays: 30, now: NOW, at: NOW });
    expect(result.level).toBe("ok");
  });

  it("**rojo** con cualquier número distinto de cero", () => {
    // Es la única señal de que el push falló: EA responde 201 igual.
    const result = googleMirrorCheck({ unmirrored: 1, windowDays: 30, now: NOW, at: NOW });
    expect(result.level).toBe("down");
    expect(result.detail).toContain("silencio");
    expect(result.detail).toContain("Reenviar a Google");
  });

  it("`unknown` si no se pudo consultar", () => {
    const result = googleMirrorCheck({
      unmirrored: null,
      windowDays: 30,
      error: "tabla ausente",
      now: NOW,
      at: NOW,
    });
    expect(result.level).toBe("unknown");
    expect(result.detail).toContain("tabla ausente");
  });
});

describe("orphanCheck", () => {
  it("verde con cero", () => {
    expect(orphanCheck({ orphans: 0, checked: 40, now: NOW, at: NOW }).level).toBe("ok");
  });

  it("rojo con al menos una, y explica que no se borra en cascada", () => {
    const result = orphanCheck({ orphans: 2, checked: 40, now: NOW, at: NOW });
    expect(result.level).toBe("down");
    expect(result.detail).toContain("libro de caja");
  });

  it("`unknown` si una de las dos bases no contestó", () => {
    // No hay JOIN entre esquemas: el cruce necesita las dos.
    const result = orphanCheck({ orphans: null, checked: 0, now: NOW, at: NOW });
    expect(result.level).toBe("unknown");
    expect(result.detail).toContain("JOIN");
  });
});

describe("reconcileCheck", () => {
  it("verde con rastro reciente", () => {
    expect(reconcileCheck({ lastTouch: ago(6 * HOUR), now: NOW }).level).toBe("ok");
  });

  it("amarillo —nunca rojo— sin rastro o con rastro viejo", () => {
    // El proxy no puede distinguir "no corrió" de "corrió y no había nada que
    // hacer", y un rojo que se enciende solo en las semanas tranquilas es un
    // rojo que se aprende a ignorar.
    expect(reconcileCheck({ lastTouch: null, now: NOW }).level).toBe("warn");
    expect(reconcileCheck({ lastTouch: ago(5 * DAY), now: NOW }).level).toBe("warn");
  });

  it("dice que es un indicio y que la señal exacta está pedida", () => {
    const result = reconcileCheck({ lastTouch: ago(5 * DAY), now: NOW });
    expect(result.detail).toContain("no deja marca");
    expect(result.detail).toContain("pedida");
  });

  it("el umbral se puede mover", () => {
    expect(reconcileCheck({ lastTouch: ago(40 * HOUR), now: NOW }).level).toBe("warn");
    expect(
      reconcileCheck({ lastTouch: ago(40 * HOUR), staleHours: 72, now: NOW }).level,
    ).toBe("ok");
  });
});

describe("ingestPushCheck", () => {
  it("verde sin pendientes", () => {
    const result = ingestPushCheck({ lastPush: ago(HOUR), pending: 0, now: NOW });
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("por cierre diario");
  });

  it("amarillo con pendientes, y dice que esa plata no está en Actual", () => {
    const result = ingestPushCheck({ lastPush: null, pending: 2, now: NOW });
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("Actual Budget");
    expect(result.lastSeen).toBe("nunca");
  });
});

describe("webhookTrafficCheck", () => {
  it("verde con tráfico reciente", () => {
    expect(webhookTrafficCheck({ lastEvent: ago(2 * HOUR), now: NOW }).level).toBe("ok");
  });

  it("amarillo sin tráfico o con más de tres días", () => {
    expect(webhookTrafficCheck({ lastEvent: null, now: NOW }).level).toBe("warn");
    expect(webhookTrafficCheck({ lastEvent: ago(5 * DAY), now: NOW }).level).toBe("warn");
  });
});

describe("backupCheck", () => {
  it("verde con marca fresca y código 0", () => {
    const result = backupCheck({ lastRun: ago(11 * HOUR), status: 0, now: NOW });
    expect(result.level).toBe("ok");
    expect(result.figure).toBe("11 h");
    // El respaldo local no cubre el modo de falla que importa; se dice.
    expect(result.detail).toContain("BACKUP_OFFSITE_URI");
  });

  it("**rojo exactamente pasadas las 48 horas**", () => {
    // Es el umbral que fija el plan, y es el único renglón de esta pantalla que
    // corresponde a un riesgo sin arreglo posterior.
    expect(BACKUP_RED_HOURS).toBe(48);
    expect(backupCheck({ lastRun: ago(47 * HOUR), status: 0, now: NOW }).level).toBe("ok");
    expect(backupCheck({ lastRun: ago(48 * HOUR), status: 0, now: NOW }).level).toBe("ok");
    expect(
      backupCheck({ lastRun: ago(48 * HOUR + MINUTE), status: 0, now: NOW }).level,
    ).toBe("down");
    expect(backupCheck({ lastRun: ago(72 * HOUR), status: 0, now: NOW }).level).toBe("down");
  });

  it("rojo si el dump falló, aunque la marca sea de hace un minuto", () => {
    // Un respaldo que falló en silencio es igual a no tener respaldo.
    const result = backupCheck({ lastRun: ago(MINUTE), status: 1, now: NOW });
    expect(result.level).toBe("down");
    expect(result.figure).toBe("código 1");
  });

  it("el código malo gana sobre la antigüedad", () => {
    expect(backupCheck({ lastRun: ago(2 * MINUTE), status: 2, now: NOW }).detail).toContain(
      "código 2",
    );
  });

  it("`unknown` cuando la marca no se puede leer, y dice qué falta en el stack", () => {
    // Hoy es el caso por defecto: el servicio `admin` no monta el volumen de
    // respaldos. Pintarlo de verde sería un verde falso sobre el único riesgo
    // sin arreglo del proyecto.
    const result = backupCheck({ lastRun: null, status: null, now: NOW });
    expect(result.level).toBe("unknown");
    expect(result.detail).toContain("gbs_backups:/backups:ro");
    expect(result.lastSeen).toBe("no verificable desde el panel");
  });

  it("con marca pero sin código no se asume que salió bien", () => {
    // `status: null` con marca fresca queda verde por antigüedad, y el detalle
    // no afirma nada del código.
    const result = backupCheck({ lastRun: ago(HOUR), status: null, now: NOW });
    expect(result.level).toBe("ok");
  });
});

describe("parseBackupStamp", () => {
  it("lee el formato de `date -Iseconds` de Alpine, con offset", () => {
    // Es la única parte del proyecto donde `new Date(iso)` es lo correcto: el
    // momento en que corrió el dump **sí** es un instante, y el offset viene en
    // la cadena.
    const parsed = parseBackupStamp("2026-08-31T03:16:41-05:00");
    expect(parsed?.toISOString()).toBe("2026-08-31T08:16:41.000Z");
  });

  it("tolera espacios y saltos de línea del archivo", () => {
    expect(parseBackupStamp("  2026-08-31T03:16:41-05:00\n")).not.toBeNull();
  });

  it("`null` ante ausencia, vacío o basura", () => {
    expect(parseBackupStamp(null)).toBeNull();
    expect(parseBackupStamp("")).toBeNull();
    expect(parseBackupStamp("   \n")).toBeNull();
    expect(parseBackupStamp("ayer")).toBeNull();
  });
});

describe("parseBackupStatus", () => {
  it("lee el código de salida", () => {
    expect(parseBackupStatus("0\n")).toBe(0);
    expect(parseBackupStatus(" 1 ")).toBe(1);
  });

  it("`null` ante ausencia o basura, para no confundirlo con un 0", () => {
    expect(parseBackupStatus(null)).toBeNull();
    expect(parseBackupStatus("")).toBeNull();
    expect(parseBackupStatus("ok")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { parseEaLocalDate } from "@/lib/ea/datetime";
import { describePlan, planBlock, type BlockForm, type BlockPlan } from "./block-resource";

const d = (value: string) => parseEaLocalDate(value);

function form(overrides: Partial<BlockForm> = {}): BlockForm {
  return {
    scope: "profesional",
    providerId: 7,
    kind: "ausencia",
    startDate: d("2026-09-02"),
    endDate: d("2026-09-02"),
    allDay: false,
    startTime: "14:00",
    endTime: "16:00",
    reason: "",
    ...overrides,
  };
}

function planOf(overrides: Partial<BlockForm> = {}) {
  const result = planBlock(form(overrides));
  if (!result.ok) throw new Error(`Se esperaba un plan válido: ${JSON.stringify(result.errors)}`);
  return result;
}

/**
 * Los cuerpos de un plan, ya estrechados al recurso que se espera.
 *
 * `BlockPlan` es una unión discriminada y sus tres ramas tienen cuerpos
 * distintos: sin estrechar, `inputs[0].start` no compila porque una excepción de
 * plan no tiene `start`. Afirmar el recurso acá deja el test legible y, de
 * paso, verifica cuál salió.
 */
function inputsOf<R extends BlockPlan["resource"]>(
  resource: R,
  overrides: Partial<BlockForm> = {},
): Extract<BlockPlan, { resource: R }>["inputs"] {
  const { plan } = planOf(overrides);
  if (plan.resource !== resource) {
    throw new Error(`Se esperaba ${resource} y salió ${plan.resource}`);
  }
  return plan.inputs as Extract<BlockPlan, { resource: R }>["inputs"];
}

// ---------------------------------------------------------------------------
// Los tres casos de la tabla del plan
// ---------------------------------------------------------------------------

describe("los tres casos de § El regalo escondido", () => {
  it("«el estudio cierra el 25 y 26 de diciembre» → blocked_periods", () => {
    const { plan, days } = planOf({
      scope: "estudio",
      providerId: null,
      allDay: true,
      startDate: d("2026-12-25"),
      endDate: d("2026-12-26"),
      reason: "Navidad",
    });

    expect(days).toBe(2);
    expect(plan.resource).toBe("blocked_periods");
    // Un solo registro que abarca los dos días: el estudio cerrado lo está
    // también de noche.
    expect(plan.inputs).toEqual([
      {
        name: "Navidad",
        start: "2026-12-25 00:00:00",
        end: "2026-12-26 23:59:59",
        notes: null,
      },
    ]);
  });

  it("«Lina no está el martes de 2 a 4» → unavailabilities", () => {
    const { plan } = planOf({ reason: "Cita médica" });

    expect(plan.resource).toBe("unavailabilities");
    expect(plan.inputs).toEqual([
      {
        start: "2026-09-02 14:00:00",
        end: "2026-09-02 16:00:00",
        notes: "Cita médica",
        providerId: 7,
      },
    ]);
  });

  it("«Lina el jueves entra a las 11» → working_plan_exceptions", () => {
    const { plan } = planOf({
      kind: "horario",
      startDate: d("2026-09-03"),
      endDate: d("2026-09-03"),
      startTime: "11:00",
      endTime: "19:00",
    });

    expect(plan.resource).toBe("working_plan_exceptions");
    expect(plan.inputs).toEqual([
      {
        startDate: "2026-09-03",
        endDate: "2026-09-03",
        startTime: "11:00",
        endTime: "19:00",
        breaks: [],
        providerId: 7,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Las decisiones que este archivo tomó
// ---------------------------------------------------------------------------

describe("un registro por día, no uno que abarque el rango", () => {
  it("una ausencia de dos días son dos registros del mismo tramo", () => {
    const inputs = inputsOf("unavailabilities", { endDate: d("2026-09-03") });

    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.start)).toEqual([
      "2026-09-02 14:00:00",
      "2026-09-03 14:00:00",
    ]);
    // Y ninguno tapa la noche de por medio.
    expect(inputs.map((i) => i.end)).toEqual([
      "2026-09-02 16:00:00",
      "2026-09-03 16:00:00",
    ]);
  });

  it("un horario excepcional de tres días son tres excepciones borrables aparte", () => {
    const { plan } = planOf({
      kind: "horario",
      endDate: d("2026-09-04"),
      startTime: "11:00",
      endTime: "19:00",
    });

    expect(plan.resource).toBe("working_plan_exceptions");
    expect(plan.inputs).toHaveLength(3);
  });

  it("el cierre del estudio sí es un solo registro", () => {
    const { plan } = planOf({
      scope: "estudio",
      providerId: null,
      allDay: true,
      endDate: d("2026-09-05"),
    });
    expect(plan.inputs).toHaveLength(1);
  });
});

describe("día completo", () => {
  it("una ausencia de todo el día termina un segundo antes de medianoche", () => {
    const inputs = inputsOf("unavailabilities", { allDay: true });
    expect(inputs[0].end).toBe("2026-09-02 23:59:59");
    expect(inputs[0].start).toBe("2026-09-02 00:00:00");
  });

  // Las dos formas "funcionan", pero solo la excepción hace que EA deje de
  // ofrecer horas de esa técnica y solo ella se dibuja como día libre.
  it("un día libre es una excepción de plan con las dos horas en null", () => {
    const { plan } = planOf({ kind: "horario", allDay: true });
    expect(plan.resource).toBe("working_plan_exceptions");
    expect(plan.inputs[0]).toMatchObject({ startTime: null, endTime: null });
  });

  it("con día completo, una hora a medio escribir no frena el envío", () => {
    expect(planBlock(form({ allDay: true, startTime: "1", endTime: null })).ok).toBe(true);
  });
});

describe("motivo", () => {
  it("un cierre sin motivo se llama «Cerrado» en vez de quedar sin nombre", () => {
    const { plan } = planOf({ scope: "estudio", providerId: null, allDay: true, reason: "   " });
    expect(plan.inputs[0]).toMatchObject({ name: "Cerrado" });
  });

  it("una ausencia sin motivo deja las notas en null, no en cadena vacía", () => {
    const { plan } = planOf({ reason: "  " });
    expect(plan.inputs[0]).toMatchObject({ notes: null });
  });
});

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

describe("validación", () => {
  const fail = (overrides: Partial<BlockForm>) => {
    const result = planBlock(form(overrides));
    if (result.ok) throw new Error("Se esperaban errores");
    return result.errors;
  };

  it("una profesional sin elegir es un error del campo, no un throw", () => {
    expect(fail({ providerId: null })).toContainEqual({
      field: "providerId",
      message: "Elegí a quién le aplica.",
    });
  });

  it("el estudio no necesita profesional", () => {
    expect(planBlock(form({ scope: "estudio", providerId: null })).ok).toBe(true);
  });

  it("rechaza el rango de fechas invertido", () => {
    expect(fail({ endDate: d("2026-09-01") })).toContainEqual({
      field: "endDate",
      message: "El fin no puede ser antes del inicio.",
    });
  });

  it("rechaza el rango de horas invertido y el de duración cero", () => {
    expect(fail({ startTime: "16:00", endTime: "14:00" })).toHaveLength(1);
    expect(fail({ startTime: "16:00", endTime: "16:00" })).toHaveLength(1);
  });

  it("rechaza una hora que no es una hora", () => {
    expect(fail({ startTime: "veintipico" }).map((e) => e.field)).toContain("startTime");
    expect(fail({ endTime: "99:99" }).map((e) => e.field)).toContain("endTime");
  });

  it("rechaza una fecha que no es una fecha", () => {
    expect(fail({ startDate: "31/08/2026" as never }).map((e) => e.field)).toContain("startDate");
  });

  // § Piso de accesibilidad pide resumen de errores al enviar: hace falta la
  // lista completa, no el primero que aparezca.
  it("devuelve todos los errores de una, no el primero", () => {
    const errores = fail({ providerId: null, endDate: d("2026-08-01"), endTime: "01:00" });
    expect(errores.map((e) => e.field).sort()).toEqual(["endDate", "endTime", "providerId"]);
  });
});

// ---------------------------------------------------------------------------
// Lo que se le dice a la usuaria
// ---------------------------------------------------------------------------

describe("describePlan", () => {
  it("dice en voz alta lo que el formulario esconde", () => {
    const uno = planOf();
    expect(describePlan(uno.plan, uno.days)).toBe("Se va a registrar 1 ausencia de la profesional.");

    const dos = planOf({ endDate: d("2026-09-03") });
    expect(describePlan(dos.plan, dos.days)).toBe(
      "Se van a registrar 2 ausencias de la profesional.",
    );
  });

  it("pluraliza el horario excepcional sin pegarle una s al final", () => {
    const tres = planOf({ kind: "horario", endDate: d("2026-09-04"), startTime: "11:00" });
    expect(describePlan(tres.plan, tres.days)).toBe(
      "Se van a registrar 3 horarios excepcionales.",
    );
  });

  it("el cierre del estudio se cuenta en días, no en registros", () => {
    const uno = planOf({ scope: "estudio", providerId: null, allDay: true });
    expect(describePlan(uno.plan, uno.days)).toBe("Se va a cerrar el estudio ese día.");

    const varios = planOf({
      scope: "estudio",
      providerId: null,
      allDay: true,
      endDate: d("2026-09-05"),
    });
    expect(describePlan(varios.plan, varios.days)).toBe(
      "Se va a cerrar el estudio 4 días seguidos.",
    );
  });
});

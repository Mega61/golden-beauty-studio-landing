import { describe, expect, it } from "vitest";

import { createCoalescer } from "./coalesce";

/** Un reloj de mentira: `sleep` avanza el reloj y deja correr lo que esperaba. */
function fakeClock() {
  let t = 0;
  const waiters: { at: number; resolve: () => void }[] = [];
  return {
    now: () => t,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        waiters.push({ at: t + ms, resolve });
      }),
    async advance(ms: number) {
      t += ms;
      for (const w of waiters.splice(0)) {
        if (w.at <= t) w.resolve();
        else waiters.push(w);
      }
      // Deja que las continuaciones corran (y vuelvan a dormir si toca).
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

const RECEPCION = { userId: "u-recepcion", name: "Paula Gómez" };
const DUENA = { userId: "u-duena", name: "Andrea" };

describe("createCoalescer", () => {
  it("un cambio solo: sale al cerrarse la ventana, con el estado de antes", async () => {
    const clock = fakeClock();
    const c = createCoalescer<string>({ windowMs: 15_000, ...clock });
    const done = c.settle(7, "jue 10", RECEPCION);
    await clock.advance(14_999);
    expect(c.pending()).toBe(1);
    await clock.advance(1);
    await expect(done).resolves.toEqual({
      first: "jue 10",
      actorUserIds: ["u-recepcion"],
      actorName: "Paula Gómez",
    });
    expect(c.pending()).toBe(0);
  });

  it("mover y deshacer: un solo aviso, que compara contra el primer antes", async () => {
    const clock = fakeClock();
    const c = createCoalescer<string>({ windowMs: 15_000, ...clock });
    const first = c.settle(7, "jue 10", RECEPCION);
    await clock.advance(8_000);
    // El "Deshacer": su antes es el estado movido, pero no es el que cuenta.
    await expect(c.settle(7, "vie 3", DUENA)).resolves.toBeNull();
    // La ventana se alargó desde el segundo cambio.
    await clock.advance(10_000);
    expect(c.pending()).toBe(1);
    await clock.advance(5_000);
    await expect(first).resolves.toEqual({
      first: "jue 10",
      actorUserIds: ["u-recepcion", "u-duena"],
      actorName: "Andrea",
    });
  });

  it("dos citas distintas no se juntan", async () => {
    const clock = fakeClock();
    const c = createCoalescer<string>({ windowMs: 1_000, ...clock });
    const a = c.settle(1, "a", RECEPCION);
    const b = c.settle(2, "b", RECEPCION);
    await clock.advance(1_000);
    await expect(a).resolves.toMatchObject({ first: "a" });
    await expect(b).resolves.toMatchObject({ first: "b" });
  });

  it("un cambio después de cerrada la ventana abre otra", async () => {
    const clock = fakeClock();
    const c = createCoalescer<string>({ windowMs: 1_000, ...clock });
    const a = c.settle(1, "antes", RECEPCION);
    await clock.advance(1_000);
    await expect(a).resolves.toMatchObject({ first: "antes" });
    const b = c.settle(1, "después", RECEPCION);
    expect(c.pending()).toBe(1);
    await clock.advance(1_000);
    await expect(b).resolves.toMatchObject({ first: "después" });
  });
});

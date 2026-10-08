import { contarCitasEnEa, expect, phoneNuevo, queryEa, test } from "./fixtures";

/**
 * La reserva pública, de punta a punta: catálogo → horarios → confirmar.
 *
 * ## Qué es esto y qué no
 *
 * Son las tres rutas **sin sesión** del panel (`/admin/api/public/booking/*`),
 * que es lo que la landing consume por detrás de su formulario de `/reservar`.
 * La pantalla vive en la otra aplicación y no está en este harness; lo que sí
 * está —y es donde se rompen las cosas— es el contrato entre las dos: qué
 * campos manda el panel, qué horarios son de verdad libres, y si confirmar
 * escribe una cita en EA.
 *
 * Es también la única superficie del panel **abierta a internet**. Un cambio
 * que le filtre de más (el correo de una técnica, su plan de trabajo, el
 * teléfono de una clienta) no lo ve ningún unitario de los que existen: cada
 * uno prueba su función, y el que arma la respuesta la arma bien según sus
 * propias suposiciones. Por eso acá se afirma sobre la forma **completa** del
 * objeto que sale, no sobre los campos que se esperaban.
 *
 * ## Sin navegador
 *
 * Se habla por `request` y no por página: no hay pantalla que probar de este
 * lado, y arrancar Chromium para un POST sería pagar diez segundos por nada.
 */

/** Pasado mañana, en el calendario del estudio. Nunca es hoy ni ayer. */
function pasadoMañana(): string {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().slice(0, 10);
}

test.describe("el catálogo público", () => {
  test("lista lo reservable y no filtra nada de las técnicas", async ({ request }) => {
    const res = await request.get("/admin/api/public/booking/catalogo");
    expect(res.status()).toBe(200);

    const body = (await res.json()) as {
      services: Array<Record<string, unknown>>;
      providers: Array<Record<string, unknown>>;
      combos: Array<Record<string, unknown>>;
    };

    expect(body.services.length, "EA no ofreció ningún servicio reservable").toBeGreaterThan(0);
    expect(body.providers.length, "EA no ofreció ninguna técnica").toBeGreaterThan(0);

    // **La forma exacta, no "contiene".** El registro de un provider en EA trae
    // correo, teléfono, dirección, usuario y su plan de trabajo completo; nada
    // de eso tiene por qué salir a internet para que alguien elija con quién ir.
    // Un `toHaveProperty` por campo esperado no detecta el campo de más, que es
    // justo el que hace daño.
    for (const p of body.providers) {
      expect(Object.keys(p).sort()).toEqual(["id", "name", "serviceIds"]);
    }

    for (const s of body.services) {
      expect(Object.keys(s).sort()).toEqual(
        ["category", "durationMin", "id", "isCombo", "name", "priceCOP"].sort(),
      );
    }

    // Los combos viajan aparte para que la landing pueda esconderlos de la
    // lista y llegar a ellos componiendo, igual que la agenda del panel.
    for (const c of body.combos) {
      expect(Object.keys(c).sort()).toEqual(["feetServiceId", "handsServiceId", "serviceId"]);
    }
  });

  test("toda composición que se manda apunta a servicios que sí se pueden reservar", async ({
    request,
  }) => {
    // Una composición que apunte a un servicio que no está en la lista sería un
    // callejón: la landing ofrecería el par y el error saldría recién al pedir
    // los horarios, con la clienta a tres pasos de distancia.
    const body = (await (
      await request.get("/admin/api/public/booking/catalogo")
    ).json()) as {
      services: Array<{ id: number; isCombo: boolean }>;
      combos: Array<{ serviceId: number; handsServiceId: number; feetServiceId: number }>;
    };

    const reservables = new Set(body.services.map((s) => s.id));
    for (const c of body.combos) {
      expect(reservables.has(c.serviceId), `combo ${c.serviceId}`).toBe(true);
      expect(reservables.has(c.handsServiceId), `manos de ${c.serviceId}`).toBe(true);
      expect(reservables.has(c.feetServiceId), `pies de ${c.serviceId}`).toBe(true);
      // Y el combo está marcado como tal, que es lo que la landing usa para
      // sacarlo de la lista.
      expect(body.services.find((s) => s.id === c.serviceId)?.isCombo).toBe(true);
    }
  });
});

test.describe("reservar", () => {
  test("horarios libres y una reserva que llega a EA", async ({ request }) => {
    const marca = `Web${Date.now().toString().slice(-6)}`;
    const fecha = pasadoMañana();

    const catalogo = (await (
      await request.get("/admin/api/public/booking/catalogo")
    ).json()) as { services: Array<{ id: number; isCombo: boolean }> };

    // Un servicio suelto: un combo también se puede reservar, pero lo que se
    // prueba acá es el camino, no la composición (eso es `combos.spec.ts`).
    const servicio = catalogo.services.find((s) => !s.isCombo)!;

    const horarios = await request.get(
      `/admin/api/public/booking/availability?serviceId=${servicio.id}&date=${fecha}`,
    );
    expect(horarios.status()).toBe(200);

    const { slots } = (await horarios.json()) as {
      slots: Array<{ time: string; start: string; end: string; providerIds: number[] }>;
    };
    expect(slots.length, "no hay ni un hueco libre pasado mañana").toBeGreaterThan(0);

    // Cada hueco tiene que traer con quién se puede: sin eso la landing no
    // puede ofrecer "cualquiera" y después asignar a alguien de verdad.
    for (const s of slots) expect(s.providerIds.length).toBeGreaterThan(0);

    const antes = contarCitasEnEa();
    const elegido = slots[0];

    const reserva = await request.post("/admin/api/public/booking/reservar", {
      data: {
        serviceId: servicio.id,
        date: fecha,
        time: elegido.time,
        providerId: null,
        firstName: marca,
        lastName: "Test",
        phone: phoneNuevo(),
        notes: "",
      },
    });

    expect(reserva.status(), await reserva.text()).toBe(201);

    // La forma es plana: la envoltura `{ ok, booking }` que lee la landing la
    // pone su propio proxy, no el panel. Fijarla acá es fijar el contrato entre
    // los dos, que es lo único que este archivo puede fijar.
    const creada = (await reserva.json()) as {
      appointmentId: number;
      provider: { id: number; name: string };
      start: string;
      end: string;
    };
    expect(creada.appointmentId).toBeGreaterThan(0);
    // La clienta nunca se entera de que "cualquiera" fue una decisión nuestra:
    // ve un nombre.
    expect(creada.provider.name).not.toBe("");
    expect(creada.start.startsWith(fecha), creada.start).toBe(true);

    // La afirmación que no se puede falsear.
    expect(contarCitasEnEa()).toBe(antes + 1);
    expect(
      queryEa(
        `SELECT c.first_name FROM ea_appointments a
           JOIN ea_users c ON c.id = a.id_users_customer
          ORDER BY a.id DESC LIMIT 1`,
      ),
    ).toBe(marca);
  });

  test("el mismo hueco dos veces responde 409, no 400", async ({ request }) => {
    // Perder una carrera no es mandar un formulario mal escrito, y la landing
    // reacciona distinto: recarga los horarios y dice "esa se acaba de ir", en
    // vez de marcarle un error a alguien que llenó todo bien.
    const fecha = pasadoMañana();
    const catalogo = (await (
      await request.get("/admin/api/public/booking/catalogo")
    ).json()) as { services: Array<{ id: number; isCombo: boolean }> };
    const servicio = catalogo.services.find((s) => !s.isCombo)!;

    const { slots } = (await (
      await request.get(
        `/admin/api/public/booking/availability?serviceId=${servicio.id}&date=${fecha}`,
      )
    ).json()) as { slots: Array<{ time: string; providerIds: number[] }> };

    // El último hueco del día y una técnica fija: así el segundo intento choca
    // de verdad contra el primero en vez de caer en la otra silla del estudio.
    const elegido = slots[slots.length - 1];
    const cuerpo = (marca: string) => ({
      serviceId: servicio.id,
      date: fecha,
      time: elegido.time,
      providerId: elegido.providerIds[0],
      firstName: marca,
      lastName: "Test",
      phone: phoneNuevo(),
      notes: "",
    });

    const primera = await request.post("/admin/api/public/booking/reservar", {
      data: cuerpo(`Web${Date.now().toString().slice(-6)}`),
    });
    expect(primera.status(), await primera.text()).toBe(201);

    const segunda = await request.post("/admin/api/public/booking/reservar", {
      data: cuerpo(`Web${(Date.now() + 1).toString().slice(-6)}`),
    });
    expect(segunda.status()).toBe(409);
    expect((await segunda.json()).error).toBe("taken");
  });

  test("un cuerpo inválido se rechaza sin tocar EA", async ({ request }) => {
    const antes = contarCitasEnEa();

    for (const data of [
      {},
      { serviceId: 0, date: pasadoMañana(), time: "10:00", firstName: "A", lastName: "B", phone: "3001112233" },
      { serviceId: 1, date: "ayer", time: "10:00", firstName: "A", lastName: "B", phone: "3001112233" },
      // Una hora que no existe en ningún reloj. Antes pasaba la validación y
      // salía como 409 "taken" — una carrera perdida contra una hora imposible.
      { serviceId: 1, date: pasadoMañana(), time: "25:99", firstName: "A", lastName: "B", phone: "3001112233" },
      { serviceId: 1, date: pasadoMañana(), time: "1000", firstName: "A", lastName: "B", phone: "3001112233" },
      // Sin apellido: EA responde 500 a un cliente sin `last_name`, así que el
      // panel tiene que frenarlo antes en vez de traducir mal ese 500.
      { serviceId: 1, date: pasadoMañana(), time: "10:00", firstName: "A", lastName: "", phone: "3001112233" },
    ]) {
      const res = await request.post("/admin/api/public/booking/reservar", { data });
      expect(res.status(), `debería rechazar ${JSON.stringify(data)}`).toBe(400);
    }

    expect(contarCitasEnEa(), "un cuerpo inválido escribió en EA").toBe(antes);
  });
});

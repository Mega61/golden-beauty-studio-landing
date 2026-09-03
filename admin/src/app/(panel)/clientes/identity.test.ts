import { describe, expect, it } from "vitest";

import type { Customer } from "@/lib/ea";
import type { E164 } from "./identity";
import {
  clientKeyToParam,
  displayName,
  isE164,
  looksFabricatedEmail,
  mergeCustomers,
  normalizePhoneE164,
  parseClientKeyParam,
  phoneSearchVariants,
  sameClientKey,
  usableEmail,
} from "./identity";

/**
 * Un E.164 marcado, sin `as` a ciegas: pasa por el mismo normalizador que el
 * código de producción, así que un literal mal escrito en un test se cae acá.
 */
function tel(raw: string): E164 {
  const value = normalizePhoneE164(raw);
  if (value === null) throw new Error(`El fixture "${raw}" no es un E.164 válido.`);
  return value;
}

function customer(patch: Partial<Customer> & { id: number }): Customer {
  return {
    id: patch.id,
    firstName: patch.firstName ?? null,
    lastName: patch.lastName ?? null,
    email: patch.email ?? null,
    phone: patch.phone ?? null,
    address: null,
    city: null,
    zip: null,
    timezone: null,
    language: null,
    customField1: null,
    customField2: null,
    customField3: null,
    customField4: null,
    customField5: null,
    ldapDn: null,
    notes: patch.notes ?? null,
  };
}

describe("normalizePhoneE164", () => {
  it("acepta las formas que la recepción escribe de verdad", () => {
    const esperado = "+573001234567";
    for (const entrada of [
      "3001234567",
      "300 123 4567",
      "300-123-4567",
      " (300) 123 4567 ",
      "+573001234567",
      "+57 300 123 4567",
      "57 300 123 4567",
      "0057 3001234567",
      "57-300-123-4567",
    ]) {
      expect(normalizePhoneE164(entrada), entrada).toBe(esperado);
    }
  });

  it("normaliza un fijo de Bogotá con el indicativo nuevo de diez cifras", () => {
    expect(normalizePhoneE164("(601) 234 5678")).toBe("+576012345678");
  });

  it("respeta un indicativo extranjero explícito en vez de anteponerle 57", () => {
    expect(normalizePhoneE164("+1 305 555 0123")).toBe("+13055550123");
  });

  it("devuelve null para todo lo que no puede servir de llave", () => {
    for (const basura of [
      "",
      "   ",
      "N/A",
      "sin teléfono",
      "no tiene",
      "3001234567 ext 210",
      "1234",
      "300123456", // nueve dígitos: no es un número nacional
      "0300123456", // ningún indicativo empieza en cero
      "+00123456789",
      "1234567890123456", // dieciséis dígitos: fuera de E.164
      null,
      undefined,
    ]) {
      expect(normalizePhoneE164(basura), String(basura)).toBeNull();
    }
  });

  it("no se inventa dígitos: un número con letras se descarta entero", () => {
    // Quedarse con los dígitos daría "+573001234567" y una llave falsa que
    // fusionaría dos personas distintas.
    expect(normalizePhoneE164("Cel 300 123 4567 casa")).toBeNull();
  });

  it("permite cambiar el indicativo por defecto sin tocar el resto", () => {
    expect(normalizePhoneE164("3001234567", "52")).toBe("+523001234567");
  });
});

describe("isE164", () => {
  it("reconoce lo que produce el normalizador y nada más", () => {
    expect(isE164("+573001234567")).toBe(true);
    expect(isE164("573001234567")).toBe(false);
    expect(isE164("+0573001234567")).toBe(false);
    expect(isE164(573001234567)).toBe(false);
  });
});

describe("la llave de la ficha", () => {
  it("va y vuelve sin el + , que en un path se convierte en espacio", () => {
    const key = { kind: "tel", phone: tel("+573001234567") } as const;
    const param = clientKeyToParam(key);
    expect(param).toBe("573001234567");
    expect(parseClientKeyParam(param)).toEqual(key);
  });

  it("distingue una clienta sin teléfono, que no se puede deduplicar", () => {
    const key = { kind: "ea", eaCustomerId: 482 } as const;
    expect(clientKeyToParam(key)).toBe("ea-482");
    expect(parseClientKeyParam("ea-482")).toEqual(key);
  });

  it("rechaza un segmento que no es ninguna de las dos formas", () => {
    for (const basura of ["", "ea-", "ea-0", "abc", "12345", "+573001234567"]) {
      expect(parseClientKeyParam(basura), basura).toBeNull();
    }
  });

  it("compara llaves de la misma clase y de clases distintas", () => {
    const uno = { kind: "tel", phone: tel("+573001234567") } as const;
    const otro = { kind: "tel", phone: tel("+573009999999") } as const;
    const ea = { kind: "ea", eaCustomerId: 1 } as const;
    expect(sameClientKey(uno, uno)).toBe(true);
    expect(sameClientKey(uno, otro)).toBe(false);
    expect(sameClientKey(uno, ea)).toBe(false);
    expect(sameClientKey(ea, { kind: "ea", eaCustomerId: 1 })).toBe(true);
    expect(sameClientKey(ea, { kind: "ea", eaCustomerId: 2 })).toBe(false);
  });
});

describe("phoneSearchVariants", () => {
  it("cubre las formas en que un número colombiano puede estar escrito en EA", () => {
    const variantes = phoneSearchVariants(tel("+573001234567"));
    expect(variantes).toEqual(
      expect.arrayContaining([
        "+573001234567",
        "573001234567",
        "3001234567",
        "300 123 4567",
        "300-123-4567",
        "300 1234567",
      ]),
    );
  });

  it("no duplica variantes", () => {
    const variantes = phoneSearchVariants(tel("+573001234567"));
    expect(new Set(variantes).size).toBe(variantes.length);
  });

  it("con un número extranjero se queda con lo que sabe, sin inventar formatos", () => {
    expect(phoneSearchVariants(tel("+13055550123"))).toEqual([
      "+13055550123",
      "13055550123",
    ]);
  });
});

describe("looksFabricatedEmail", () => {
  it("marca las formas que producía el flujo viejo", () => {
    for (const falso of [
      "noreply@goldenbeautystudio.com.co",
      "sin-correo@gbs.com",
      "na@algo.com",
      "3001234567@correo.com",
      "+573001234567@correo.com",
      "alguien@example.com",
      "alguien@estudio.local",
      "alguien@algo.invalid",
      "no-es-un-correo",
      "arroba@",
    ]) {
      expect(looksFabricatedEmail(falso), falso).toBe(true);
    }
  });

  it("no marca un correo real, que es el error caro", () => {
    for (const bueno of [
      "maria.gonzalez@gmail.com",
      "nataly@hotmail.com",
      "test.driver@empresa.com.co",
      "nadie1990@yahoo.es",
    ]) {
      expect(looksFabricatedEmail(bueno), bueno).toBe(false);
    }
  });

  it("un campo vacío no es un correo inventado: es un campo vacío", () => {
    expect(looksFabricatedEmail("")).toBe(false);
    expect(looksFabricatedEmail("   ")).toBe(false);
    expect(looksFabricatedEmail(null)).toBe(false);
    expect(looksFabricatedEmail(undefined)).toBe(false);
  });

  it("usableEmail devuelve null en vez de un correo de relleno, y nunca inventa uno", () => {
    expect(usableEmail("maria@gmail.com")).toBe("maria@gmail.com");
    expect(usableEmail(" maria@gmail.com ")).toBe("maria@gmail.com");
    expect(usableEmail("noreply@x.com")).toBeNull();
    expect(usableEmail("")).toBeNull();
    expect(usableEmail(null)).toBeNull();
    expect(usableEmail(undefined)).toBeNull();
  });
});

describe("displayName", () => {
  it("arma el nombre con lo que haya, sin rellenar", () => {
    expect(displayName({ firstName: "María", lastName: "González" })).toBe("María González");
    expect(displayName({ firstName: "María", lastName: null })).toBe("María");
    expect(displayName({ firstName: "  ", lastName: "González" })).toBe("González");
    expect(displayName({ firstName: null, lastName: null })).toBe("");
  });
});

describe("mergeCustomers — el caso que define el paquete", () => {
  it("dos clientas con el mismo teléfono se resuelven a una", () => {
    const filas = [
      customer({ id: 10, firstName: "Maria", phone: "3001234567" }),
      customer({
        id: 42,
        firstName: "María",
        lastName: "González",
        phone: "+57 300 123 4567",
      }),
    ];

    const [clienta, ...resto] = mergeCustomers(filas);

    expect(resto).toHaveLength(0);
    expect(clienta.merged).toBe(true);
    expect(clienta.phone).toBe("+573001234567");
    expect(clienta.eaCustomerIds).toEqual([10, 42]);
    // Gana el nombre más completo, no el primero ni el último.
    expect(clienta.name).toBe("María González");
    expect(clienta.key).toEqual({ kind: "tel", phone: "+573001234567" });
  });

  it("ninguna queda con correo inventado", () => {
    const [clienta] = mergeCustomers([
      customer({ id: 1, firstName: "Ana", phone: "3001234567", email: "3001234567@relleno.com" }),
      customer({ id: 2, firstName: "Ana", phone: "3001234567", email: "" }),
    ]);

    expect(clienta.email).toBeNull();
    // Pero el relleno no desaparece: alguien lo tiene que limpiar en EA.
    expect(clienta.suspiciousEmails).toEqual(["3001234567@relleno.com"]);
  });

  it("el correo real gana sobre el de relleno aunque llegue después", () => {
    const [clienta] = mergeCustomers([
      customer({ id: 1, firstName: "Ana", phone: "3001234567", email: "noreply@x.com" }),
      customer({ id: 2, firstName: "Ana", phone: "3001234567", email: "ana@gmail.com" }),
    ]);
    expect(clienta.email).toBe("ana@gmail.com");
    expect(clienta.suspiciousEmails).toEqual(["noreply@x.com"]);
  });

  it("NO fusiona por nombre a dos clientas sin teléfono", () => {
    // Dos "María González" distintas con la historia de las dos sería un error
    // invisible: la ficha resultante se ve perfecta.
    const resueltas = mergeCustomers([
      customer({ id: 1, firstName: "María", lastName: "González" }),
      customer({ id: 2, firstName: "María", lastName: "González" }),
    ]);

    expect(resueltas).toHaveLength(2);
    expect(resueltas.map((c) => c.key)).toEqual([
      { kind: "ea", eaCustomerId: 1 },
      { kind: "ea", eaCustomerId: 2 },
    ]);
    expect(resueltas.every((c) => c.merged === false)).toBe(true);
    expect(resueltas.every((c) => c.phone === null)).toBe(true);
  });

  it("un teléfono que no normaliza no fusiona nada", () => {
    const resueltas = mergeCustomers([
      customer({ id: 1, firstName: "Ana", phone: "sin teléfono" }),
      customer({ id: 2, firstName: "Bea", phone: "sin teléfono" }),
    ]);
    expect(resueltas).toHaveLength(2);
  });

  it("conserva el orden de primera aparición", () => {
    const resueltas = mergeCustomers([
      customer({ id: 5, firstName: "Zoe", phone: "3005555555" }),
      customer({ id: 1, firstName: "Ana", phone: "3001111111" }),
      customer({ id: 9, firstName: "Zoe", phone: "3005555555" }),
    ]);
    expect(resueltas.map((c) => c.name)).toEqual(["Zoe", "Ana"]);
  });

  it("a igual completitud de nombre gana la fila más reciente", () => {
    const [clienta] = mergeCustomers([
      customer({ id: 1, firstName: "Marcela", lastName: "Ruiz", phone: "3001234567" }),
      customer({ id: 7, firstName: "Marcela", lastName: "Ruiz de Pérez", phone: "3001234567" }),
    ]);
    expect(clienta.name).toBe("Marcela Ruiz de Pérez");
  });

  it("concatena las notas distintas en vez de perder una al fusionar", () => {
    const [clienta] = mergeCustomers([
      customer({ id: 1, firstName: "Ana", phone: "3001234567", notes: "Alérgica al acrílico" }),
      customer({ id: 2, firstName: "Ana", phone: "3001234567", notes: "Alérgica al acrílico" }),
      customer({ id: 3, firstName: "Ana", phone: "3001234567", notes: "Prefiere tonos nude" }),
    ]);
    expect(clienta.notes).toBe("Alérgica al acrílico · Prefiere tonos nude");
  });

  it("una lista vacía devuelve una lista vacía", () => {
    expect(mergeCustomers([])).toEqual([]);
  });
});

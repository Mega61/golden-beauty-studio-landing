/**
 * Lo que se escribió en el buscador de clientas, repartido en los campos del
 * alta rápida.
 *
 * Existe para que **nada se teclee dos veces**. El caso más común del mostrador
 * es alguien que llama y no está en la agenda: se escribe su nombre en el
 * buscador, no aparece, y se abre el alta. Si ese formulario apareciera vacío
 * —debajo del nombre que se acaba de escribir— el paso siguiente no es
 * escribirlo otra vez: es apuntarlo en un papel y no agendar nada.
 *
 * Vive en su propio archivo, sin React, porque el formulario que lo usa importa
 * Server Actions y un test que lo importara de ahí arrastraría el cliente de
 * base de datos a Vitest para probar una función de cinco líneas.
 */

export type NombreRepartido = {
  nombre: string;
  apellido: string;
  telefono: string;
};

/**
 * Un término con dígitos y sin letras es un teléfono; cualquier otra cosa es un
 * nombre, que se parte en el **primer** espacio.
 *
 * "Ana María Ríos" queda "Ana" + "María Ríos". Es una suposición imperfecta a
 * propósito: los dos campos quedan a la vista y editables, así que corregirla
 * cuesta un clic. Lo que no se puede es partirla **escondida en el servidor**
 * sobre un campo único, que es lo que hacía antes `splitName()` — ahí el error
 * no se veía y quedaba en la ficha de una persona real para siempre.
 */
export function splitTermino(termino: string): NombreRepartido {
  const limpio = termino.trim().replace(/\s+/g, " ");
  if (limpio === "") return { nombre: "", apellido: "", telefono: "" };

  // Sin letras y con al menos un dígito: es un número, no un nombre. Se exige
  // el dígito para que un término de puro ruido —`"---"`— no se cuele como
  // teléfono y deje los dos campos del nombre vacíos sin explicación.
  if (/^[\d+()\s-]+$/.test(limpio) && /\d/.test(limpio)) {
    return { nombre: "", apellido: "", telefono: limpio };
  }

  const space = limpio.indexOf(" ");
  return space === -1
    ? { nombre: limpio, apellido: "", telefono: "" }
    : { nombre: limpio.slice(0, space), apellido: limpio.slice(space + 1), telefono: "" };
}

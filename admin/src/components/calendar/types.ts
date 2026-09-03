/**
 * Lo que la grilla necesita saber de una cita **además** de la cita.
 *
 * `Appointment` de A1 trae ids, no nombres: `customerId`, `serviceId`. Poner
 * "Marcela · Acrílicas" en el bloque necesita las dos relaciones, y pedirlas
 * cita por cita sería el N+1 que `with=service,provider,customer` existe para
 * evitar (§ Sistema visual: además es la única forma de leer el color del
 * servicio, que la API v1 no devuelve por `GET /services`).
 *
 * Se separa del `Appointment` en vez de extenderlo porque el motor de B3 recibe
 * `Appointment` y no tiene por qué enterarse de que hay nombres: la geometría
 * no cambia porque la clienta se llame distinto.
 */

export type AppointmentMeta = {
  /** Nombre de la clienta, ya compuesto. `null` si la cita no tiene clienta. */
  customer: string | null;
  service: string | null;
  /**
   * El color del servicio tal como lo guarda EA, sin tocar. Lo convierte en
   * algo legible `serviceTint()`; guardarlo crudo deja el dato intacto para
   * quien lo necesite de otra forma.
   */
  serviceColor: string | null;
  /** Teléfono en E.164, para el detalle. La identidad de la clienta. */
  phone: string | null;
};

/** Metadatos por id de cita. Un objeto plano: cruza el borde servidor→cliente. */
export type MetaIndex = Readonly<Record<number, AppointmentMeta>>;

/** Una técnica, como la ve la pantalla. */
export type ProviderOption = {
  id: number;
  name: string;
};

/** Un servicio, como lo ve el formulario de cita. */
export type ServiceOption = {
  id: number;
  name: string;
  /** Minutos. Prellena el fin al elegir el servicio. */
  duration: number | null;
  attendantsNumber: number | null;
};

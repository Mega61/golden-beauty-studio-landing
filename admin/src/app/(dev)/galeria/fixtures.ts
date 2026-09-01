import type { Column } from "@/components/ui";

/**
 * Datos de mentira para la galería.
 *
 * Contenido **real, no lorem**: nombres colombianos de largo variable,
 * servicios del catálogo de verdad y montos con la magnitud que tienen los
 * pesos. Un kit revisado con "Lorem ipsum" y "$1.00" se ve impecable y después
 * revienta con "María Fernanda Gutiérrez Ospina" y "$ 1.350.000".
 */

export type CitaDemo = {
  id: string;
  clienta: string;
  hora: string;
  fin: string;
  tecnica: string;
  servicio: string;
  totalCOP: number;
  estado: string;
};

export const CITAS: CitaDemo[] = [
  {
    id: "1",
    clienta: "Marcela Ríos",
    hora: "2026-08-31 09:00:00",
    fin: "2026-08-31 11:00:00",
    tecnica: "Lina",
    servicio: "Acrílicas esculpidas",
    totalCOP: 180000,
    estado: "Confirmada",
  },
  {
    id: "2",
    clienta: "María Fernanda Gutiérrez Ospina",
    hora: "2026-08-31 11:15:00",
    fin: "2026-08-31 12:30:00",
    tecnica: "Daniela",
    servicio: "Semipermanente + diseño a mano alzada",
    totalCOP: 1350000,
    estado: "Reservada",
  },
  {
    id: "3",
    clienta: "Ana",
    hora: "2026-08-31 13:00:00",
    fin: "2026-08-31 14:00:00",
    tecnica: "Lina",
    servicio: "Press on",
    totalCOP: 95000,
    estado: "Completada",
  },
  {
    id: "4",
    clienta: "Juliana Betancur",
    hora: "2026-08-31 14:30:00",
    fin: "2026-08-31 15:30:00",
    tecnica: "Sara",
    servicio: "Retiro + manicura rusa",
    totalCOP: 120000,
    estado: "Cancelada",
  },
  {
    id: "5",
    clienta: "Paola Sánchez",
    hora: "2026-08-31 16:00:00",
    fin: "2026-08-31 17:30:00",
    tecnica: "Daniela",
    servicio: "Forrado + 3 diseños",
    totalCOP: 210000,
    estado: "No asistió",
  },
  {
    id: "6",
    clienta: "Verónica Ocampo",
    hora: "2026-08-31 18:00:00",
    fin: "2026-08-31 19:00:00",
    tecnica: "Sara",
    servicio: "Pedicura spa",
    // Un estado que el panel no conoce: así se ve cuando alguien renombra la
    // lista desde la interfaz de EA.
    totalCOP: 140000,
    estado: "Rescheduled",
  },
];

export type ColumnasDemo = Column<CitaDemo>[];

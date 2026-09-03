import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell";

import { ComisionesVista } from "../ComisionesVista";
import { CASOS, fixtureComisionesView, parseCaso } from "./fixtures";

/**
 * `/admin/comisiones/vista-previa` — la quincena con datos de mentira.
 *
 * Existe por lo mismo que la vista previa de Caja y la de Reportes: la pantalla
 * se revisa a 390, 768 y 1440 px, y para pintar una quincena con bloqueos, un
 * combo repartido entre dos técnicas y una liquidación ya pagada harían falta
 * MySQL, EA y quince días de jornada sembrada. Los estados que hay que poder
 * mirar son justamente los que no se pueden provocar a mano en una base limpia.
 *
 * Los cinco casos, con `?caso=`:
 *
 * | Caso | Qué se ve |
 * | --- | --- |
 * | `bloqueada` (default) | Dos días de caja sin cerrar y un renglón sin regla: la revisión bloqueada, y una cuenta cerrada sin comisión |
 * | `lista` | Todo revisado: el botón de pagar, con su confirmación en el sitio |
 * | `pagada` | La quincena de una técnica cerrada, la de la otra en borrador |
 * | `vacia` | La quincena sin calcular |
 * | `tecnica` | Lo que ve una técnica: su liquidación y la de nadie más, sin botones |
 *
 * **No sale a producción.** Son liquidaciones inventadas, y en la pantalla con
 * la que se decide un pago un dato falso indistinguible de uno verdadero es
 * exactamente el error que no se puede cometer. `notFound()` en producción lo
 * deja fuera, y como `NODE_ENV` se resuelve en el build, la rama no queda ni en
 * el bundle.
 *
 * Los botones **no están cableados a nada distinto** de la pantalla real: son
 * los mismos de `ComisionesAcciones`, así que apretarlos llama a la Server
 * Action de verdad y ésta rebota por permisos o por configuración. Se dibuja el
 * control, no se simula la escritura — un botón de mentira no prueba nada del
 * real.
 */

export const metadata: Metadata = {
  title: "Comisiones · banco de pruebas",
  robots: { index: false, follow: false },
};

/**
 * Dinámica por lo mismo que los otros bancos de pruebas: prerenderizada, el
 * `notFound()` del build queda guardado como página estática y cacheada.
 */
export const dynamic = "force-dynamic";

export default async function VistaPreviaComisiones({
  searchParams,
}: {
  searchParams: Promise<{ caso?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const { caso } = await searchParams;
  const elegido = parseCaso(caso);
  const view = fixtureComisionesView(elegido);

  return (
    <AppShell
      role={elegido === "tecnica" ? "staff" : "owner"}
      title="Comisiones (banco de pruebas)"
    >
      <div style={{ display: "grid", gap: "1rem" }}>
        <nav
          aria-label="Casos del banco de pruebas"
          style={{
            display: "flex",
            gap: "0.75rem",
            flexWrap: "wrap",
            fontSize: "var(--text-2xs)",
          }}
        >
          {CASOS.map((c) => (
            <Link
              key={c}
              href={`/comisiones/vista-previa?caso=${c}`}
              style={
                c === elegido ? { fontWeight: 600, color: "var(--color-gold-dark)" } : undefined
              }
            >
              {c}
            </Link>
          ))}
        </nav>
        <ComisionesVista view={view} />
      </div>
    </AppShell>
  );
}

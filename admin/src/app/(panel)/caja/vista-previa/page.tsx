import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell";

import { CajaVista } from "../CajaVista";
import { CASOS, fixtureCajaView, parseCaso } from "./fixtures";

/**
 * `/admin/caja/vista-previa` — Caja con un día de mentira.
 *
 * Existe por lo mismo que `/admin/agenda/vista-previa` y `/admin/hoy/demo`: la
 * pantalla se revisa a 390, 768 y 1440 px, y para pintar un día con pendientes
 * de verdad hacen falta EA, MySQL y una jornada sembrada. El estado que hay que
 * poder mirar —**la lista de pendientes con el cierre bloqueado**— es
 * justamente el que no se puede provocar a mano en una base limpia.
 *
 * Los cuatro casos, con `?caso=`:
 *
 * | Caso | Qué se ve |
 * | --- | --- |
 * | `pendientes` (default) | Una cita atendida sin cuenta y una cuenta sin método: el cierre bloqueado por los dos motivos |
 * | `limpio` | Nada pendiente y el botón de cerrar habilitado |
 * | `cerrado` | El día ya cerrado, su lote sin empujar, y un cierre anterior también pendiente |
 * | `sin-agenda` | EA sin responder: solo lectura, cuentas visibles, cierre bloqueado |
 *
 * **No sale a producción.** Son cuentas y clientas inventadas, y en la pantalla
 * con la que se decide si la caja cuadra un dato falso indistinguible de uno
 * verdadero es exactamente el error que no se puede cometer. `notFound()` en
 * producción lo deja fuera.
 *
 * Los botones **no están cableados a nada distinto** de la pantalla real: son
 * los mismos de `CajaAcciones`, así que apretarlos llama a la Server Action de
 * verdad y ésta rebota por permisos o por configuración. Se dibuja el control,
 * no se simula la escritura — un botón de mentira no prueba nada del real.
 */

export const metadata: Metadata = {
  title: "Caja · banco de pruebas",
  robots: { index: false, follow: false },
};

/**
 * Dinámica por lo mismo que el banco de pruebas de C2: prerenderizada, el
 * `notFound()` del build queda guardado como página estática y cacheada.
 */
export const dynamic = "force-dynamic";

export default async function VistaPreviaPage({
  searchParams,
}: {
  searchParams: Promise<{ caso?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const { caso } = await searchParams;
  const elegido = parseCaso(caso);
  const view = fixtureCajaView(elegido);

  return (
    <AppShell
      role="reception"
      title="Caja (banco de pruebas)"
      readOnly={
        elegido === "sin-agenda"
          ? {
              reason:
                // Sin punto final y sin "así que": `ReadOnlyBand` cierra la
                // frase por su cuenta con ", así que por ahora no se puede
                // crear ni modificar nada".
                "No se pudo leer la agenda y el cierre del día queda bloqueado",
            }
          : undefined
      }
    >
      <div style={{ display: "grid", gap: "1rem" }}>
        <nav
          aria-label="Casos del banco de pruebas"
          style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", fontSize: "var(--text-2xs)" }}
        >
          {CASOS.map((c) => (
            <Link
              key={c}
              href={`/caja/vista-previa?caso=${c}`}
              style={c === elegido ? { fontWeight: 600, color: "var(--color-gold-dark)" } : undefined}
            >
              {c}
            </Link>
          ))}
        </nav>
        <CajaVista view={view} />
      </div>
    </AppShell>
  );
}

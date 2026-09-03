import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell";
import { DemoHarness } from "./DemoHarness";

/**
 * `/admin/hoy/demo` — la hoja de "Cerrar servicio" con datos de mentira.
 *
 * Existe porque esta pantalla **se revisa en un celular de verdad** y el resto
 * del panel necesita EA y MySQL levantados para pintar una sola cita. Con esto
 * se puede abrir a 390 px, cerrar la cuenta del caso del plan y —lo que más
 * importa— comprobar el borrador local con la red caída, sin montar el stack.
 *
 * **No sale a producción.** A diferencia de `/admin/galeria`, que es una
 * referencia viva y por eso se publica detrás de la auth del panel, esto son
 * citas y clientas inventadas: en la pantalla de "Hoy" de un estudio real, un
 * dato falso indistinguible de uno verdadero es exactamente el error que no se
 * puede cometer. `notFound()` en producción lo deja fuera del build.
 */

export const metadata: Metadata = {
  title: "Cerrar servicio · banco de pruebas",
};

/**
 * Sin esto la ruta se **prerenderiza** y el `notFound()` del build queda
 * guardado como una página estática y cacheada (`x-nextjs-cache: HIT`).
 * Dinámica, el `notFound()` se evalúa por petición y nada del banco de pruebas
 * queda horneado en la imagen.
 *
 * ⚠ **Verificado contra el `server.js` de standalone: la respuesta sale con
 * 200, no con 404**, en las dos formas. El cuerpo es la página de "no existe"
 * —cero coincidencias de "Banco de pruebas"—, así que el contenido no se sirve;
 * lo que no queda bien es el código de estado. Next 16 parece comprometer los
 * encabezados antes de resolver el `notFound()` de la página. No se persiguió
 * más porque el arreglo limpio (excluir la ruta del build) vive en
 * `next.config.ts`, que es de otro paquete. Queda reportado.
 */
export const dynamic = "force-dynamic";

export default function DemoPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <AppShell role="staff" title="Hoy (demo)">
      <DemoHarness />
    </AppShell>
  );
}

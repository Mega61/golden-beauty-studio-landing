import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui";
import { listTotpLoginCandidates, type TotpLoginCandidate } from "@/lib/auth";
import { verifySession } from "@/lib/dal";
import { entrarConWorkspace } from "./actions";
import { TotpForm } from "./TotpForm";

/**
 * La pantalla de entrada.
 *
 * Los dos caminos conviven en una sola tarjeta, y el orden es el de la
 * frecuencia real: la dueña y la recepción entran con Workspace, y las técnicas
 * — que entran más seguido y desde el celular — tocan su nombre. Una pantalla
 * con un selector "¿cómo quieres entrar?" agregaría un paso a las dos.
 *
 * Es la **segunda y última** pantalla del panel con Cormorant (la otra es el
 * wordmark del shell). Acá la marca todavía está haciendo su trabajo: es lo
 * primero que se ve a las nueve de la mañana. De la sesión en adelante, la
 * interfaz sirve a la tarea y desaparece.
 */

export const metadata: Metadata = {
  title: "Entrar · Panel",
  robots: { index: false, follow: false },
};

/**
 * Nunca estática y nunca cacheada: lee la sesión y la lista del equipo, y las
 * dos cambian sin que el build se entere.
 */
export const dynamic = "force-dynamic";

const MENSAJES: Record<string, string> = {
  acceso_denegado:
    "Esa cuenta no tiene acceso al panel. Si debería tenerlo, pedile a la dueña que la agregue desde Equipo.",
  configuracion:
    "El panel no pudo hablar con Google. Es un problema de configuración, no tuyo: avisale a quien administra el sistema.",
};

export default async function EntrarPage({
  searchParams,
}: {
  // En Next 16 `searchParams` es una promesa: la página se renderiza antes de
  // que se resuelvan, y esperarla es lo que la marca como dinámica.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Quien ya tiene sesión no ve el login. Sin esto, volver atrás desde el panel
  // muestra un formulario de entrada a alguien que ya entró.
  if (await verifySession()) redirect("/");

  const params = await searchParams;
  const errorCode = typeof params.error === "string" ? params.error : null;
  const mensaje = errorCode
    ? (MENSAJES[errorCode] ??
      "No pudimos completar la entrada. Vuelve a intentar.")
    : null;

  // Si `mysql-transversal` no responde, la grilla no se puede armar — pero el
  // botón de Workspace sí funciona, porque su primer paso es un redirect a
  // Google. Caer entera acá dejaría a la dueña sin poder entrar a diagnosticar
  // justo cuando algo está roto.
  let equipo: TotpLoginCandidate[] = [];
  let equipoCaido = false;
  try {
    equipo = await listTotpLoginCandidates();
  } catch {
    equipoCaido = true;
  }

  return (
    <div
      className="ui-card"
      style={{ display: "grid", gap: "1.5rem", padding: "1.75rem 1.5rem" }}
    >
      <header style={{ display: "grid", gap: "0.25rem" }}>
        <span
          className="ui-wordmark"
          style={{ fontSize: "1.625rem", display: "block" }}
        >
          Golden Beauty
        </span>
        <p style={{ color: "var(--color-ink-soft)", fontSize: "var(--text-sm)" }}>
          Panel del estudio
        </p>
      </header>

      {mensaje ? (
        <p
          role="alert"
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--color-error-ink)",
            background: "var(--color-error-tint)",
            border: "1px solid var(--color-error-line)",
            borderRadius: "var(--radius-md)",
            padding: "0.625rem 0.75rem",
          }}
        >
          {mensaje}
        </p>
      ) : null}

      <form action={entrarConWorkspace}>
        <Button type="submit" variant="primary" block>
          Entrar con la cuenta del estudio
        </Button>
      </form>

      {equipo.length > 0 ? (
        <>
          <div
            aria-hidden
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto 1fr",
              alignItems: "center",
              gap: "0.75rem",
              color: "var(--color-ink-mute)",
              fontSize: "var(--text-2xs)",
            }}
          >
            <span style={{ height: 1, background: "var(--hair)" }} />
            <span>o</span>
            <span style={{ height: 1, background: "var(--hair)" }} />
          </div>
          <TotpForm people={equipo} />
        </>
      ) : null}

      {equipoCaido ? (
        <p style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
          La entrada por código no está disponible en este momento.
        </p>
      ) : null}
    </div>
  );
}

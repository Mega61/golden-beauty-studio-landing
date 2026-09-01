import type { Metadata } from "next";

import { Button, ButtonLink } from "@/components/ui";
import { verifySession } from "@/lib/dal";
import { salir } from "../entrar/actions";

/**
 * Cerrar sesión, con una confirmación.
 *
 * **Por qué una pantalla y no un enlace.** Salir por `GET` significa que
 * cualquier imagen o enlace de otra página puede desloguear a la recepcionista
 * en medio de un cobro; es CSRF de bajo daño, pero gratis de evitar. Acá el
 * gesto es un `POST` de un formulario, y de paso queda un lugar al que el shell
 * puede enlazar con un `<a>` común desde el menú "Más".
 *
 * También es el único sitio donde alguien puede verificar con quién está
 * entrado, que en un mesón compartido entre tres personas no es un detalle.
 */

export const metadata: Metadata = {
  title: "Cerrar sesión · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function SalirPage() {
  const session = await verifySession();

  return (
    <div
      className="ui-card"
      style={{ display: "grid", gap: "1.25rem", padding: "1.75rem 1.5rem" }}
    >
      <h1 style={{ fontSize: "var(--text-lg)", color: "var(--color-carbon)" }}>
        {session ? "¿Cerrás la sesión?" : "No hay ninguna sesión abierta"}
      </h1>

      {session ? (
        <>
          <p style={{ color: "var(--color-ink-soft)" }}>
            Estás entrada como <strong>{session.name}</strong> ({session.email}).
          </p>
          <form action={salir} style={{ display: "grid", gap: "0.5rem" }}>
            <Button type="submit" variant="danger" block>
              Cerrar sesión
            </Button>
            <ButtonLink href="/" variant="ghost" block>
              Volver al panel
            </ButtonLink>
          </form>
        </>
      ) : (
        <ButtonLink href="/entrar" variant="primary" block>
          Entrar
        </ButtonLink>
      )}
    </div>
  );
}

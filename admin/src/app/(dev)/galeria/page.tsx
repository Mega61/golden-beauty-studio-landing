import { AppShell } from "@/components/shell";
import { ButtonLink } from "@/components/ui";
import { Gallery } from "./Gallery";

/**
 * Galería de componentes — `/admin/galeria`.
 *
 * Es la superficie con la que un humano valida el paquete A3, y por eso vive
 * **dentro del shell de verdad**, no en una página suelta: la mitad de lo que
 * hay que revisar es cómo se comportan la barra lateral, el riel y la barra
 * inferior, y eso no se ve en un lienzo en blanco.
 *
 * Se revisa a 390 / 768 / 1440 px. Qué mirar en cada ancho:
 *
 * - **390** — barra inferior con cinco casillas y área segura respetada, la
 *   tabla convertida en lista de dos líneas, el panel entrando desde abajo, y
 *   cero scroll horizontal en la página.
 * - **768** — riel de solo iconos, tabla con las columnas prioritarias
 *   (Servicio desaparece), panel entrando por el costado.
 * - **1440** — barra lateral con etiquetas, tabla completa, panel persistente.
 *
 * El rol se puede cambiar por query (`?rol=staff`) para ver cómo se encoge la
 * navegación: la técnica solo tiene tres destinos y la barra inferior queda con
 * tres casillas en vez de rellenarse con algo que no puede abrir.
 *
 * **Sigue publicada en producción a propósito**, detrás de la auth del panel:
 * es la referencia que abre quien vaya a construir una pantalla nueva, y una
 * galería que solo existe en desarrollo se desactualiza sin que nadie lo note.
 * Si algún día molesta, el interruptor natural es el DAL del paquete B2 —
 * restringirla a `owner`— y no un `NODE_ENV`.
 */

export const metadata = {
  title: "Galería de componentes · Panel",
};

type Rol = "owner" | "reception" | "staff";

const ROLES: ReadonlyArray<[Rol, string]> = [
  ["owner", "dueña"],
  ["reception", "recepción"],
  ["staff", "técnica"],
];

function parseRol(value: string | undefined): Rol {
  return value === "staff" || value === "reception" ? value : "owner";
}

export default async function GaleriaPage({
  searchParams,
}: {
  // En Next 16 los parámetros de la petición son asíncronos.
  searchParams: Promise<{ rol?: string }>;
}) {
  const { rol } = await searchParams;
  const role = parseRol(rol);

  return (
    <AppShell
      role={role}
      title="Galería de componentes"
      actions={ROLES.map(([value, label]) => (
        <ButtonLink
          key={value}
          href={`?rol=${value}`}
          size="sm"
          variant={role === value ? "primary" : "ghost"}
          aria-current={role === value ? "true" : undefined}
        >
          {label}
        </ButtonLink>
      ))}
    >
      <Gallery />
    </AppShell>
  );
}

import Link from "next/link";
import { Icon } from "../ui/Icon";

/**
 * Volver, arriba a la izquierda de la toolbar: donde el pulgar lo busca en
 * cualquier app.
 *
 * Reemplaza al "← Clientes" en letra de 12 px que las fichas traían sobre el
 * contenido. Es un enlace a la lista (no `history.back()`): una ficha abierta
 * desde un aviso o compartida por WhatsApp no tiene "atrás", y la lista sí
 * existe siempre. Lleva `nav-back`, así la pantalla de la lista entra desde la
 * izquierda.
 */
export function TopbarBack({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="ui-topbar__back"
      aria-label={`Volver a ${label}`}
      title={`Volver a ${label}`}
      transitionTypes={["nav-back"]}
    >
      <Icon name="chevron-izq" size={22} />
    </Link>
  );
}

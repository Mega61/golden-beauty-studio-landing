import { Icon } from "./Icon";
import { phoneLinks } from "./phone-links";

/**
 * El teléfono de una clienta como botón de WhatsApp (y, si se pide, de llamada).
 *
 * Sin `"use client"`: no tiene estado ni manejadores, así que se pinta igual
 * desde la ficha (Server Component) que desde la agenda (cliente).
 *
 * - Con un número que se puede normalizar: un botón compacto con el glifo de
 *   WhatsApp y el número, que abre el chat en otra pestaña con el saludo
 *   escrito. En otra pestaña porque en el computador del mesón `wa.me` abre
 *   WhatsApp Web, y perder la agenda para abrir un chat obliga a volver a
 *   buscar la cita.
 * - `withCall`: al lado, un botón de solo icono para llamar. Va donde antes ya
 *   había un `tel:` — quitarlo sería quitarle a recepción un gesto que usa.
 * - Con un número que no se puede normalizar: el texto tal cual, sin enlace.
 *   Un botón que abre "este número no está en WhatsApp" es peor que ninguno.
 * - Sin número: nada. Cada vista dice a su manera que no hay teléfono.
 *
 * El contenedor lleva `position: relative` y `z-index` (`.ui-wa`) para quedar
 * por encima del enlace estirado de las filas de lista (`.ui-list__link`), que
 * tapa la fila entera con un `::after`: sin eso, tocar el botón abría la ficha.
 */
export function WhatsAppLink({
  phone,
  customerName,
  showNumber = true,
  withCall = false,
}: {
  /** El teléfono crudo, como venga de EA o de la ficha. */
  phone: string | null | undefined;
  /** Para el saludo del chat y para el nombre accesible. */
  customerName?: string | null;
  /** `false`: solo el icono, para donde el número ya está escrito al lado. */
  showNumber?: boolean;
  withCall?: boolean;
}) {
  const raw = typeof phone === "string" ? phone.trim() : "";
  if (raw === "") return null;

  const links = phoneLinks(raw, customerName);
  if (links === null) return <span className="ui-num">{raw}</span>;

  const who = customerName?.trim() ? ` a ${customerName.trim()}` : "";

  return (
    <span className="ui-wa">
      <a
        className={`ui-btn ui-btn--secondary ui-btn--sm${showNumber ? "" : " ui-btn--icon"}`}
        href={links.whatsapp}
        target="_blank"
        rel="noopener noreferrer"
        // El nombre accesible contiene el número visible, para que quien
        // maneja el panel por voz pueda decir lo que ve.
        aria-label={`Escribir por WhatsApp${who}: ${links.display}`}
        title="Escribir por WhatsApp"
      >
        <Icon name="whatsapp" size={16} className="ui-wa__glyph" />
        {showNumber ? <span className="ui-num">{links.display}</span> : null}
      </a>
      {withCall ? (
        <a
          className="ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon"
          href={links.tel}
          aria-label={`Llamar${who}: ${links.display}`}
          title="Llamar"
        >
          <Icon name="llamar" size={16} />
        </a>
      ) : null}
    </span>
  );
}

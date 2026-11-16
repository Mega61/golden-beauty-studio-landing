import Bauble from "./Bauble";

/**
 * Una bola que cuelga del borde inferior del header, bajo el botón de agendar.
 * Se mece al pasar el mouse. Solo en escritorio: en celular el header pegajoso
 * la arrastra encima del contenido (tapaba precios del carrusel de promos).
 * El logo no se toca — la firma Golden no lleva adornos.
 *
 * Server component: todo el comportamiento es CSS (`.gbs-swing-hover`).
 */
export default function NavOrnament() {
  return (
    <span
      aria-hidden
      className="gbs-nav-ornament absolute top-full hidden md:right-[11%] md:block xl:right-[6.5rem]"
    >
      <Bauble size={13} thread={22} className="gbs-swing-hover" />
    </span>
  );
}

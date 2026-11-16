import Bauble from "./Bauble";

/**
 * Una bola que cuelga del borde inferior del header, bajo el botón de agendar.
 * Se mece al pasar el mouse o al tocarla (en celular el toque activa :hover).
 * El logo no se toca — la firma Golden no lleva adornos.
 *
 * Server component: todo el comportamiento es CSS (`.gbs-swing-hover`).
 */
export default function NavOrnament() {
  return (
    <span
      aria-hidden
      className="gbs-nav-ornament absolute right-[18%] top-full md:right-[11%] xl:right-[6.5rem]"
    >
      <Bauble size={13} thread={22} className="gbs-swing-hover" />
    </span>
  );
}

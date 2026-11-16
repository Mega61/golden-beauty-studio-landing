/**
 * Adornos grandes a los lados del `/bio` en pantallas anchas, donde la columna
 * de 400 px deja el mármol vacío. Fijos abajo, detrás del contenido; en celular
 * no existen (y como son `<img loading="lazy">` dentro de `hidden`, ni bajan).
 */
export default function SideDecor() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 bottom-0 hidden lg:block">
      {/* eslint-disable-next-line @next/next/no-img-element -- adorno estático */}
      <img
        src="/navidad/tree.webp"
        alt=""
        width={180}
        height={360}
        loading="lazy"
        className="gbs-scene-sway absolute bottom-10 block select-none"
        style={{ right: "calc(50% + 260px)" }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- adorno estático */}
      <img
        src="/navidad/presents.webp"
        alt=""
        width={230}
        height={200}
        loading="lazy"
        className="absolute bottom-10 block select-none"
        style={{ left: "calc(50% + 250px)" }}
      />
    </div>
  );
}

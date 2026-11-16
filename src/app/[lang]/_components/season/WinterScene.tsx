import SnowmanConfetti from "./SnowmanConfetti";

/**
 * La escena de temporada del `/bio`: árbol, muñeco y regalos dorados (renders 3D
 * de raea sobre modelos de Polyfork) parados sobre un hilo de oro. El muñeco es
 * el botón del confeti. Server component: lo único cliente es el muñeco.
 */
export default function WinterScene({
  eyebrow,
  snowmanLabel,
  snowmanHint,
}: {
  eyebrow: string;
  snowmanLabel: string;
  snowmanHint: string;
}) {
  return (
    <div className="flex w-full flex-col items-center" style={{ marginTop: 22 }}>
      <div className="relative flex w-full items-end justify-center" style={{ gap: 4 }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- adorno estático de 15 KB */}
        <img
          src="/navidad/tree.webp"
          alt=""
          aria-hidden
          width={60}
          height={120}
          className="gbs-scene-sway block select-none"
          style={{ marginBottom: 2 }}
          draggable={false}
        />
        <SnowmanConfetti label={snowmanLabel} hint={snowmanHint} size={112} />
        {/* eslint-disable-next-line @next/next/no-img-element -- adorno estático de 17 KB */}
        <img
          src="/navidad/presents.webp"
          alt=""
          aria-hidden
          width={78}
          height={68}
          className="block select-none"
          style={{ marginBottom: 1 }}
          draggable={false}
        />
      </div>
      {/* El "suelo": un hilo de oro que se desvanece hacia los lados. */}
      <span
        aria-hidden
        className="block h-px w-[86%]"
        style={{
          background:
            "linear-gradient(90deg, rgba(172,130,49,0), var(--color-gold) 30%, var(--color-gold-bright) 50%, var(--color-gold) 70%, rgba(172,130,49,0))",
        }}
      />
      <span
        className="font-sans uppercase"
        style={{ marginTop: 10, fontSize: 10, letterSpacing: "0.32em", color: "var(--color-gold)" }}
      >
        {eyebrow}
      </span>
    </div>
  );
}

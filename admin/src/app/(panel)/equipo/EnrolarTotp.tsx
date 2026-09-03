"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui";

import {
  confirmarTotp,
  desbloquearTotp,
  enrolarTotp,
  revocarSesiones,
  type ActionResult,
} from "./actions";
import { otpauthSecret } from "./qr";
import { QrSvg } from "./QrSvg";
import type { TotpState } from "./data";

/**
 * El enrolamiento TOTP, de punta a punta y en una sola pantalla.
 *
 * ## Por qué el QR vive en el estado del cliente y en ningún otro lado
 *
 * "Se muestra una sola vez" no es una recomendación de higiene: después del
 * enrolamiento el secreto solo existe **cifrado** en `staff_totp`, y no hay
 * pantalla que lo descifre. Guardarlo en la URL, en `sessionStorage` o en el
 * HTML de una página que se puede recargar sería inventar una segunda copia en
 * claro, en el único lugar donde el diseño dijo que no debía haberla.
 *
 * Consecuencia buscada: si la técnica no alcanzó a escanear y alguien recarga,
 * el QR se perdió y hay que volver a enrolar. Cuesta treinta segundos y es
 * exactamente el mismo gesto que la recuperación, así que nadie tiene que
 * aprender dos procedimientos.
 *
 * ## Y la entrada manual
 *
 * Siempre está el secreto en base32 debajo del QR. Una cámara sucia, una
 * pantalla con poco brillo o una app que no trae escáner convierten un
 * enrolamiento de treinta segundos en un viaje al local.
 */
export function EnrolarTotp({
  userId,
  accountLabel,
  estado,
  lockedUntil,
}: {
  userId: string;
  /** Cómo se va a ver la cuenta en la app de la técnica. */
  accountLabel: string;
  estado: TotpState;
  lockedUntil: Date | null;
}) {
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generando, setGenerando] = useState(false);
  const [confirmado, setConfirmado] = useState(false);

  async function generar() {
    setGenerando(true);
    setError(null);
    const result = await enrolarTotp(userId, accountLabel);
    setGenerando(false);
    if (result.ok) {
      setOtpauth(result.otpauthUrl);
      setConfirmado(false);
    } else {
      setError(result.message);
    }
  }

  return (
    <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <EstadoTotp estado={confirmado ? "activo" : estado} lockedUntil={lockedUntil} />

        <Button onClick={generar} loading={generando} loadingLabel="Generando">
          {estado === "sin-enrolar" ? "Generar código" : "Volver a enrolar"}
        </Button>

        {estado === "bloqueado" ? <BotonDesbloquear userId={userId} /> : null}
        <BotonRevocar userId={userId} />
      </div>

      {estado !== "sin-enrolar" && otpauth === null ? (
        <p style={meta}>
          Volver a enrolar reemplaza el código anterior: el celular viejo deja de
          servir en el momento. Es el mismo gesto que la recuperación.
        </p>
      ) : null}

      {error ? (
        <p role="alert" style={{ ...meta, color: "var(--color-error-ink)" }}>
          {error}
        </p>
      ) : null}

      {otpauth !== null ? (
        <Codigo
          userId={userId}
          otpauth={otpauth}
          onConfirmado={() => {
            // El QR desaparece en cuanto la técnica confirma: ya cumplió su
            // trabajo y dejarlo en pantalla es dejar un secreto a la vista.
            setOtpauth(null);
            setConfirmado(true);
          }}
        />
      ) : null}
    </div>
  );
}

function Codigo({
  userId,
  otpauth,
  onConfirmado,
}: {
  userId: string;
  otpauth: string;
  onConfirmado: () => void;
}) {
  const secreto = otpauthSecret(otpauth);

  const [estado, enviar, enviando] = useActionState<ActionResult | null, FormData>(
    async (_previo, formData) => {
      const result = await confirmarTotp(userId, String(formData.get("code") ?? ""));
      if (result.ok) onConfirmado();
      return result;
    },
    null,
  );

  return (
    <div
      style={{
        display: "grid",
        gap: "1rem",
        gridTemplateColumns: "minmax(0, 14rem) minmax(0, 1fr)",
        alignItems: "start",
        padding: "0.875rem",
        borderRadius: "var(--radius-md)",
        background: "var(--color-ivory-deep)",
        border: "1px solid var(--hair)",
      }}
    >
      <QrSvg text={otpauth} title="Código de enrolamiento de la app de autenticación" />

      <div style={{ display: "grid", gap: "0.625rem", minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>
          <strong>Este código se muestra una sola vez.</strong> Escanealo con la
          app de autenticación del celular y escribí abajo los seis dígitos que
          aparezcan.
        </p>

        {secreto ? (
          <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
            ¿No escanea? Escribilo a mano:{" "}
            <code className="ui-num" style={{ wordBreak: "break-all", fontSize: "var(--text-xs)" }}>
              {secreto}
            </code>
          </p>
        ) : null}

        <form action={enviar} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <label className="ui-sr" htmlFor={`code-${userId}`}>
            Código de seis dígitos
          </label>
          <input
            id={`code-${userId}`}
            name="code"
            className="ui-input ui-num"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,8}"
            maxLength={8}
            required
            placeholder="000000"
            style={{ width: "8rem", letterSpacing: "0.15em" }}
          />
          <Button type="submit" variant="primary" loading={enviando} loadingLabel="Verificando">
            Confirmar
          </Button>
        </form>

        {estado && !estado.ok ? (
          <p role="alert" style={{ ...meta, color: "var(--color-error-ink)" }}>
            {estado.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

const ESTADO_LABEL: Record<TotpState, { texto: string; tono: "ok" | "warn" | "error" | "info" }> = {
  "sin-enrolar": { texto: "Sin código", tono: "info" },
  pendiente: { texto: "Enrolada sin confirmar", tono: "warn" },
  activo: { texto: "Puede entrar", tono: "ok" },
  bloqueado: { texto: "Bloqueada", tono: "error" },
};

export function EstadoTotp({
  estado,
  lockedUntil,
}: {
  estado: TotpState;
  lockedUntil: Date | null;
}) {
  const { texto, tono } = ESTADO_LABEL[estado];
  return (
    <span
      title={
        estado === "bloqueado" && lockedUntil
          ? `Bloqueada por intentos fallidos hasta que la dueña la suelte.`
          : undefined
      }
      style={{
        fontSize: "var(--text-2xs)",
        padding: "0.0625rem 0.375rem",
        borderRadius: "var(--radius-sm)",
        whiteSpace: "nowrap",
        background: `var(--color-${tono}-tint)`,
        border: `1px solid var(--color-${tono}-line)`,
        color: `var(--color-${tono}-ink)`,
      }}
    >
      {texto}
    </span>
  );
}

function BotonDesbloquear({ userId }: { userId: string }) {
  const [estado, enviar, enviando] = useActionState<ActionResult | null>(
    () => desbloquearTotp(userId),
    null,
  );
  return (
    <form action={enviar} style={{ display: "inline" }}>
      {/* Tamaño normal y no `sm`: el enrolamiento se hace de pie, con el
          celular de la técnica en la otra mano, y 34 px no es un área táctil. */}
      <Button type="submit" loading={enviando}>
        Desbloquear
      </Button>
      {estado ? <span className="ui-sr" role="status">{estado.message}</span> : null}
    </form>
  );
}

function BotonRevocar({ userId }: { userId: string }) {
  const [estado, enviar, enviando] = useActionState<ActionResult | null>(
    () => revocarSesiones(userId),
    null,
  );
  return (
    <form action={enviar} style={{ display: "inline" }}>
      <Button type="submit" variant="ghost" loading={enviando}>
        Cerrar sus sesiones
      </Button>
      {estado ? (
        <span role="status" style={{ ...meta, marginInlineStart: "0.375rem" }}>
          {estado.message}
        </span>
      ) : null}
    </form>
  );
}

const meta: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-2xs)",
  color: "var(--color-ink-soft)",
};

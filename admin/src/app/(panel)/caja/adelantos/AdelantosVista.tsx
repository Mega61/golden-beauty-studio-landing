"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Card, CardHead, EmptyState, formatCOP } from "@/components/ui";
import { DEPOSIT_STATE_LABEL } from "@/lib/deposits";

import type { AdelantosView } from "./data";
import { RefundForm, depositLine } from "./DepositForms";
import type { DepositView } from "./view";

/**
 * Caja → Adelantos. Arriba, lo que sigue por usar (plata de las clientas por
 * citas que no se han cobrado); abajo, lo usado y lo devuelto.
 */
export function AdelantosVista({ view, canFixAfterSync }: { view: AdelantosView; canFixAfterSync: boolean }) {
  const total = view.porUsar.reduce((sum, deposit) => sum + deposit.remaining, 0);

  return (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <Card padded={false}>
        <CardHead title="Por usar" />
        <div style={{ padding: "0.75rem 1rem 1rem", display: "grid", gap: "0.75rem" }}>
          <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>
            {view.porUsar.length === 0 ? (
              "Ningún adelanto pendiente."
            ) : (
              <>
                <span className="ui-num" style={{ fontWeight: 600 }}>{formatCOP(total)}</span> en{" "}
                {view.porUsar.length === 1 ? "1 adelanto" : `${view.porUsar.length} adelantos`} de citas que
                todavía no se cobran. Se descuentan solos al cerrar la cuenta.
              </>
            )}
          </p>
          <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
            Un adelanto se registra desde la cita, en la Agenda. Cada uno llega a Actual la noche del día en que
            entró, como una venta aparte: así el bot de finanzas lo enlaza con la transferencia.
          </p>
          {view.porUsar.length === 0 ? null : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "0.625rem" }}>
              {view.porUsar.map((deposit) => (
                <Fila key={deposit.id} deposit={deposit} today={view.today} canFixAfterSync={canFixAfterSync} />
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card padded={false}>
        <CardHead title="Usados y devueltos" />
        <div style={{ padding: "0.75rem 1rem 1rem" }}>
          {view.historial.length === 0 ? (
            <EmptyState icon="caja" title="Nada todavía" body="Aquí quedan los adelantos ya usados en su cuenta o devueltos." />
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "0.5rem" }}>
              {view.historial.map((deposit) => (
                <Fila key={deposit.id} deposit={deposit} today={view.today} canFixAfterSync={canFixAfterSync} />
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

function Fila({
  deposit,
  today,
  canFixAfterSync,
}: {
  deposit: DepositView;
  today: string;
  canFixAfterSync: boolean;
}) {
  const router = useRouter();
  const [devolviendo, setDevolviendo] = useState(false);
  const puedeDevolver =
    deposit.state === "pendiente" && deposit.refund === null && (!deposit.pushed || canFixAfterSync);
  const cita = deposit.appointmentStart;

  return (
    <li
      style={{
        display: "grid",
        gap: "0.25rem",
        padding: "0.625rem 0.75rem",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--hair)",
      }}
    >
      <span style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
        <strong>{deposit.customerName ?? `Cita #${deposit.eaAppointmentId}`}</strong>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
          {DEPOSIT_STATE_LABEL[deposit.state]}
        </span>
      </span>
      <span className="ui-num" style={{ fontSize: "var(--text-sm)" }}>{depositLine(deposit)}</span>
      <span style={{ fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
        {cita ? (
          <Link href={`/agenda?dia=${cita.slice(0, 10)}&cita=${deposit.eaAppointmentId}`}>
            Cita {cita.slice(0, 10)} {cita.slice(11, 16)}
          </Link>
        ) : (
          `Cita #${deposit.eaAppointmentId}`
        )}
        {" · "}
        {deposit.pushed ? "en Actual" : "llega a Actual esta noche"}
        {deposit.refund ? ` · devolución ${deposit.refund.pushed ? "en Actual" : "sale esta noche"}` : ""}
        {deposit.refund?.reason ? ` · ${deposit.refund.reason}` : ""}
      </span>
      {puedeDevolver && !devolviendo ? (
        <span>
          <Button size="sm" variant="ghost" onClick={() => setDevolviendo(true)}>
            Devolver
          </Button>
        </span>
      ) : null}
      {devolviendo ? (
        <RefundForm
          deposit={deposit}
          today={today}
          onCancel={() => setDevolviendo(false)}
          onDone={() => {
            setDevolviendo(false);
            router.refresh();
          }}
        />
      ) : null}
    </li>
  );
}

"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { formatDateShort } from "@/components/ui/format";

import { clientContext } from "./actions";
import type { ClientContext, ClientContextRow } from "./client-context";
import styles from "./client-context.module.css";

/**
 * "Última visita: 2 oct · Polygel esculpido · Mariana", debajo de la clienta.
 *
 * Lo que la dueña pidió el primer día: al agendar, ver qué se hizo la clienta la
 * última vez y, si fue un sistema, agendarle el retoque de ese sistema de un
 * toque. **Un toque, no automático**: elegir el servicio en silencio haría que
 * una clienta que hoy quiere otra cosa quedara agendada con el retoque porque
 * nadie miró el selector.
 *
 * Todo lo que puede fallar es silencioso. La tarjeta es una ayuda: mientras
 * carga dice una línea gris, si falla dice otra, y el formulario sigue
 * funcionando igual en los dos casos.
 */
export function ClientContextCard({
  customerId,
  excludeAppointmentId,
  selectedServiceId,
  bookableServiceIds,
  onPickService,
}: {
  customerId: number | null;
  excludeAppointmentId: number | undefined;
  selectedServiceId: number | null;
  /** Lo que el selector del formulario ofrece. Una sugerencia fuera de esto no se muestra. */
  bookableServiceIds: ReadonlySet<number>;
  onPickService: (serviceId: number) => void;
}) {
  // El resultado se guarda **con la clienta a la que pertenece**, y "cargando"
  // se deriva de que no coincida: así cambiar de clienta nunca muestra por un
  // instante el historial de la anterior, y no hace falta borrar el estado
  // desde el efecto (un render en cascada por cada cambio).
  const key = customerId === null ? null : `${customerId}:${excludeAppointmentId ?? ""}`;
  const [loaded, setLoaded] = useState<{ key: string; context: ClientContext | null } | null>(null);

  useEffect(() => {
    if (customerId === null || key === null) return;
    let alive = true;
    clientContext({ customerId, excludeAppointmentId: excludeAppointmentId ?? null })
      .then((context) => {
        if (alive) setLoaded({ key, context });
      })
      .catch(() => {
        if (alive) setLoaded({ key, context: null });
      });
    return () => {
      alive = false;
    };
  }, [customerId, excludeAppointmentId, key]);

  if (key === null) return null;

  if (loaded?.key !== key) {
    return (
      <p className={styles.quiet} aria-live="polite">
        Buscando su historial…
      </p>
    );
  }

  const context = loaded.context;
  if (context === null) {
    return <p className={styles.quiet}>No se pudo leer su historial. Puedes agendar igual.</p>;
  }

  const showNew = context.isFirstVisit && !context.partial;
  const suggestion =
    context.suggestion !== null &&
    bookableServiceIds.has(context.suggestion.serviceId) &&
    context.suggestion.serviceId !== selectedServiceId
      ? context.suggestion
      : null;

  if (context.recent.length === 0 && !showNew && context.noShows === 0) {
    return context.partial ? (
      <p className={styles.quiet}>La agenda no respondió: el historial puede estar incompleto.</p>
    ) : null;
  }

  const currentYear = context.asOf?.slice(0, 4) ?? null;

  return (
    <section className={styles.card} aria-label="Historial de la clienta">
      {showNew || context.noShows > 0 ? (
        <div className={styles.badges}>
          {showNew ? (
            <span className={`${styles.badge} ${styles.badgeNew}`}>
              Clienta nueva · 10% primera visita
            </span>
          ) : null}
          {context.noShows > 0 ? (
            <span className={`${styles.badge} ${styles.badgeWarn}`}>
              {context.noShows === 1 ? "1 inasistencia" : `${context.noShows} inasistencias`}
            </span>
          ) : null}
        </div>
      ) : null}

      {context.recent.length > 0 ? (
        <ul className={styles.rows}>
          {context.recent.map((row, index) => (
            <HistoryRow key={row.id} row={row} first={index === 0} currentYear={currentYear} />
          ))}
        </ul>
      ) : null}

      {context.partial ? (
        <p className={styles.quiet}>La agenda no respondió: puede faltar lo más reciente.</p>
      ) : null}

      {suggestion ? (
        <div className={styles.suggest}>
          <Button size="sm" variant="secondary" onClick={() => onPickService(suggestion.serviceId)}>
            {suggestion.label}
          </Button>
          <span className={styles.reason}>{suggestion.reason}</span>
        </div>
      ) : null}
    </section>
  );
}

const OUTCOME_LABEL: Partial<Record<ClientContextRow["outcome"], string>> = {
  cancelada: "canceló",
  "no-asistio": "no asistió",
};

function HistoryRow({
  row,
  first,
  currentYear,
}: {
  row: ClientContextRow;
  first: boolean;
  currentYear: string | null;
}) {
  const year = row.start.slice(0, 4);
  const date = currentYear !== null && year !== currentYear
    ? `${formatDateShort(row.start)} ${year}`
    : formatDateShort(row.start);
  const off = OUTCOME_LABEL[row.outcome];

  return (
    <li className={styles.row}>
      {first && off === undefined ? <span className={styles.rowLabel}>Última visita:</span> : null}
      <span className={styles.rowDate}>{date}</span>
      <span aria-hidden="true">·</span>
      <span className={off ? `${styles.rowService} ${styles.rowOff}` : styles.rowService}>
        {row.serviceName}
      </span>
      {row.providerName ? (
        <>
          <span aria-hidden="true">·</span>
          <span className={styles.rowMuted}>{row.providerName}</span>
        </>
      ) : null}
      {off ? <span className={styles.rowMuted}>({off})</span> : null}
    </li>
  );
}

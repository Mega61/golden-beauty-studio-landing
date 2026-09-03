import Link from "next/link";

import { Card, CardHead, EmptyState, formatDuration } from "@/components/ui";

import type { MemberDetail } from "./data";
import { EnrolarTotp } from "./EnrolarTotp";
import { SyncBadge } from "./SyncBadge";
import { eaGoogleOauthUrl } from "./sync";
import type { PlannedDay } from "./working-plan";

/**
 * La ficha de una profesional: plan, excepciones, espejo de Google y cuenta.
 *
 * **Todo lo de EA se muestra y no se edita.** Plan de trabajo, servicios
 * asignados y conexión con Google se configuran una vez y se tocan cada varios
 * meses; el panel enlaza a la interfaz de la agenda para cambiarlos. Lo único
 * que se administra desde acá es lo que es del panel: el enrolamiento del
 * código y las sesiones.
 */
export function FichaProfesional({
  detail,
  puedeAdministrar,
}: {
  detail: MemberDetail;
  puedeAdministrar: boolean;
}) {
  const { member, plan, exceptions, eaPublicUrl } = detail;

  return (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <p style={{ margin: 0, fontSize: "var(--text-2xs)" }}>
        <Link href="/equipo">← Equipo</Link>
      </p>

      <Card>
        <div style={{ display: "grid", gap: "0.5rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
          <h2 style={{ margin: 0, fontSize: "var(--text-lg)", color: "var(--color-carbon)" }}>
            {member.name}
          </h2>
          <p style={meta}>
            Profesional #{member.provider.id}
            {member.provider.email ? ` · ${member.provider.email}` : ""}
          </p>
        </div>
      </Card>

      <Card padded={false}>
        <CardHead title="Plan de trabajo" />
        <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.625rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
          {plan.missing ? (
            <EmptyState
              icon="alerta"
              title="La agenda no tiene su horario"
              body="Sin plan de trabajo, esta profesional nunca va a mostrar disponibilidad. Se configura en Easy!Appointments."
            />
          ) : (
            <>
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "0.25rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
                {plan.days.map((day) => (
                  <Dia key={day.key} day={day} />
                ))}
              </ul>
              <p style={meta}>
                {formatDuration(plan.weeklyNetMinutes)} netos por semana, ya
                descontados los descansos.
              </p>
            </>
          )}
        </div>
      </Card>

      <Card padded={false}>
        <CardHead title="Excepciones" />
        <div style={{ padding: "0 1rem 1rem" }}>
          {exceptions.length === 0 ? (
            <EmptyState
              icon="reloj"
              title="Sin excepciones próximas"
              body="Cuando entre más tarde un jueves o se tome un día, va a aparecer acá. Se registran desde Bloqueos."
            />
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "0.25rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
              {exceptions.map((exception) => (
                <li
                  key={exception.id}
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    justifyContent: "space-between",
                    padding: "0.25rem 0",
                    borderBottom: "1px solid var(--hair)",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  <span className="ui-num">
                    {exception.startDate}
                    {exception.endDate !== exception.startDate ? ` → ${exception.endDate}` : ""}
                  </span>
                  <span style={{ color: "var(--color-ink-soft)" }}>
                    {exception.dayOff
                      ? "No trabaja"
                      : `${exception.startTime} – ${exception.endTime}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card padded={false}>
        <CardHead title="Servicios que puede tomar" />
        <div style={{ padding: "0 1rem 1rem" }}>
          {member.serviceNames.length === 0 ? (
            <EmptyState
              icon="servicios"
              title="No tiene servicios asignados"
              body="Con la lista vacía no le sale ninguna hora disponible, aunque su horario esté bien. Se asignan en Easy!Appointments."
            />
          ) : (
            <ul style={{ margin: 0, paddingInlineStart: "1.1rem", fontSize: "var(--text-sm)" }}>
              {member.serviceNames.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card padded={false}>
        <CardHead title="Espejo en Google Calendar" actions={<SyncBadge status={member.sync} />} />
        <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.5rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
          <dl style={{ margin: 0, display: "grid", gap: "0.5rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
            <Dato etiqueta="Calendario">
              {member.sync.calendarId ? (
                <span className="ui-num" style={{ wordBreak: "break-all" }}>
                  {member.sync.calendarId}
                </span>
              ) : (
                <span style={{ color: "var(--color-ink-soft)" }}>Ninguno</span>
              )}
            </Dato>
            <Dato etiqueta="Credencial guardada">
              {member.sync.hasToken ? "Sí" : "No"}
            </Dato>
            <Dato etiqueta="Ventana que sincroniza">
              {member.sync.pastDays === null && member.sync.futureDays === null
                ? "La de por defecto de la agenda"
                : `${member.sync.pastDays ?? "?"} días atrás · ${member.sync.futureDays ?? "?"} adelante`}
            </Dato>
            <Dato etiqueta="Desde cuándo">
              {/* No se inventa una fecha: la API de EA no expone cuándo se
                  autorizó, y `google_token` es un JSON de OAuth sin fecha de
                  emisión legible desde acá. */}
              <span style={{ color: "var(--color-ink-soft)" }}>
                La agenda no lo expone por su API
              </span>
            </Dato>
          </dl>

          {member.sync.problems.map((problem) => (
            <p
              key={problem}
              style={{
                margin: 0,
                fontSize: "var(--text-xs)",
                padding: "0.5rem 0.625rem",
                borderRadius: "var(--radius-md)",
                background: "var(--color-warn-tint)",
                border: "1px solid var(--color-warn-line)",
                color: "var(--color-warn-ink)",
              }}
            >
              {problem}
            </p>
          ))}

          <p style={meta}>
            El sync es de un solo sentido: la agenda manda y Google es el espejo.
            Conectar o cambiar el calendario se hace en la agenda, porque el
            token vive allá.
            {eaPublicUrl ? (
              <>
                {" "}
                <a
                  href={eaGoogleOauthUrl(eaPublicUrl, member.provider.id)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Conectar en la agenda ↗
                </a>
              </>
            ) : null}
          </p>
        </div>
      </Card>

      <Card padded={false}>
        <CardHead title="Entrada al panel" />
        <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.75rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
          {member.account === null ? (
            <EmptyState
              icon="candado"
              title="No tiene cuenta en el panel"
              body="Puede atender y aparecer en la agenda, pero no puede entrar a cerrar sus cuentas ni ver su liquidación. Se agrega desde Equipo."
            />
          ) : member.account.userId === null ? (
            <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>
              Está en la lista de acceso ({member.account.allowed.email}) pero
              todavía no existe su cuenta. Si entra con la cuenta del estudio se
              crea sola; si es una técnica, hay que agregarla desde Equipo.
            </p>
          ) : puedeAdministrar ? (
            <EnrolarTotp
              userId={member.account.userId}
              accountLabel={member.name}
              estado={member.account.totp}
              lockedUntil={member.account.lockedUntil}
            />
          ) : (
            <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>
              El enrolamiento del código lo hace la dueña.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

function Dia({ day }: { day: PlannedDay }) {
  return (
    <li
      style={{
        display: "flex",
        gap: "0.5rem",
        justifyContent: "space-between",
        padding: "0.25rem 0",
        borderBottom: "1px solid var(--hair)",
        fontSize: "var(--text-sm)",
      }}
    >
      <span style={{ minWidth: "5.5rem" }}>{day.label}</span>
      {day.works ? (
        <span className="ui-num" style={{ textAlign: "end" }}>
          {day.start} – {day.end}
          {day.breaks.length > 0 ? (
            <span style={{ color: "var(--color-ink-soft)" }}>
              {" "}
              (descanso {day.breaks.map((b) => `${b.start}–${b.end}`).join(", ")})
            </span>
          ) : null}
        </span>
      ) : (
        <span style={{ color: "var(--color-ink-soft)" }}>Libre</span>
      )}
    </li>
  );
}

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: "0.0625rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <dt style={{ ...meta, textTransform: "uppercase", letterSpacing: "0.04em" }}>{etiqueta}</dt>
      <dd style={{ margin: 0, fontSize: "var(--text-sm)" }}>{children}</dd>
    </div>
  );
}

const meta: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-2xs)",
  color: "var(--color-ink-soft)",
};

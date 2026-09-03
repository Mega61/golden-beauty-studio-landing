import Link from "next/link";

import {
  Card,
  CardHead,
  DataTable,
  EmptyState,
  formatDuration,
  type Column,
} from "@/components/ui";

import type { EquipoView, PanelAccount, TeamMember } from "./data";
import { EstadoTotp } from "./EnrolarTotp";
import { NuevaTecnica } from "./NuevaTecnica";
import { SyncBadge } from "./SyncBadge";
import { buildWeekPlan } from "./working-plan";

/**
 * Equipo: las profesionales, su estado de sync y sus cuentas del panel.
 *
 * La pantalla junta dos sistemas de identidad que conviven a propósito: los
 * providers de EA (que son los que tienen calendario y token de Google) y las
 * cuentas del panel (Workspace o TOTP). El puente es
 * `allowed_user.ea_provider_id`, y las filas donde ese puente falta son
 * información, no ruido: una profesional sin cuenta no entra al panel, y una
 * cuenta sin profesional no puede cerrar la cuenta de ninguna cita.
 */
export function EquipoVista({
  view,
  puedeAdministrar,
}: {
  view: EquipoView;
  /** `equipo:administrar` — solo la dueña. */
  puedeAdministrar: boolean;
}) {
  return (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      {view.failures.map((failure, index) => (
        <p
          key={index}
          role="status"
          style={{
            margin: 0,
            fontSize: "var(--text-xs)",
            padding: "0.625rem 0.75rem",
            borderRadius: "var(--radius-md)",
            background: "var(--color-error-tint)",
            border: "1px solid var(--color-error-line)",
            color: "var(--color-error-ink)",
          }}
        >
          {failure.message}
        </p>
      ))}

      {view.eaPublicUrl === null ? (
        <p style={{ ...meta, color: "var(--color-warn-ink)" }}>
          Sin <code>EA_PUBLIC_URL</code> configurada no se pueden dibujar los
          enlaces a la interfaz de la agenda. Mandar a alguien a una URL que no
          resuelve es peor que no ofrecer el enlace.
        </p>
      ) : null}

      <Card padded={false}>
        <CardHead title="Profesionales" />
        <div style={{ padding: "0 1rem 1rem" }}>
          <DataTable
            columns={memberColumns()}
            rows={view.members}
            rowKey={(row) => String(row.provider.id)}
            caption="Profesionales de la agenda"
            empty={
              <EmptyState
                icon="equipo"
                title="La agenda no tiene profesionales"
                body="Se crean una vez en Easy!Appointments, con su plan de trabajo y sus servicios. El panel las muestra y enlaza allá para cambiarlas."
              />
            }
          />
        </div>
      </Card>

      <Card padded={false}>
        <CardHead title="Cuentas del panel" />
        <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.75rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
          <p style={meta}>
            La dueña y la recepción entran con la cuenta del estudio; las
            técnicas, con un código de seis dígitos desde su celular.
          </p>
          <DataTable
            columns={accountColumns()}
            rows={view.unlinkedAccounts}
            rowKey={(row) => String(row.allowed.id)}
            caption="Cuentas del panel sin profesional enlazada"
            empty={
              <EmptyState
                icon="candado"
                title="Todas las cuentas están enlazadas"
                body="Cada cuenta del panel corresponde a una profesional de la agenda."
              />
            }
          />
        </div>
      </Card>

      {puedeAdministrar ? (
        <Card padded={false}>
          <CardHead title="Agregar una técnica" />
          <div style={{ padding: "0 1rem 1rem" }}>
            <NuevaTecnica
              profesionales={view.members.map((member) => ({
                id: member.provider.id,
                name: member.name,
              }))}
            />
          </div>
        </Card>
      ) : null}

      <Card>
        <p style={{ margin: 0, fontSize: "var(--text-xs)" }}>
          <strong>Lo que no se administra desde acá:</strong> secretarias,
          administradoras y toda la configuración de Easy!Appointments se
          enlazan a su propia interfaz. Se tocan cada varios meses, y cada campo
          que el panel reconstruyera es un campo que habría que volver a
          verificar en cada actualización de la agenda.
        </p>
      </Card>
    </div>
  );
}

function memberColumns(): Array<Column<TeamMember>> {
  return [
    {
      key: "nombre",
      header: "Profesional",
      from: "siempre",
      listSlot: "primary",
      width: "26%",
      text: (row) => row.name,
      render: (row) => (
        <Link href={`/equipo/${row.provider.id}`} style={{ fontWeight: 600 }}>
          {row.name}
        </Link>
      ),
    },
    {
      key: "servicios",
      header: "Servicios",
      from: "md",
      listSlot: "secondary",
      text: (row) =>
        row.serviceNames.length === 0
          ? "Sin servicios asignados"
          : `${row.serviceNames.length} servicios`,
      render: (row) =>
        row.serviceNames.length === 0 ? (
          // Es la primera causa de "no me sale disponibilidad" sin que nada
          // esté roto: una profesional solo puede tomar lo que tenga asignado.
          <span style={{ color: "var(--color-warn-ink)" }}>Sin servicios asignados</span>
        ) : (
          <span title={row.serviceNames.join(", ")}>{row.serviceNames.length}</span>
        ),
    },
    {
      key: "jornada",
      header: "Semana",
      from: "lg",
      numeric: true,
      listSlot: "secondary",
      text: (row) => semanaTexto(row),
      render: (row) => semanaTexto(row),
    },
    {
      key: "sync",
      header: "Google",
      from: "md",
      listSlot: "trailing",
      text: (row) => row.sync.state,
      render: (row) => <SyncBadge status={row.sync} />,
    },
    {
      key: "cuenta",
      header: "Cuenta",
      from: "md",
      listSlot: "trailing",
      text: (row) => (row.account ? row.account.totp : "sin cuenta"),
      render: (row) =>
        row.account ? (
          <EstadoTotp estado={row.account.totp} lockedUntil={row.account.lockedUntil} />
        ) : (
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
            Sin cuenta
          </span>
        ),
    },
  ];
}

function semanaTexto(member: TeamMember): string {
  const plan = buildWeekPlan(member.provider.settings?.workingPlan ?? null);
  if (plan.missing) return "Sin plan";
  if (plan.weeklyNetMinutes === 0) return "0 h";
  return formatDuration(plan.weeklyNetMinutes);
}

function accountColumns(): Array<Column<PanelAccount>> {
  return [
    {
      key: "persona",
      header: "Persona",
      from: "siempre",
      listSlot: "primary",
      width: "22%",
      // El nombre arriba y el correo en la segunda línea: juntos en el primario
      // el correo se come el ancho y se recorta justo el dominio, que es lo
      // único que distingue una cuenta del estudio de una personal.
      text: (row) => row.name ?? row.allowed.email,
      render: (row) => row.name ?? row.allowed.email,
    },
    {
      key: "email",
      header: "Correo",
      from: "md",
      listSlot: "secondary",
      width: "34%",
      text: (row) => row.allowed.email,
      render: (row) => (
        <span style={{ color: "var(--color-ink-soft)" }}>{row.allowed.email}</span>
      ),
    },
    {
      key: "rol",
      header: "Rol",
      from: "md",
      listSlot: "secondary",
      text: (row) => ROL[row.allowed.role],
      render: (row) => ROL[row.allowed.role],
    },
    {
      key: "totp",
      header: "Entrada",
      from: "md",
      listSlot: "trailing",
      text: (row) => row.totp,
      render: (row) =>
        row.allowed.role === "staff" ? (
          <EstadoTotp estado={row.totp} lockedUntil={row.lockedUntil} />
        ) : (
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
            Cuenta del estudio
          </span>
        ),
    },
  ];
}

const ROL: Record<PanelAccount["allowed"]["role"], string> = {
  owner: "Dueña",
  admin: "Recepción",
  staff: "Técnica",
};

const meta: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-2xs)",
  color: "var(--color-ink-soft)",
};

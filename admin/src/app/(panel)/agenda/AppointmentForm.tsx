"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";

import { ConflictReview } from "@/components/calendar";
import type { MetaIndex, ProviderOption, ServiceOption } from "@/components/calendar/types";
import styles from "@/components/calendar/calendar.module.css";
import { Button } from "@/components/ui/Button";
import { Checkbox, Field, Select, TextArea, TextInput } from "@/components/ui/Field";
import { formatCOP, formatDuration, formatPhoneCO } from "@/components/ui/format";
import { STATUS_IDS, STATUS_META } from "@/components/ui/status";
import {
  comboServiceIds,
  composeFrom,
  pairedServiceId,
  partnersFor,
  quoteCombo,
  roleOf,
  type ComboComposition,
} from "@/lib/combos";
import type { ConflictReport } from "@/lib/conflict";
import { crearClienta } from "../clientes/actions";
import { splitTermino } from "./customer-name";
import { findCustomers } from "./actions";

/**
 * El formulario de la cita: crear, mover, editar.
 *
 * Es el "modal de cita" de EA reconstruido (§ Paridad con EA), con dos
 * diferencias que importan:
 *
 * - **La clienta se busca por nombre o teléfono, y se elige de una lista.** No
 *   hay campo de correo: la identidad de la clienta en este proyecto es el
 *   teléfono en E.164 y el flujo viejo inventaba direcciones. Y se puede **crear
 *   acá mismo**, con nombre y apellido en campos separados y ya prellenados con
 *   lo que se escribió en el buscador: el caso más común del mostrador es
 *   alguien que llama y no está en la agenda, y volver a teclear el nombre que
 *   se acaba de teclear es cómo se termina apuntándolo en un papel.
 * - **El fin se deriva de la duración del servicio** y se puede corregir a mano.
 *   Escribir dos horas para cada cita es el trabajo que la agenda existe para
 *   ahorrar.
 * - **A los combos se llega componiendo, no eligiéndolos.** La lista de
 *   servicios esconde los combos; se elige el de manos y aparece "¿también
 *   pies?" con lo que lo acompaña. Al resolver el par, la cita **es** el combo,
 *   con su precio y su duración propios, y la suma de las dos mitades se muestra
 *   tachada al lado para que el descuento se vea. Ver `lib/combos.ts`.
 * - **El horario de la profesional se puede ignorar a propósito**, con una
 *   casilla. No tapa nada más: un choque con otra cita o con los puestos sigue
 *   avisando, porque eso no es política de horario sino una silla que no existe.
 *
 * El chequeo de choques no está acá: lo hace el servidor al enviar, contra datos
 * frescos, y si hay algo devuelve el reporte para que este formulario lo muestre
 * y reofrezca con "Guardar de todas formas".
 */

export type AppointmentDraft = {
  id?: number;
  providerId: number;
  serviceId: number | null;
  customerId: number | null;
  customerName: string | null;
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`. */
  startTime: string;
  endTime: string;
  notes: string;
  status: string;
  /**
   * Agendar aunque quede fuera del plan de trabajo de la profesional.
   *
   * Es la palanca de "hoy Lina se queda hasta las 9". Viaja con el borrador y
   * no como un argumento suelto de `onSubmit` porque sobrevive al ciclo
   * enviar → reporte de choques → reofrecer: perderla en ese ida y vuelta haría
   * que el segundo intento volviera a quejarse de lo que ya se decidió.
   */
  allowOutsideHours: boolean;
};

export type AppointmentFormProps = {
  draft: AppointmentDraft;
  providers: readonly ProviderOption[];
  services: readonly ServiceOption[];
  /** Los combos, en ids de EA. Ver `lib/combos.ts`. */
  combos: readonly ComboComposition[];
  /** Por qué no se puede componer. `null` = se puede. */
  combosReason: string | null;
  meta: MetaIndex;
  /** El reporte que devolvió el último envío, si lo hubo. */
  report: ConflictReport | null;
  error: string | null;
  saving: boolean;
  onSubmit: (draft: AppointmentDraft, force: boolean) => void;
  onCancel: () => void;
};

export function AppointmentForm({
  draft: initial,
  providers,
  services,
  combos,
  combosReason,
  meta,
  report,
  error,
  saving,
  onSubmit,
  onCancel,
}: AppointmentFormProps) {
  // El borrador arranca del que llega y a partir de ahí es estado interno. **No
  // se sincroniza con un efecto**: cuando cambia la cita que se edita, el padre
  // remonta el formulario con una `key` distinta. Un efecto que copiara la prop
  // al estado produciría un render en cascada en cada apertura.
  const [draft, setDraft] = useState<AppointmentDraft>(initial);
  const errorRef = useRef<HTMLDivElement>(null);

  // El resumen de error recibe el foco al aparecer: en un celular, quien envía
  // no ve la mitad del formulario y el mensaje quedaría fuera de pantalla.
  useEffect(() => {
    if (error || report) errorRef.current?.focus();
  }, [error, report]);

  const set = <K extends keyof AppointmentDraft>(key: K, value: AppointmentDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const service = services.find((s) => s.id === draft.serviceId) ?? null;

  // ── Composición del combo ────────────────────────────────────────────────
  //
  // El par se **deriva** de `draft.serviceId`, no se guarda aparte: si la cita
  // ya es un combo, sus dos mitades salen de la composición. Así, abrir una
  // cita vieja de combo la muestra compuesta sin que haya que reconstruir nada,
  // y no existe el estado intermedio donde el par dice una cosa y el servicio
  // que se va a guardar dice otra.
  //
  // Lo único que sí es estado es cuál de las dos mitades se eligió primero, y
  // solo para que la lista principal no salte sola de "pies" a "manos" debajo
  // del cursor al elegir el acompañante.
  const [firstPick, setFirstPick] = useState<number | null>(null);

  const { baseId, partnerId } = useMemo(
    () => composeFrom(combos, draft.serviceId, firstPick),
    [combos, draft.serviceId, firstPick],
  );

  // `ServiceOption` dice `duration` y `ComboPart` dice `durationMin`: la
  // traducción va acá, en el borde, y no cambiándole el nombre al campo de uno
  // de los dos. `lib/combos.ts` habla el idioma de la vitrina —donde la
  // duración siempre lleva la unidad en el nombre— y la grilla habla el de EA.
  const parts = useMemo(
    () =>
      services.map((s) => ({
        id: s.id,
        name: s.name,
        priceCOP: s.priceCOP,
        durationMin: s.duration,
      })),
    [services],
  );

  const quote = useMemo(
    () => quoteCombo(combos, parts, baseId, partnerId),
    [combos, parts, baseId, partnerId],
  );

  /**
   * La lista principal, sin combos.
   *
   * Un combo no se elige: se compone. Dejarlo también en la lista sería dar dos
   * caminos al mismo sitio, y el de la lista es el que se toma por error cuando
   * lo que se quería era el servicio suelto de al lado.
   *
   * La excepción es el servicio que la cita ya trae: si las composiciones no se
   * pudieron leer, esconderlo dejaría el selector en blanco sobre una cita que
   * sí tiene servicio, y guardar la borraría.
   */
  const pickable = useMemo(() => {
    const hidden = comboServiceIds(combos);
    return services.filter((s) => !hidden.has(s.id) || s.id === baseId);
  }, [services, combos, baseId]);

  /** Con qué se puede acompañar el servicio elegido. Vacío = no hay combo. */
  const partners = useMemo(() => {
    const ids = new Set(partnersFor(combos, baseId));
    return services.filter((s) => ids.has(s.id));
  }, [combos, services, baseId]);

  const baseRole = roleOf(combos, baseId);

  /** Al elegir servicio, el fin se recalcula con su duración. */
  const pickService = (id: number | null) => {
    const chosen = services.find((s) => s.id === id) ?? null;
    setFirstPick(id);
    setDraft((current) => ({
      ...current,
      serviceId: id,
      endTime: chosen?.duration
        ? addMinutesToTime(current.startTime, chosen.duration)
        : current.endTime,
    }));
  };

  /**
   * Elegir (o quitar) la otra mitad.
   *
   * Al ponerla, el servicio de la cita pasa a ser **el combo**: un id distinto,
   * con su propio precio y su propia duración, que es lo que se guarda en EA.
   * Al quitarla se vuelve al servicio suelto. En los dos casos el fin se
   * recalcula desde el inicio con la duración que corresponde, y nunca sumando:
   * la duración de un combo la fija la dueña y suele ser **menor** que la de sus
   * partes (`db/migrations/010-combo.ts`).
   */
  const pickPartner = (id: number | null) => {
    const next = pairedServiceId(combos, baseId, id);
    const chosen = services.find((s) => s.id === next) ?? null;
    setDraft((current) => ({
      ...current,
      serviceId: next,
      endTime: chosen?.duration
        ? addMinutesToTime(current.startTime, chosen.duration)
        : current.endTime,
    }));
  };

  /** Al correr el inicio, el fin se corre igual: la duración es lo que se pactó. */
  const pickStart = (value: string) => {
    setDraft((current) => {
      const length = minutesBetweenTimes(current.startTime, current.endTime);
      return {
        ...current,
        startTime: value,
        endTime: length > 0 ? addMinutesToTime(value, length) : current.endTime,
      };
    });
  };

  const length = minutesBetweenTimes(draft.startTime, draft.endTime);
  const incomplete = draft.customerId === null || draft.serviceId === null || length <= 0;

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (!incomplete) onSubmit(draft, false);
      }}
    >
      {error || report ? (
        <div ref={errorRef} tabIndex={-1}>
          {error ? (
            <div className={styles.conflictItem + " " + styles.conflictHard}>
              <p className={styles.conflictHead}>{error}</p>
            </div>
          ) : null}
          {report ? (
            <ConflictReview report={report} providers={providers} meta={meta} />
          ) : null}
        </div>
      ) : null}

      <CustomerPicker
        customerId={draft.customerId}
        customerName={draft.customerName}
        onPick={(customer) =>
          setDraft((current) => ({
            ...current,
            customerId: customer?.id ?? null,
            customerName: customer?.name ?? null,
          }))
        }
      />

      <Field label="Servicio" required>
        {(wired) => (
          <Select
            {...wired}
            value={baseId ?? ""}
            onChange={(e) => pickService(e.target.value === "" ? null : Number(e.target.value))}
          >
            <option value="">Elige un servicio…</option>
            {pickable.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
                {option.duration ? ` · ${formatDuration(option.duration)}` : ""}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {/* La otra mitad. Solo aparece cuando lo elegido es parte de un combo, y
          solo ofrece lo que forma uno de verdad: un par sin combo no tiene
          precio ni duración que mostrar, y ofrecerlo sería un callejón. */}
      {partners.length > 0 ? (
        <Field
          label={baseRole === "feet" ? "¿También manos?" : "¿También pies?"}
          hint="Se agenda como combo: un solo turno, con su propio precio."
        >
          {(wired) => (
            <Select
              {...wired}
              value={partnerId ?? ""}
              onChange={(e) =>
                pickPartner(e.target.value === "" ? null : Number(e.target.value))
              }
            >
              <option value="">No, solo {baseRole === "feet" ? "pies" : "manos"}</option>
              {partners.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}

      {/* El "antes y después". Solo se tacha cuando hay ahorro de verdad: un
          tachado que no ahorra nada es publicidad falsa dentro del panel. */}
      {quote ? (
        <div className={styles.combo}>
          <span className={styles.comboName}>{service?.name ?? "Combo"}</span>
          {quote.discounted && quote.partsPriceCOP !== null ? (
            <span className={styles.comboWas}>
              {formatCOP(quote.partsPriceCOP)}
              {quote.partsDurationMin !== null
                ? ` · ${formatDuration(quote.partsDurationMin)}`
                : ""}
            </span>
          ) : null}
          <span className={styles.comboNow}>
            {quote.comboPriceCOP !== null ? formatCOP(quote.comboPriceCOP) : "Sin precio en la agenda"}
            {quote.comboDurationMin !== null
              ? ` · ${formatDuration(quote.comboDurationMin)}`
              : ""}
          </span>
          {quote.discounted && quote.saving !== null ? (
            <span className={styles.comboSaving}>Ahorra {formatCOP(quote.saving)}</span>
          ) : null}
        </div>
      ) : null}

      {/* Sin composiciones los combos siguen existiendo como servicios sueltos;
          lo que no se puede es llegar a ellos eligiendo sus mitades. Se dice, en
          vez de que la función desaparezca sin explicación. */}
      {combosReason ? <p className={styles.formPreview}>{combosReason}</p> : null}

      <Field label="Profesional" required>
        {(wired) => (
          <Select
            {...wired}
            value={draft.providerId}
            onChange={(e) => set("providerId", Number(e.target.value))}
          >
            {providers.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className={`${styles.formRow} ${styles.formRow2}`}>
        <Field label="Fecha" required>
          {(wired) => (
            <TextInput
              {...wired}
              type="date"
              value={draft.date}
              onChange={(e) => set("date", e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Empieza"
          required
          hint={length > 0 ? `Dura ${formatDuration(length)}` : undefined}
        >
          {(wired) => (
            <TextInput
              {...wired}
              type="time"
              step={300}
              value={draft.startTime}
              onChange={(e) => pickStart(e.target.value)}
            />
          )}
        </Field>
      </div>

      <div className={`${styles.formRow} ${styles.formRow2}`}>
        <Field
          label="Termina"
          required
          error={length <= 0 ? "Tiene que ser después de que empieza." : undefined}
        >
          {(wired) => (
            <TextInput
              {...wired}
              type="time"
              step={300}
              value={draft.endTime}
              onChange={(e) => set("endTime", e.target.value)}
            />
          )}
        </Field>

        {draft.id !== undefined ? (
          <Field label="Estado">
            {(wired) => (
              <Select
                {...wired}
                value={draft.status}
                onChange={(e) => set("status", e.target.value)}
              >
                {/* Las etiquetas del panel son las que `docs/DEV-LOCAL.md`
                    manda configurar en EA. Si alguien renombró la lista allá,
                    la cita se guarda con la cadena que se elija acá y el mapa
                    de estados la dibujará punteada — que es la señal correcta,
                    no un crash. */}
                {STATUS_IDS.map((id) => (
                  <option key={id} value={STATUS_META[id].label}>
                    {STATUS_META[id].label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </div>

      {/* Forzar fuera de horario, **antes** de enviar.
          Sin esto, agendar a alguien a las 7 de la mañana era enviar, leer un
          reporte de choques, y volver a apretar "Guardar de todas formas" —
          tres pasos para una decisión que ya estaba tomada al abrir el
          formulario. Y ese botón fuerza *todo*: también una doble reserva. Esta
          casilla apaga solo la política de horario. */}
      <Checkbox
        checked={draft.allowOutsideHours}
        onChange={(e) => set("allowOutsideHours", e.target.checked)}
        label="Agendar fuera del horario de la profesional"
        hint="Ignora el plan de trabajo, los descansos y los días libres. Los choques con otra cita o con los puestos siguen avisando."
      />

      <Field
        label="Notas"
        hint="Las ve la técnica en su agenda. No es la cuenta del servicio."
      >
        {(wired) => (
          <TextArea
            {...wired}
            rows={2}
            value={draft.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        )}
      </Field>

      {service?.attendantsNumber && service.attendantsNumber > 1 ? (
        <p className={styles.formPreview}>
          Este servicio admite {service.attendantsNumber} clientas a la vez con la misma
          profesional.
        </p>
      ) : null}

      <div className={styles.formRow}>
        {report && !report.ok ? (
          // Las dos severidades se pueden forzar: es el mismo modelo mental del
          // `force_save` de EA. Lo que cambia es el tono, no la existencia del
          // botón.
          <Button
            variant={report.hard ? "danger" : "primary"}
            loading={saving}
            onClick={() => onSubmit(draft, true)}
            block
          >
            Guardar de todas formas
          </Button>
        ) : (
          <Button type="submit" variant="primary" loading={saving} disabled={incomplete} block>
            {draft.id === undefined ? "Crear cita" : "Guardar cambios"}
          </Button>
        )}
        <Button variant="ghost" onClick={onCancel} block>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Buscador de clientas
// ---------------------------------------------------------------------------

type Found = { id: number; name: string; phone: string | null };

/**
 * Buscar por nombre o teléfono y elegir de la lista.
 *
 * Se dispara a partir de dos letras y con un respiro de 300 ms: la búsqueda de
 * EA usa `q`, que **anula todos los demás filtros**, así que cada tecleo es una
 * consulta completa a su base.
 */
function CustomerPicker({
  customerId,
  customerName,
  onPick,
}: {
  customerId: number | null;
  customerName: string | null;
  onPick: (customer: Found | null) => void;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Found[]>([]);
  const [creating, setCreating] = useState(false);
  const [, startSearch] = useTransition();
  const listId = useId();

  const trimmed = term.trim();
  // Se **deriva** en vez de guardarse: con la clienta ya elegida, o con menos de
  // dos letras, no hay lista que mostrar, y borrar el estado desde el efecto
  // sería un render en cascada por tecla.
  const shown = customerId === null && trimmed.length >= 2 ? results : [];

  useEffect(() => {
    if (customerId !== null || trimmed.length < 2) return;

    const timer = setTimeout(() => {
      startSearch(async () => {
        try {
          setResults(await findCustomers(trimmed));
        } catch {
          // Una búsqueda que falla deja la lista vacía y el campo utilizable.
          // La cita se puede seguir armando; lo que no se puede es dejar el
          // formulario colgado por una consulta auxiliar.
          setResults([]);
        }
      });
    }, 300);

    return () => clearTimeout(timer);
  }, [trimmed, customerId]);

  const chosen = useMemo(
    () => (customerId !== null ? { id: customerId, name: customerName ?? "" } : null),
    [customerId, customerName],
  );

  if (chosen) {
    return (
      <Field label="Clienta" required>
        {() => (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ flex: 1, fontWeight: 600 }}>{chosen.name}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setTerm("");
                // Sin esto, "Cambiar" después de haber creado una clienta
                // volvía al alta —no al buscador— y con los campos vacíos,
                // porque el término ya se había borrado.
                setCreating(false);
                onPick(null);
              }}
            >
              Cambiar
            </Button>
          </div>
        )}
      </Field>
    );
  }

  // Con el alta abierta el buscador se esconde: sus campos ya vienen con lo que
  // se escribió ahí, y dejar los dos visibles mostraba el mismo nombre dos veces
  // — que se lee como "escríbelo otra vez", que es justo lo que no hay que
  // hacer. El término sigue a la vista, en texto, con su botón para corregirlo.
  if (creating) {
    return (
      <Field label="Clienta nueva" required>
        {() => (
          <AltaRapida
            termino={trimmed}
            onCreada={onPick}
            onCancelar={() => setCreating(false)}
          />
        )}
      </Field>
    );
  }

  return (
    <Field label="Clienta" required hint="Busca por nombre o teléfono.">
      {(wired) => (
        <>
          <TextInput
            {...wired}
            value={term}
            placeholder="Marcela, 300…"
            autoComplete="off"
            aria-controls={listId}
            aria-expanded={shown.length > 0}
            onChange={(e) => setTerm(e.target.value)}
          />
          {shown.length > 0 ? (
            <ul id={listId} className="ui-list" style={{ marginTop: "0.375rem" }}>
              {shown.map((found) => (
                <li key={found.id}>
                  <button
                    type="button"
                    className="ui-list__row"
                    data-interactive="true"
                    style={{ width: "100%", border: 0, background: "none", font: "inherit" }}
                    onClick={() => onPick(found)}
                  >
                    <span className="ui-list__body">
                      <span className="ui-list__primary">{found.name}</span>
                      <span className="ui-list__secondary">
                        {found.phone ? formatPhoneCO(found.phone) : "Sin teléfono"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {/*
            Crear sin salir del formulario.

            Sin esto, agendar a una clienta que no está en la agenda era
            imposible desde acá: el campo solo sabía buscar. En un estudio el
            caso es el más común que hay —suena el teléfono y es alguien
            nuevo— y la salida era irse a Clientas, crearla, volver, y rearmar
            la cita desde cero.
          */}
          {trimmed.length >= 2 && shown.length === 0 ? (
            <div style={{ marginTop: "0.375rem" }}>
              <p
                style={{
                  margin: "0 0 0.25rem",
                  fontSize: "var(--text-2xs)",
                  color: "var(--color-ink-soft)",
                }}
              >
                No aparece ninguna.
              </p>
              <Button size="sm" onClick={() => setCreating(true)}>
                Crear «{trimmed}»
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Field>
  );
}

/**
 * Alta de clienta desde el formulario de cita: nombre, apellido y teléfono.
 *
 * Los otros campos —correo, notas— se llenan después en la ficha. Acá hay una
 * clienta esperando al teléfono, y cada campo de más es una razón para no
 * usarlo y volver a apuntar el nombre en un papel.
 *
 * ## Nada se teclea dos veces
 *
 * Los tres campos llegan **prellenados con lo que se acaba de escribir en el
 * buscador**, y el buscador se esconde mientras esto está abierto. Si se buscó
 * "Ana Ríos", el nombre dice "Ana" y el apellido "Ríos"; si se buscó un número,
 * el teléfono ya lo tiene. Quien abre esto viene de escribir el nombre: pedirle
 * que lo escriba otra vez, debajo del que ya escribió, es el momento exacto en
 * que la clienta se apunta en un papel y nunca entra a la agenda.
 *
 * ## Nombre y apellido van separados, y no por formalidad
 *
 * Antes era un solo campo y el servidor lo partía en el primer espacio
 * (`splitName`). Con "Ana María Ríos" eso deja el nombre en "Ana" y el apellido
 * en "María Ríos" — mal, para siempre, y en la ficha de una persona real. Quien
 * está al teléfono sabe dónde termina el nombre; adivinarlo por ella era
 * inventar un dato pudiendo preguntarlo.
 *
 * **El teléfono es obligatorio igual**, y no por rigor: es la identidad de la
 * clienta en todo el panel. Una clienta sin número es una que mañana se
 * duplica, porque nada la puede reconocer.
 */
function AltaRapida({
  termino,
  onCreada,
  onCancelar,
}: {
  termino: string;
  onCreada: (customer: Found) => void;
  onCancelar: () => void;
}) {
  const inicial = useMemo(() => splitTermino(termino), [termino]);

  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [nombre, setNombre] = useState(inicial.nombre);
  const [apellido, setApellido] = useState(inicial.apellido);
  const [telefono, setTelefono] = useState(inicial.telefono);

  const faltaNombre = nombre.trim() === "";
  const faltaApellido = apellido.trim() === "";
  const faltaTelefono = telefono.trim() === "";

  const crear = async () => {
    setGuardando(true);
    setError(null);

    const r = await crearClienta({
      firstName: nombre,
      lastName: apellido,
      phone: telefono,
      email: "",
      notes: "",
    });
    setGuardando(false);

    // Se selecciona sola: quien la creó estaba armando una cita, no dando de
    // alta a alguien. Devolverlo al buscador sería cobrarle el paso dos veces.
    if (r.ok && r.customer) {
      onCreada({ id: r.customer.id, name: r.customer.name, phone: telefono });
      return;
    }
    setError(r.message);
  };

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <div className={`${styles.formRow} ${styles.formRow2}`}>
        <Field label="Nombre" required>
          {(w) => (
            <TextInput
              {...w}
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Ana"
              maxLength={120}
              autoComplete="off"
            />
          )}
        </Field>
        <Field
          label="Apellido"
          required
          hint="La agenda lo exige; sin él no se puede guardar la ficha."
        >
          {(w) => (
            <TextInput
              {...w}
              value={apellido}
              onChange={(e) => setApellido(e.target.value)}
              placeholder="Ríos"
              maxLength={120}
              autoComplete="off"
            />
          )}
        </Field>
      </div>

      <Field label="Teléfono" required hint="Es la identidad de la clienta.">
        {(w) => (
          <TextInput
            {...w}
            value={telefono}
            onChange={(e) => setTelefono(e.target.value)}
            inputMode="tel"
            maxLength={30}
            autoComplete="off"
          />
        )}
      </Field>

      {error ? (
        <p role="status" style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-error-ink)" }}>
          {error}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: "0.375rem" }}>
        <Button
          size="sm"
          variant="primary"
          loading={guardando}
          disabled={faltaNombre || faltaApellido || faltaTelefono}
          onClick={() => void crear()}
        >
          Crear y usar
        </Button>
        <Button size="sm" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horas
// ---------------------------------------------------------------------------

/**
 * `"14:00"` + 90 → `"15:30"`.
 *
 * Aritmética sobre minutos de reloj, no sobre un `Date`: la hora de pared es el
 * tipo canónico de este proyecto y construir una fecha para sumarle minutos es
 * cómo se cuela el bug de cinco horas. Pasadas las 24 h se queda en 23:59: una
 * cita que cruza la medianoche se escribe cambiando la fecha, no dejando que un
 * campo de hora desborde en silencio.
 */
function addMinutesToTime(time: string, minutes: number): string {
  const total = toMinutes(time);
  if (total === null) return time;
  const next = Math.min(23 * 60 + 59, total + minutes);
  return `${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`;
}

function minutesBetweenTimes(from: string, till: string): number {
  const a = toMinutes(from);
  const b = toMinutes(till);
  if (a === null || b === null) return 0;
  return b - a;
}

function toMinutes(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

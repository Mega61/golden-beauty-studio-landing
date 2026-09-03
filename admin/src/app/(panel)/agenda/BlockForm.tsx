"use client";

import { useMemo, useState } from "react";

import styles from "@/components/calendar/calendar.module.css";
import type { ProviderOption } from "@/components/calendar/types";
import { Button } from "@/components/ui/Button";
import { Checkbox, Field, FormErrorSummary, Select, TextInput } from "@/components/ui/Field";
import type { EaLocalDate } from "@/lib/ea/datetime";
import { describePlan, planBlock, type BlockForm as BlockFormValues } from "./block-resource";

/**
 * "Bloquear": **un botón y un formulario** para los tres recursos de EA.
 *
 * EA obliga a saber si lo que se quiere es un `blocked_period`, una
 * `unavailability` o una `working_plan_exception`. Este formulario no pregunta
 * eso: pregunta **quién** y **cuándo**, y `planBlock()` elige. Es una de las
 * pocas partes donde el panel es estrictamente mejor que EA.
 *
 * Lo que no se hace es esconder la consecuencia: debajo del botón hay una línea
 * que dice en voz alta qué se va a escribir ("Se van a registrar 2 ausencias de
 * la profesional"). Esconder el nombre técnico no puede significar que la
 * usuaria no sepa qué firmó.
 */

export type BlockFormProps = {
  providers: readonly ProviderOption[];
  /** Prellenado desde la grilla: el día que se estaba mirando. */
  date: EaLocalDate;
  /** Prellenado cuando se abrió desde la columna de alguien. */
  providerId?: number | null;
  /** Una técnica solo puede bloquearse a sí misma. */
  lockedProviderId?: number | null;
  saving: boolean;
  error: string | null;
  onSubmit: (values: BlockFormValues) => void;
  onCancel: () => void;
};

export function BlockForm({
  providers,
  date,
  providerId = null,
  lockedProviderId = null,
  saving,
  error,
  onSubmit,
  onCancel,
}: BlockFormProps) {
  const [values, setValues] = useState<BlockFormValues>({
    scope: lockedProviderId !== null ? "profesional" : providerId !== null ? "profesional" : "estudio",
    providerId: lockedProviderId ?? providerId,
    kind: "ausencia",
    startDate: date,
    endDate: date,
    allDay: false,
    startTime: "09:00",
    endTime: "13:00",
    reason: "",
  });
  const [submitted, setSubmitted] = useState(false);

  const set = <K extends keyof BlockFormValues>(key: K, value: BlockFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const planned = useMemo(() => planBlock(values), [values]);
  const errors = planned.ok ? [] : planned.errors;

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (planned.ok) onSubmit(values);
      }}
    >
      {error ? (
        <div className={`${styles.conflictItem} ${styles.conflictHard}`}>
          <p className={styles.conflictHead}>{error}</p>
        </div>
      ) : null}

      {submitted && errors.length > 0 ? (
        <FormErrorSummary
          errors={errors.map((e) => ({ id: `campo-${e.field}`, message: e.message }))}
        />
      ) : null}

      {/* La primera pregunta es la que decide el recurso, y por eso es la que
          tiene el tamaño. */}
      <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="ui-label" style={{ marginBottom: "0.375rem" }}>
          ¿A quién le aplica?
        </legend>
        <div className={styles.choices}>
          {lockedProviderId === null ? (
            <label className={styles.choice}>
              <input
                type="radio"
                name="alcance"
                checked={values.scope === "estudio"}
                onChange={() => setValues((c) => ({ ...c, scope: "estudio" }))}
              />
              <span className={styles.choiceText}>
                <span className={styles.choiceTitle}>Todo el estudio</span>
                <span className={styles.choiceHint}>
                  Un festivo, vacaciones, una obra. Tapa a todas las profesionales.
                </span>
              </span>
            </label>
          ) : null}

          <label className={styles.choice}>
            <input
              type="radio"
              name="alcance"
              checked={values.scope === "profesional"}
              onChange={() => setValues((c) => ({ ...c, scope: "profesional" }))}
            />
            <span className={styles.choiceText}>
              <span className={styles.choiceTitle}>Una profesional</span>
              <span className={styles.choiceHint}>
                No está un rato, o ese día trabaja en otro horario.
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      {values.scope === "profesional" ? (
        <>
          <Anchored field="providerId">
            <Field label="Profesional" required error={errorFor(errors, "providerId", submitted)}>
              {(wired) => (
                <Select
                  {...wired}
                  value={values.providerId ?? ""}
                  disabled={lockedProviderId !== null}
                  onChange={(e) =>
                    set("providerId", e.target.value === "" ? null : Number(e.target.value))
                  }
                >
                  <option value="">Elige a quién…</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </Anchored>

          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="ui-label" style={{ marginBottom: "0.375rem" }}>
              ¿Qué pasa?
            </legend>
            <div className={styles.choices}>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name="tipo"
                  checked={values.kind === "ausencia"}
                  onChange={() => set("kind", "ausencia")}
                />
                <span className={styles.choiceText}>
                  <span className={styles.choiceTitle}>No está en ese rato</span>
                  <span className={styles.choiceHint}>
                    Su jornada sigue siendo la de siempre; ese tramo queda ocupado.
                  </span>
                </span>
              </label>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name="tipo"
                  checked={values.kind === "horario"}
                  onChange={() => set("kind", "horario")}
                />
                <span className={styles.choiceText}>
                  <span className={styles.choiceTitle}>Ese día trabaja en otro horario</span>
                  <span className={styles.choiceHint}>
                    Entra o sale a otra hora. Con «todo el día» marcado, es día libre.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>
        </>
      ) : null}

      <div className={`${styles.formRow} ${styles.formRow2}`}>
        <Anchored field="startDate">
          <Field label="Desde el día" required error={errorFor(errors, "startDate", submitted)}>
            {(wired) => (
              <TextInput
                {...wired}
                type="date"
                value={values.startDate}
                onChange={(e) =>
                  setValues((current) => ({
                    ...current,
                    startDate: e.target.value as EaLocalDate,
                    // El fin sigue al inicio mientras no se haya separado a mano:
                    // el caso de un solo día es el 90 % y no debería costar dos
                    // gestos.
                    endDate:
                      current.endDate < e.target.value
                        ? (e.target.value as EaLocalDate)
                        : current.endDate,
                  }))
                }
              />
            )}
          </Field>
        </Anchored>
        <Anchored field="endDate">
          <Field label="Hasta el día" required error={errorFor(errors, "endDate", submitted)}>
            {(wired) => (
              <TextInput
                {...wired}
                type="date"
                value={values.endDate}
                min={values.startDate}
                onChange={(e) => set("endDate", e.target.value as EaLocalDate)}
              />
            )}
          </Field>
        </Anchored>
      </div>

      <Checkbox
        label={values.kind === "horario" && values.scope === "profesional" ? "Día libre" : "Todo el día"}
        hint={
          values.kind === "horario" && values.scope === "profesional"
            ? "Ese día no trabaja."
            : undefined
        }
        checked={values.allDay}
        onChange={(e) => set("allDay", e.target.checked)}
      />

      {!values.allDay ? (
        <div className={`${styles.formRow} ${styles.formRow2}`}>
          <Anchored field="startTime">
            <Field label="Desde las" required error={errorFor(errors, "startTime", submitted)}>
              {(wired) => (
                <TextInput
                  {...wired}
                  type="time"
                  step={300}
                  value={values.startTime ?? ""}
                  onChange={(e) => set("startTime", e.target.value)}
                />
              )}
            </Field>
          </Anchored>
          <Anchored field="endTime">
            <Field label="Hasta las" required error={errorFor(errors, "endTime", submitted)}>
              {(wired) => (
                <TextInput
                  {...wired}
                  type="time"
                  step={300}
                  value={values.endTime ?? ""}
                  onChange={(e) => set("endTime", e.target.value)}
                />
              )}
            </Field>
          </Anchored>
        </div>
      ) : null}

      <Field label="Motivo" hint="Se ve en la agenda. Opcional.">
        {(wired) => (
          <TextInput
            {...wired}
            value={values.reason}
            placeholder="Festivo, cita médica, capacitación…"
            onChange={(e) => set("reason", e.target.value)}
          />
        )}
      </Field>

      {planned.ok ? (
        <p className={styles.formPreview}>{describePlan(planned.plan, planned.days)}</p>
      ) : null}

      <div className={styles.formRow}>
        <Button type="submit" variant="primary" loading={saving} block>
          Bloquear
        </Button>
        <Button variant="ghost" onClick={onCancel} block>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/**
 * Un ancla para el resumen de errores.
 *
 * `Field` genera su propio `id` con `useId()` y se lo da al input, así que el
 * `<label for>` apunta ahí; pisarlo desde afuera rompería esa asociación, que es
 * justo lo que hace que el campo sea utilizable con lector de pantalla. El
 * resumen enlaza entonces al **contenedor** del campo, que sí tiene un id
 * estable, y el navegador desplaza igual hasta él.
 */
function Anchored({ field, children }: { field: string; children: React.ReactNode }) {
  return <div id={`campo-${field}`}>{children}</div>;
}

function errorFor(
  errors: ReadonlyArray<{ field: string; message: string }>,
  field: string,
  submitted: boolean,
): string | undefined {
  if (!submitted) return undefined;
  return errors.find((e) => e.field === field)?.message;
}

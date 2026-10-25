"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { formatDateLong, formatHour12, MONTHS } from "./format";
import { Icon } from "./Icon";
import {
  filterOptions,
  isHHMM,
  monthGrid,
  parseIsoDate,
  parseTypedTime,
  shiftIsoDate,
  shiftMonth,
  timeOptions,
  type PickerOption,
} from "./picker-model";

/**
 * Selectores propios: `Combobox`, `DateField` y `TimeField`.
 *
 * ## Por qué no el `<select>` nativo
 *
 * En el celular el `<select>` y los `<input type="date|time">` abren el
 * selector **del sistema**: la rueda de iOS, el diálogo de Android. Se ve
 * distinto en cada teléfono, tapa el formulario y —lo que más pesa— no deja
 * buscar: con veinte servicios, encontrar "Semipermanente pies" es girar una
 * rueda a ciegas. Estos componentes se dibujan igual en todas partes.
 *
 * ## La lista se abre dentro del formulario, no flotando
 *
 * El panel se abre **en el flujo**, empujando lo de abajo, igual que el
 * buscador de clientas. Un popover flotante dentro de una hoja con scroll se
 * recorta contra el borde, y en el celular el teclado le tapa la mitad. En el
 * flujo, el navegador lo lleva a la vista solo al enfocar la búsqueda.
 *
 * ## Se cablean con `Field`
 *
 * Reciben `id`, `describedBy` e `invalid` igual que `TextInput`: el `<label>`
 * de `Field` apunta al botón, que es el control.
 */

type Wired = { id: string; describedBy?: string; invalid?: boolean };

type Key = string | number | null;

/** Desde cuántas opciones aparece la búsqueda si no se dice nada. */
const SEARCH_FROM = 8;

export type ComboboxProps<V extends Key> = Wired & {
  value: V;
  options: readonly PickerOption<V>[];
  onChange: (value: V) => void;
  /** Lo que se lee en el botón cuando no hay nada elegido. */
  placeholder?: string;
  /** Con búsqueda. Por defecto, cuando hay más de ocho opciones. */
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  /** Abrir al montar: "+ Agregar otro servicio" ya es la decisión de elegir uno. */
  defaultOpen?: boolean;
  /** Se cerró sin elegir (Escape, clic afuera). */
  onDismiss?: () => void;
  /**
   * La opción que corresponde a lo escrito: va primera en la lista, y si no
   * estaba se agrega ("Usar 9:10 a. m."). Solo con búsqueda.
   */
  customOption?: (query: string) => PickerOption<V> | null;
};

export function Combobox<V extends Key>({
  id,
  describedBy,
  invalid,
  value,
  options,
  onChange,
  placeholder = "Elige…",
  searchable,
  searchPlaceholder = "Buscar…",
  emptyText = "Nada coincide con lo que escribiste.",
  disabled = false,
  defaultOpen = false,
  onDismiss,
  customOption,
}: ComboboxProps<V>) {
  const withSearch = searchable ?? options.length > SEARCH_FROM;
  const listId = useId();
  const optionId = (index: number) => `${listId}-o${index}`;

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex === -1 ? null : options[selectedIndex];

  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(Math.max(0, selectedIndex));

  const shown = useMemo(() => {
    if (!withSearch) return options;
    const found = filterOptions(options, query);
    const extra = customOption?.(query) ?? null;
    if (extra === null) return found;
    // Lo que se escribió va primero: si ya está en la lista, se sube; si no,
    // se agrega. "10:00" tiene que elegir las 10 a. m. con Enter, no la
    // primera hora cuyo rótulo empiece igual.
    const same = found.find((o) => o.value === extra.value);
    return same ? [same, ...found.filter((o) => o !== same)] : [extra, ...found];
  }, [withSearch, options, query, customOption]);

  const openList = () => {
    if (disabled) return;
    setQuery("");
    setActive(Math.max(0, selectedIndex));
    setOpen(true);
  };

  const close = (refocus: boolean, dismissed: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
    if (dismissed) onDismiss?.();
  };

  const choose = (option: PickerOption<V>) => {
    onChange(option.value);
    close(true, false);
  };

  // Al abrir, el foco va a la búsqueda (o a la lista) y lo elegido a la vista.
  useEffect(() => {
    if (!open) return;
    if (withSearch) searchRef.current?.focus();
    else listRef.current?.focus();
  }, [open, withSearch]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // `optionId` es estable por `listId`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  // Un toque fuera lo cierra, sin robarle el foco a lo que se tocó.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false, true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((i) => Math.min(shown.length - 1, i + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        if (!withSearch) {
          event.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (!withSearch) {
          event.preventDefault();
          setActive(shown.length - 1);
        }
        break;
      case "Enter": {
        // Enter dentro de un `<form>` lo enviaría: acá elige.
        event.preventDefault();
        const option = shown[active];
        if (option) choose(option);
        break;
      }
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close(true, true);
        break;
      case "Tab":
        close(false, true);
        break;
    }
  };

  const activeId = shown.length > 0 ? optionId(Math.min(active, shown.length - 1)) : undefined;

  return (
    <div className="ui-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        className="ui-select ui-picker__trigger"
        data-empty={selected === null ? "true" : undefined}
        // El valor crudo, para quien lo necesite leer sin pasar por el rótulo
        // ("12:00" y no "12 p. m."): las pruebas de punta a punta.
        data-value={value === null ? "" : String(value)}
        onClick={() => (open ? close(false, true) : openList())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openList();
          }
        }}
      >
        <span className="ui-picker__value">{selected?.label ?? placeholder}</span>
        {selected?.detail ? <span className="ui-picker__detail">{selected.detail}</span> : null}
      </button>

      {open ? (
        <div className="ui-picker__panel">
          {withSearch ? (
            <div className="ui-picker__search">
              <Icon name="buscar" size={16} />
              <input
                ref={searchRef}
                type="text"
                // `search` en iOS cambia la tecla de enviar por "Buscar", que
                // aquí no busca nada: la lista ya está filtrada.
                enterKeyHint="done"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                aria-label={searchPlaceholder}
                aria-controls={listId}
                aria-activedescendant={activeId}
                placeholder={searchPlaceholder}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
              />
            </div>
          ) : null}

          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={withSearch ? -1 : 0}
            aria-activedescendant={withSearch ? undefined : activeId}
            aria-labelledby={id}
            className="ui-picker__list"
            onKeyDown={withSearch ? undefined : onKeyDown}
          >
            {shown.map((option, index) => (
              <li
                key={String(option.value)}
                id={optionId(index)}
                role="option"
                aria-selected={option.value === value}
                data-value={option.value === null ? "" : String(option.value)}
                data-active={index === active ? "true" : undefined}
                className="ui-picker__option"
                onPointerMove={() => setActive(index)}
                onClick={() => choose(option)}
              >
                <span className="ui-picker__body">
                  <span>{option.label}</span>
                  {option.detail ? (
                    <span className="ui-picker__detail">{option.detail}</span>
                  ) : null}
                </span>
                {option.value === value ? <Icon name="check" size={16} /> : null}
              </li>
            ))}
            {shown.length === 0 ? (
              <li role="presentation" className="ui-picker__empty">
                {emptyText}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ── Hora ────────────────────────────────────────────────────────────────────

/**
 * La hora, en una lista que se busca escribiendo como se dice: "930", "2 pm",
 * "21:30". La lista va cada `step` minutos; una hora fuera de la grilla se
 * escribe y aparece "Usar 9:10 a. m.".
 */
export function TimeField({
  value,
  onChange,
  step = 15,
  from = "05:00",
  to = "23:00",
  ...rest
}: Wired & {
  /** `HH:MM`, 24 h. */
  value: string;
  onChange: (value: string) => void;
  step?: number;
  from?: string;
  to?: string;
  disabled?: boolean;
}) {
  const options = useMemo(
    () => timeOptions(step, { from, to, include: isHHMM(value) ? value : null }),
    [step, from, to, value],
  );

  return (
    <Combobox<string>
      {...rest}
      value={value}
      options={options}
      onChange={onChange}
      placeholder="Elige la hora"
      searchable
      searchPlaceholder="Escribe la hora: 930, 2 pm…"
      emptyText="No es una hora. Prueba con 930 o 2:30 pm."
      customOption={(query) => {
        const typed = parseTypedTime(query);
        if (typed === null) return null;
        const [h, m] = typed.split(":").map(Number);
        return { value: typed, label: `Usar ${formatHour12(h, m)}` };
      }}
    />
  );
}

// ── Fecha ───────────────────────────────────────────────────────────────────

const WEEKDAY_INITIALS = ["L", "M", "X", "J", "V", "S", "D"];
const WEEKDAY_NAMES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

/** Hoy en el estudio, no en el teléfono: un celular con otro huso no cambia el día. */
function studioToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
}

/**
 * La fecha, en un calendario propio de lunes a domingo.
 *
 * Teclado: flechas para moverse por días y semanas, Re Pág / Av Pág por meses,
 * Enter para elegir, Escape para cerrar.
 */
export function DateField({
  id,
  describedBy,
  invalid,
  value,
  onChange,
  min,
  disabled = false,
}: Wired & {
  /** `YYYY-MM-DD`. */
  value: string;
  onChange: (value: string) => void;
  /** El primer día que se puede elegir, `YYYY-MM-DD`. */
  min?: string;
  disabled?: boolean;
}) {
  const gridId = useId();
  const allowed = (day: string) => min === undefined || day >= min;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [focusDay, setFocusDay] = useState(value);
  const [view, setView] = useState(() => {
    const p = parseIsoDate(value) ?? parseIsoDate(studioToday())!;
    return { y: p.y, m: p.m };
  });
  // Solo se mueve el foco del teclado cuando lo pidió el teclado: al abrir con
  // el dedo no hace falta, y en el celular no debe saltar la pantalla.
  const [keyboard, setKeyboard] = useState(false);

  const today = open ? studioToday() : "";

  const openCalendar = (fromKeyboard: boolean) => {
    if (disabled) return;
    const start = parseIsoDate(value) ? value : studioToday();
    const p = parseIsoDate(start)!;
    setFocusDay(start);
    setView({ y: p.y, m: p.m });
    setKeyboard(fromKeyboard);
    setOpen(true);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const choose = (day: string) => {
    if (!allowed(day)) return;
    onChange(day);
    close(true);
  };

  const moveFocus = (day: string) => {
    const p = parseIsoDate(day);
    if (!p) return;
    setFocusDay(day);
    setView({ y: p.y, m: p.m });
    setKeyboard(true);
  };

  useEffect(() => {
    if (!open || !keyboard) return;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusDay}"]`)?.focus();
  }, [open, keyboard, focusDay]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onGridKeyDown = (event: KeyboardEvent) => {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in moves) {
      event.preventDefault();
      moveFocus(shiftIsoDate(focusDay, moves[event.key]));
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const p = parseIsoDate(focusDay)!;
      const next = shiftMonth(p.y, p.m, event.key === "PageUp" ? -1 : 1);
      const lastDay = new Date(Date.UTC(next.y, next.m, 0)).getUTCDate();
      moveFocus(
        `${next.y}-${String(next.m).padStart(2, "0")}-${String(Math.min(p.d, lastDay)).padStart(2, "0")}`,
      );
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };

  const weeks = monthGrid(view.y, view.m);
  const goMonth = (delta: number) => {
    const next = shiftMonth(view.y, view.m, delta);
    setView(next);
    setKeyboard(false);
  };

  // El día enfocable es el que tiene el foco si está en este mes; si no, el 1.
  const focusable = weeks.flat().includes(focusDay)
    ? focusDay
    : `${view.y}-${String(view.m).padStart(2, "0")}-01`;

  return (
    <div className="ui-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={gridId}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        className="ui-select ui-picker__trigger ui-picker__trigger--date"
        data-empty={parseIsoDate(value) ? undefined : "true"}
        data-value={value}
        onClick={() => (open ? close(false) : openCalendar(false))}
        onKeyDown={(event) => {
          if (!open && event.key === "ArrowDown") {
            event.preventDefault();
            openCalendar(true);
          }
        }}
      >
        <span className="ui-picker__value">
          {parseIsoDate(value) ? formatDateLong(`${value} 00:00:00`, true) : "Elige la fecha"}
        </span>
      </button>

      {open ? (
        <div className="ui-picker__panel ui-calendar" role="dialog" aria-label="Elegir fecha" id={gridId}>
          <div className="ui-calendar__head">
            <button
              type="button"
              className="ui-calendar__nav"
              aria-label="Mes anterior"
              onClick={() => goMonth(-1)}
            >
              <Icon name="chevron-izq" size={18} />
            </button>
            <span className="ui-calendar__title" aria-live="polite">
              {MONTHS[view.m - 1].charAt(0).toUpperCase() + MONTHS[view.m - 1].slice(1)} de {view.y}
            </span>
            <button
              type="button"
              className="ui-calendar__nav"
              aria-label="Mes siguiente"
              onClick={() => goMonth(1)}
            >
              <Icon name="chevron-der" size={18} />
            </button>
          </div>

          <div role="grid" ref={gridRef} className="ui-calendar__grid" onKeyDown={onGridKeyDown}>
            <div role="row" className="ui-calendar__row">
              {WEEKDAY_INITIALS.map((initial, i) => (
                <span key={initial} role="columnheader" className="ui-calendar__dow">
                  <abbr title={WEEKDAY_NAMES[i]}>{initial}</abbr>
                </span>
              ))}
            </div>
            {weeks.map((week, w) => (
              <div role="row" className="ui-calendar__row" key={w}>
                {week.map((day, d) =>
                  day === null ? (
                    <span key={d} role="gridcell" className="ui-calendar__blank" />
                  ) : (
                    <span key={day} role="gridcell" aria-selected={day === value}>
                      <button
                        type="button"
                        data-date={day}
                        tabIndex={day === focusable ? 0 : -1}
                        className="ui-calendar__day"
                        data-selected={day === value ? "true" : undefined}
                        data-today={day === today ? "true" : undefined}
                        aria-current={day === today ? "date" : undefined}
                        aria-label={formatDateLong(`${day} 00:00:00`, true)}
                        disabled={!allowed(day)}
                        onClick={() => choose(day)}
                      >
                        {Number(day.slice(8))}
                      </button>
                    </span>
                  ),
                )}
              </div>
            ))}
          </div>

          <div className="ui-calendar__foot">
            {[
              { label: "Ayer", day: shiftIsoDate(today, -1) },
              { label: "Hoy", day: today },
              { label: "Mañana", day: shiftIsoDate(today, 1) },
            ].map((pick) =>
              allowed(pick.day) ? (
                <button
                  key={pick.label}
                  type="button"
                  className="ui-calendar__link"
                  onClick={() => choose(pick.day)}
                >
                  {pick.label}
                </button>
              ) : null,
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export type { PickerOption };

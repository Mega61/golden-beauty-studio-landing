import type { Migration } from "./migration";

/**
 * La regla que rige hoy: **40 % plano para la técnica, sobre lo cobrado.**
 *
 * La tabla la creó la migración `007`; lo que faltaba era el dato. Hasta esta
 * migración `commission_rule` estaba vacía, y una tabla de reglas vacía no
 * significa "sin comisión": significa que el motor marca **todos** los
 * renglones con `sin-regla` y liquida ceros que nadie puede distinguir de ceros
 * correctos. La decisión pendiente que bloqueaba D1 (§ Lo que falta para
 * construirlo) ya está tomada por la dueña, y es una sola fila:
 *
 * | Campo | Valor | Por qué |
 * | --- | --- | --- |
 * | `ea_provider_id` | `NULL` | La tasa es la misma para todas |
 * | `category_id` | `NULL` | No hay tasa por categoría: "todo al 40 %" |
 * | `ea_service_id` | `NULL` | Ni excepción por servicio |
 * | `applies_to` | `ambos` | Los adicionales pagan igual que el principal |
 * | `kind` / `percent_bp` | `percent` / `4000` | 40 % en puntos básicos, entero |
 *
 * `percent_bp = 4000`, no `40` ni `0.4`. Es la convención 2 de `db/types.ts` y
 * la razón por la que la columna existe con ese nombre: un `40` que alguien
 * lea como fracción, o un `0.4` que se guarde en un `SMALLINT`, son los dos
 * errores de cuatro órdenes de magnitud que la representación en bp elimina.
 *
 * ## `applies_to = 'ambos'` y no dos filas
 *
 * Una sola regla `ambos` y no una `principal` + una `adicionales` con la misma
 * tasa. Dos filas empatarían en especificidad —las dos globales, las dos con el
 * mismo `valid_from`— y aunque `resolveRule()` desempata de forma determinista,
 * marcaría cada renglón como `regla-ambigua`. Una liquidación entera marcada
 * para revisión no es una advertencia: es ruido que enseña a ignorar la marca.
 *
 * ## `valid_from` y por qué no es hoy
 *
 * El 40 % es cómo se paga **desde antes** del panel, así que la vigencia no
 * puede empezar el día del despliegue: `matches()` descarta la regla para todo
 * renglón con fecha anterior a `valid_from`, y la primera quincena que se
 * liquidara —incluyendo días previos a la migración— saldría marcada y en cero.
 * `2026-01-01` cubre cualquier fila que `appointment_finance` pueda tener: la
 * tabla nació con este panel, en 2026. El histórico de Agenda Pro vive en
 * `legacy_appointment`, que no se comisiona.
 *
 * `valid_to` queda en `NULL` = vigente. Subir la tasa mañana **no** se hace
 * editando esta fila: se cierra con `closeAt()` y se inserta la nueva. Una
 * comisión ya liquidada tiene que poder explicarse con la regla que se le
 * aplicó, y reescribir la fila haría que la explicación cambiara sola.
 *
 * ## Por qué la siembra es condicional y no un `ON DUPLICATE KEY`
 *
 * `commission_rule` no tiene una llave única sobre la tupla semántica (a
 * propósito: el solape se valida al guardar, en el editor, porque MySQL no
 * tiene exclusión por rango), así que un `ON DUPLICATE KEY UPDATE` no tendría
 * con qué chocar y sembraría una fila nueva en cada corrida. El contrato del
 * set exige que cada sentencia sea idempotente por sí sola —el DDL hace commit
 * implícito y una migración a medias se retoma desde el principio—, así que la
 * condición es explícita: **se siembra solo si no existe ninguna regla global.**
 *
 * Eso también protege la decisión de la dueña. El día que cambie la tasa
 * quedará una regla global cerrada y otra vigente; una corrida posterior de las
 * migraciones (un contenedor nuevo, un `docker compose up`) no puede resucitar
 * el 40 % encima de eso.
 */
export const migration: Migration = {
  id: "018-commission-rule",
  description: "Siembra la regla global de comisión: 40 % sobre lo cobrado",
  statements: [
    `INSERT INTO commission_rule
       (ea_provider_id, category_id, ea_service_id, applies_to, kind, percent_bp, fixed_amount, valid_from, valid_to)
     SELECT NULL, NULL, NULL, 'ambos', 'percent', 4000, NULL, '2026-01-01', NULL
       FROM DUAL
      WHERE NOT EXISTS (
        SELECT 1 FROM commission_rule
         WHERE ea_provider_id IS NULL
           AND category_id IS NULL
           AND ea_service_id IS NULL
      )`,
  ],
};

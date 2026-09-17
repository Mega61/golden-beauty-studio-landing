import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * Los pagos de una cuenta. **Una cuenta puede cobrarse con más de un método.**
 *
 * Hasta acá `appointment_finance.payment_method` era un enum: *un* método por
 * cuenta. La dueña confirmó el 2026-09-17 que una clienta a veces paga una
 * parte en efectivo y transfiere el resto, y eso no se podía registrar sin
 * mentir en uno de los dos. La mentira no se quedaba quieta: salía por el
 * cierre del día, descuadrando el efectivo contra lo que hay en el cajón — que
 * es justo el número con el que se decide si el sistema es confiable.
 *
 * ## Por qué una tabla hija y no dos columnas de monto
 *
 * `004` y la `DayCloseTable` argumentan lo contrario para los totales del día
 * ("tres columnas y no una tabla hija, porque `PaymentMethod` tiene tres
 * valores fijos"), y ahí sigue siendo cierto: `day_close` guarda un agregado de
 * forma fija que se lee en cada pantalla de Caja. Acá el caso es otro. Una
 * cuenta no tiene un agregado, tiene *hechos*: entraron $60.000 en efectivo y
 * $40.000 por transferencia, y cada uno cruza hacia Strapi como su propia fila
 * `Payment` con su propia llave. Con columnas, agregar un método mañana
 * (Nequi, datáfono) sería una migración de esquema y un cambio en cada suma;
 * con filas es una fila.
 *
 * ## `payment_method` se queda en el encabezado, y no es una contradicción
 *
 * El plan de `docs/CORTE-AGENDAPRO.md` decía borrarla — tener el método en dos
 * lugares es tenerlo mal en uno de los dos. Pero el set de migraciones es
 * **forward-only y sin `DROP`** (ver `migration.ts`), y esa regla existe por
 * algo que acá aplica directo: el despliegue es por digest y el rollback es un
 * `git revert` del commit de despliegue. Si esta migración borrara la columna,
 * revertir a la imagen anterior dejaría al código viejo consultando una columna
 * que ya no existe — o sea, **el rollback dejaría de funcionar justo el día que
 * se necesite**, que es el día que este cambio salga mal.
 *
 * Así que expand/contract: la columna se queda, **esta tabla es la única fuente
 * de verdad**, y el código nuevo no la lee nunca. Se sigue escribiendo como
 * *shim* de rollback: con un solo método, su método; con dos, `NULL` — que el
 * código viejo muestra como "sin método", visible y reclamable, en vez de
 * afirmar un método que no es. El `DROP` es una migración posterior, cuando el
 * digest actual lleve semanas sin que nadie quiera volver atrás.
 *
 * ## Lo que NO está
 *
 * No hay `CHECK` de `Σ amount == amount_charged`: cruza dos tablas y MySQL no
 * lo puede expresar. Vive en `lib/ticket.ts`, al lado de la otra invariante
 * cruzada que ya estaba ahí por la misma razón. Poner acá una versión
 * aproximada daría la falsa sensación de que la base lo está cuidando.
 *
 * No hay UNIQUE sobre `(appointment_finance_id, method)`. Es tentador —"un
 * método una vez por cuenta"— y está mal: lo correcto es que la cuenta sume, no
 * que cada método aparezca una sola vez, y la UNIQUE convertiría un caso real
 * (dos transferencias de dos cuentas distintas de la misma clienta) en un error
 * de base de datos a mitad de un cierre. La suma la cuida `lib/ticket.ts`.
 *
 * `paid_at` no se duplica por pago: se cobra siempre el mismo día y sigue
 * siendo un solo instante, arriba, en el encabezado.
 *
 * ## El backfill
 *
 * Va en la misma migración y es idempotente: cada cuenta ya cerrada con método
 * y monto se convierte en un pago único por su `amount_charged`. El `NOT
 * EXISTS` es lo que deja correrla dos veces —el contrato del set exige que cada
 * sentencia lo aguante por sí sola, porque el DDL hace commit implícito y una
 * migración que falla a la mitad se retoma desde el principio.
 *
 * Las cuentas con método y `amount_charged` nulo no se migran: no hay monto que
 * asentar, y un cero sería afirmar que se cobró gratis.
 */
export const migration: Migration = {
  id: "019-appointment-payment",
  description: "Pagos por cuenta: una cuenta se puede cobrar con más de un método",
  statements: [
    `CREATE TABLE IF NOT EXISTS appointment_payment (
       id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       appointment_finance_id BIGINT UNSIGNED NOT NULL,
       method                 ENUM('efectivo','transferencia','otro') NOT NULL,
       amount                 INT NOT NULL,
       created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

       PRIMARY KEY (id),
       -- El orden de los pagos dentro de una cuenta es el orden de \`id\`, igual
       -- que los renglones. Importa: la propina viaja en el **primer** pago y
       -- en ninguno más, así que "primero" tiene que ser estable.
       KEY idx_ap_finance (appointment_finance_id, id),
       -- Los totales del día por método, que es la consulta de Caja.
       KEY idx_ap_method (method),

       CONSTRAINT fk_ap_finance FOREIGN KEY (appointment_finance_id)
         REFERENCES appointment_finance (id) ON DELETE CASCADE ON UPDATE CASCADE,

       -- Un pago de cero no es un pago: es una fila que infla el conteo y no
       -- mueve la plata. Negativo tampoco — una devolución no existe en la v1,
       -- y el día que exista será un ajuste con su propio id, no un pago con
       -- el signo cambiado.
       CONSTRAINT ck_ap_amount CHECK (amount > 0)
     ) ${TABLE_OPTIONS}`,

    `INSERT INTO appointment_payment (appointment_finance_id, method, amount)
     SELECT af.id, af.payment_method, af.amount_charged
       FROM appointment_finance af
      WHERE af.payment_method IS NOT NULL
        AND af.amount_charged IS NOT NULL
        AND af.amount_charged > 0
        AND NOT EXISTS (
          SELECT 1 FROM appointment_payment ap
           WHERE ap.appointment_finance_id = af.id
        )`,
  ],
};

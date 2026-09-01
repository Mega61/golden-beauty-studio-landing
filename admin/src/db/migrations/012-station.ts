import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * Los dos puestos físicos del estudio, y su siembra.
 *
 * El límite real no son las profesionales: son **dos estaciones de trabajo**.
 * Con tres técnicas en agenda, tres citas simultáneas son físicamente
 * imposibles, y **EA no tiene ningún concepto de sala, puesto o equipo** —
 * `attendantsNumber` es capacidad por servicio, no por local. Es la restricción
 * más fácil de olvidar y la que produce el peor error posible: vender por la
 * web una hora en la que no hay silla.
 *
 * `allows` es un array JSON de categorías de `pricing.ts`, o `NULL` =
 * cualquiera. Se siembra con `NULL` en las dos filas porque **queda por
 * confirmar si las estaciones son intercambiables o si una es de manos y otra
 * de pies**. El modelo aguanta las dos respuestas: cambian las filas, no el
 * código. Sembrar "intercambiables" es la respuesta permisiva, que es la que no
 * esconde citas que sí caben; la restrictiva se aplica el día que se confirme.
 *
 * ## Por qué la siembra fija los ids 1 y 2
 *
 * `INSERT ... ON DUPLICATE KEY UPDATE id = id` sobre la PK es un no-op en la
 * segunda corrida. Si la siembra colisionara por `name`, renombrar "Puesto 1" a
 * "Ventana" haría que la siguiente migración insertara un tercer puesto — y un
 * puesto de más es capacidad inventada. Con la PK explícita, la fila es la
 * misma pase lo que pase con el nombre.
 */
export const migration: Migration = {
  id: "012-station",
  description: "Puestos físicos del estudio, sembrado con dos filas",
  statements: [
    `CREATE TABLE IF NOT EXISTS station (
       id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
       name       VARCHAR(60) NOT NULL,
       allows     JSON NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

       PRIMARY KEY (id),
       UNIQUE KEY uq_station_name (name)
     ) ${TABLE_OPTIONS}`,

    `INSERT INTO station (id, name, allows) VALUES
       (1, 'Puesto 1', NULL),
       (2, 'Puesto 2', NULL)
     ON DUPLICATE KEY UPDATE id = id`,
  ],
};

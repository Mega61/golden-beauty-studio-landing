-- Se ejecuta UNA sola vez, cuando el volumen de MySQL se crea desde cero.
-- Si ya levantaste el stack antes, esto no vuelve a correr: hay que hacer
-- `docker compose -f deploy/compose/dev-stack.yml down -v` para recrearlo.
--
-- Espeja lo que en producción hace el servicio `admin-migrate`: el esquema del
-- panel y el usuario de solo lectura sobre las tablas de EA.

CREATE DATABASE IF NOT EXISTS gbs_admin
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- Usuario de escritura: manda sobre gbs_admin y NADA sobre easyappointments.
-- Las escrituras a EA van siempre por su API REST, para que disparen
-- notificaciones y el sync de Google Calendar.
CREATE USER IF NOT EXISTS 'gbs_admin'@'%' IDENTIFIED BY 'gbs_admin_dev';
GRANT ALL PRIVILEGES ON gbs_admin.* TO 'gbs_admin'@'%';

-- Usuario de solo lectura sobre EA: es el único camino permitido hacia sus
-- tablas, y existe porque la API REST no agrega (no hay GROUP BY ni SUM).
CREATE USER IF NOT EXISTS 'gbs_ea_ro'@'%' IDENTIFIED BY 'gbs_ea_ro_dev';
GRANT SELECT ON easyappointments.* TO 'gbs_ea_ro'@'%';

FLUSH PRIVILEGES;

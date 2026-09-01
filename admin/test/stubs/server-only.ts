/**
 * No-op que reemplaza al paquete `server-only` bajo Vitest.
 *
 * El paquete real lanza al importarse fuera de un React Server Component, que
 * es justo lo que queremos en producción: es la guarda que impide que un módulo
 * con el token de EA o la conexión a MySQL termine en el bundle del navegador.
 * En los tests esa guarda haría intesteable la lógica pura, así que se
 * aliasea acá (ver `vitest.config.mts`). El alias no existe en los builds
 * reales.
 */
export {};

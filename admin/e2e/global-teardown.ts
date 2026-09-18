import { limpiarDatosDePrueba } from "./fixtures";

/**
 * Deja la agenda como estaba.
 *
 * Corre al final y no antes de cada test a propósito: si algo falla, los datos
 * siguen ahí para poder mirarlos con la traza. Lo que no puede pasar es que
 * queden para la **siguiente** corrida.
 */
export default function globalTeardown(): void {
  limpiarDatosDePrueba();
  console.log("✓ datos de prueba borrados");
}

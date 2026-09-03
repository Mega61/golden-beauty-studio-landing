import { redirect } from "next/navigation";

/**
 * La raíz del panel es "Hoy".
 *
 * La navegación (`components/shell/nav.ts`) manda "Hoy" a `/`, y la pantalla
 * vive en `(panel)/hoy`. Se resuelve con un redirect y no moviendo el `href` de
 * la navegación porque **la raíz tiene que llevar a algún lado**: quien escriba
 * `goldenbeautystudio.com.co/admin` a secas —o lo tenga en favoritos— no puede
 * caer en un placeholder ni en un 404.
 *
 * `(panel)/hoy` es quien exige la sesión, así que este redirect es inofensivo
 * sin autenticar: lleva a `/hoy`, que lleva a `/entrar`.
 */
export default function Page() {
  redirect("/hoy");
}

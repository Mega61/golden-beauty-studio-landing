import type { UserRole } from "@/db/types";

/**
 * Cuentas de prueba (`dev:seed`, la suite E2E, la entrada de desarrollo) y los
 * tres interruptores que las gobiernan.
 *
 * ## Por qué una marca en la fila y no una lista de correos
 *
 * Las cuentas de prueba usan el dominio real del estudio —`normalizeEmail()`
 * exige un TLD, y la allowlist compara correos— así que nada en el correo las
 * distingue de una persona. `allowed_user.is_test_account` lo dice de frente,
 * lo pone quien las crea, y la migración `024` marcó las que ya existían.
 *
 * ## Las tres reglas
 *
 * 1. **Una cuenta de prueba nunca se ve en Equipo**, en ningún entorno, salvo
 *    que se pida con `SHOW_TEST_ACCOUNTS=1` fuera de producción. Equipo es la
 *    lista de quién trabaja en el estudio; "Dev" y "E2E" no trabajan ahí.
 * 2. **En producción, una cuenta de prueba no existe para la autenticación**:
 *    la allowlist la filtra, así que no aparece en la grilla de entrada, no
 *    pasa el login y una sesión viva deja de valer. Si una fila se coló a la
 *    base de la VM —un dump restaurado, un seed corrido donde no era— queda
 *    inerte. La única excepción es `ALLOW_TEST_ACCOUNTS=1`, que pone solamente
 *    el CI: la suite E2E corre contra un build de producción.
 * 3. **La entrada de desarrollo sin código** (`DEV_LOGIN=1`) solo existe fuera
 *    de producción. `NODE_ENV` lo fija el build, no una variable que alguien
 *    pueda dejar puesta en Portainer: en la imagen desplegada la rama no se
 *    puede encender.
 */

type Env = Record<string, string | undefined>;

const isProduction = (env: Env) => env.NODE_ENV === "production";

/** Regla 2: ¿cuentan las cuentas de prueba para entrar y para la sesión? */
export function testAccountsAllowed(env: Env = process.env): boolean {
  return !isProduction(env) || env.ALLOW_TEST_ACCOUNTS === "1";
}

/** Regla 1: ¿se listan en Equipo? */
export function showTestAccountsInTeam(env: Env = process.env): boolean {
  return !isProduction(env) && env.SHOW_TEST_ACCOUNTS === "1";
}

/** Regla 3: ¿se ofrece entrar sin código? */
export function devLoginEnabled(env: Env = process.env): boolean {
  return !isProduction(env) && env.DEV_LOGIN === "1";
}

/** Las cuentas que crea la entrada de desarrollo, una por rol. */
export const DEV_LOGIN_ACCOUNTS: Record<UserRole, { email: string; name: string; label: string }> = {
  owner: { email: "dev@goldenbeautystudio.com.co", name: "Dev (dueña)", label: "Dueña" },
  admin: { email: "dev-recepcion@goldenbeautystudio.com.co", name: "Dev (recepción)", label: "Recepción" },
  staff: { email: "dev-tecnica@goldenbeautystudio.com.co", name: "Dev (técnica)", label: "Técnica" },
};

export function isDevLoginRole(value: unknown): value is UserRole {
  return value === "owner" || value === "admin" || value === "staff";
}

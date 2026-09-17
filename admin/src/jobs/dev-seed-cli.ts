import { randomUUID } from "node:crypto";

import { getDb } from "@/db/client";
import { allowedUserRepository, staffTotpRepository } from "@/db/repositories";
import type { UserRole } from "@/db/types";
import { normalizeEmail } from "@/lib/auth-policy";
import {
  buildOtpauthUrl,
  encryptTotpSecret,
  generateTotpSecret,
  requireTotpEncKey,
  stepAt,
  totpAt,
} from "@/lib/totp";

/**
 * Crea una cuenta local con TOTP para poder **entrar al panel sin Google**.
 *
 * ```
 *   npm run dev:seed                      ← dueña, dev@local
 *   npm run dev:seed -- --rol=staff       ← una técnica
 *   npm run dev:seed -- --email=x@y.com
 * ```
 *
 * ## Por qué existe
 *
 * La entrada normal de la dueña es Google Workspace, y montarla exige un
 * proyecto en Google Cloud con consentimiento interno y un redirect URI — media
 * hora de consola antes de ver una sola pantalla. Para desarrollo local eso es
 * un peaje sin contrapartida: nada de lo que se está probando depende de que el
 * token venga de Google.
 *
 * ## Por qué es TOTP y no una cookie inyectada
 *
 * Inyectar la sesión a mano era el atajo obvio y está mal: **la cookie de
 * Better Auth va firmada** con el secreto de la instancia, y reimplementar esa
 * firma obliga a mantenerla al día con cada versión de la librería — el día que
 * se desincronice, el síntoma es "nadie puede iniciar sesión". Está dicho en
 * `lib/auth.ts` y aplica igual acá.
 *
 * Así que esto no inventa ninguna sesión: **siembra una cuenta y su enrolamiento
 * TOTP, y después se entra por la puerta de verdad** — la misma ruta
 * `/sign-in/totp` que usan las técnicas, con su límite de intentos, su
 * anti-repetición y su allowlist. Lo que se prueba es el login real.
 *
 * El `sign-in` por TOTP no mira el rol —solo la allowlist— así que una dueña
 * enrolada entra igual que una técnica. Eso no es un hueco: el rol decide qué
 * ve, no por dónde entra, y la dueña de verdad además tiene Google.
 *
 * ## Por qué se niega a correr en producción
 *
 * Porque sembraría una cuenta con acceso total y un código que quedó impreso en
 * un log. La guarda es `NODE_ENV`, y además exige que la base **no** sea la de
 * la VM: las dos, porque una sola se salta sin querer.
 */

function arg(name: string, fallback: string): string {
  const found = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
}

async function run(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error("dev:seed: no corre en producción. Es una cuenta de desarrollo.");
    process.exitCode = 1;
    return;
  }

  const url = process.env.DATABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    console.error(
      "dev:seed: DATABASE_URL no apunta a localhost. Esto siembra una cuenta con acceso " +
        "total y deja un código en el log; contra una base remota no se hace.",
    );
    process.exitCode = 1;
    return;
  }

  // Con dominio de verdad, y no `dev@local`: `normalizeEmail()` exige un TLD,
  // así que un correo sin punto después de la arroba queda fuera de la
  // allowlist — la cuenta se crea, la lista de entrada no la muestra y el login
  // responde "código inválido" sin que nada diga por qué. Verificado en carne
  // propia: es el modo de falla más confuso de todo el flujo.
  const email = arg("email", "dev@goldenbeautystudio.com.co");
  const rol = arg("rol", "owner") as UserRole;
  const nombre = arg("nombre", "Dev");

  if (normalizeEmail(email) === null) {
    console.error(
      `dev:seed: "${email}" no pasa la allowlist —hace falta un dominio con punto—, ` +
        "así que la cuenta no podría entrar nunca. Usa algo como dev@goldenbeautystudio.com.co.",
    );
    process.exitCode = 1;
    return;
  }

  if (!["owner", "admin", "staff"].includes(rol)) {
    console.error(`dev:seed: rol desconocido "${rol}". Es owner, admin o staff.`);
    process.exitCode = 1;
    return;
  }

  try {
    const db = getDb();
    const key = requireTotpEncKey();

    // Sin la base arriba, el driver se queda esperando sin decir nada — y quien
    // corre esto por primera vez se queda mirando una terminal en blanco sin
    // saber si funcionó. Diez segundos y un mensaje que dice qué levantar.
    await Promise.race([
      db.selectFrom("user").select("id").limit(1).execute(),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "la base no respondió en 10 s. ¿Está arriba el stack?  " +
                  "docker compose -f deploy/compose/dev-stack.yml up -d",
              ),
            ),
          10_000,
        ),
      ),
    ]);

    // La fila de Better Auth. Se reusa si ya existe: correr esto dos veces tiene
    // que dar la misma cuenta con un secreto nuevo, no una cuenta duplicada.
    const existing = await db
      .selectFrom("user")
      .selectAll()
      .where("email", "=", email)
      .executeTakeFirst();

    const userId = existing?.id ?? randomUUID();

    if (!existing) {
      await db
        .insertInto("user")
        .values({ id: userId, name: nombre, email, emailVerified: 1 })
        .execute();
    }

    const allowed = allowedUserRepository(db);
    const enAllowlist = await allowed.findByEmail(email);
    if (enAllowlist) await allowed.update(enAllowlist.id, { role: rol });
    else await allowed.insert({ email, role: rol });

    const secret = generateTotpSecret();
    await staffTotpRepository(db).enroll(userId, encryptTotpSecret(secret, key));
    const now = new Date();
    // Se confirma de una: el enrolamiento normal exige que la persona escriba un
    // código, y acá no hay persona todavía.
    await staffTotpRepository(db).confirm(userId, now, stepAt(now.getTime()) - 1);

    const restan = 30 - (Math.floor(now.getTime() / 1000) % 30);
    const code = totpAt(secret, now.getTime());

    console.log(`dev:seed: ✓ ${email} (${rol}) lista para entrar.\n`);
    console.log(`  Código: ${code}   (le quedan ${restan} s)`);

    // Un código con cuatro segundos de vida no sirve para nada: quien lo lee
    // todavía está cambiando de ventana. Cuando la ventana se está acabando se
    // imprime también el siguiente, que es lo que va a alcanzar a escribir.
    if (restan <= 10) {
      console.log(
        `  El siguiente: ${totpAt(secret, now.getTime() + 30_000)}   (empieza en ${restan} s)`,
      );
    }
    console.log(`  Para el celular:       ${buildOtpauthUrl({ issuer: "Golden (dev)", account: email, secret })}`);
    console.log(`\n  Entrar en: ${process.env.BETTER_AUTH_URL ?? "http://localhost:3001/admin"}/entrar`);
    console.log("  El código cambia cada 30 s; volver a correr esto da uno nuevo.");
  } catch (error) {
    console.error(
      `dev:seed: no se pudo sembrar la cuenta — ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }

  // El pool de mysql2 mantiene el proceso vivo. Sin esto el script termina su
  // trabajo y la terminal se queda colgada, que se lee como "se rompió".
  process.exit(process.exitCode ?? 0);
}

void run();

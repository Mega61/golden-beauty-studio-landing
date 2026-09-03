# Despliegue del panel — runbook

Los pasos manuales que hay que dar **una sola vez** para que el panel quede
corriendo en la VM, y los dos ensayos que hay que hacer **antes** de confiarle
la plata del estudio: el de rollback y el de restauración de respaldo.

Después de esto, desplegar es hacer merge a `master`: CI construye la imagen,
escribe su digest en `deploy/compose/.env`, y Portainer lo recoge en su próximo
ciclo de polling. Nadie entra por SSH a desplegar.

El diseño y sus porqués están en `docs/ADMIN-PANEL.md` § Topología y § Contenedor,
stack y despliegue. Acá van los comandos.

> **Nadie corre `docker compose up` a mano en la VM.** Con el stack en modo Git,
> Portainer sobreescribe en el siguiente ciclo cualquier cambio local y el cambio
> se pierde sin aviso. Todo cambio de infraestructura entra por un commit a
> `deploy/compose/`.

---

## Lo que ya existe en la VM

| Pieza | Qué es | Dónde |
| --- | --- | --- |
| `golden-agenda` | Easy!Appointments, imagen única de producción | stack `golden-agenda`, modo web editor |
| `mysql-transversal` | MySQL 8.0.46. Hoy aloja **solo** `easyappointments` (0,4 MB); el nombre anticipa que será compartido | red `data`, fuera de todo stack nuestro |
| Caddy | TLS y publicación de subdominios | su propio stack, red `web` |
| redes `data` y `web` | Externas, ya creadas | — |

El stack del panel (`gbs-admin`) es nuevo y **no toca ninguna de esas piezas**.
El de la agenda se queda como está: está en producción atendiendo clientas, y
migrarlo al modo Git para poder desplegar el panel significaría recrearlo — si
el nombre del stack cambiara, el volumen `ea_storage` quedaría huérfano y EA
arrancaría con su almacenamiento vacío.

---

## Paso 1 — Pinear la versión de Easy!Appointments

**Esto va primero, antes que nada más.** Hoy el stack de la agenda corre
`alextselegidis/easyappointments:latest`. El panel lee el esquema de EA directo
y depende de los nombres de columna de sus webhooks: un `docker compose pull`
una noche cualquiera puede traer una versión distinta y romper los reportes sin
que nadie haya tocado código, con el síntoma apareciendo días después como
números que no cuadran.

Leer la versión que está corriendo **ahora**:

```bash
docker exec golden-agenda grep "config\['version'\]" /var/www/html/application/config/app.php
```

Ya se corrió el 2026-08-31 y dio **`1.6.0`**, que es exactamente la versión contra
la que está escrito el plan. Confirmar que ese tag existe publicado antes de
pinearlo:

```bash
docker pull alextselegidis/easyappointments:1.6.0   # el número que dio el comando anterior
```

Y con eso, en Portainer → **Stacks → golden-agenda → Editor**, reemplazar:

```diff
-    image: alextselegidis/easyappointments:latest
+    image: alextselegidis/easyappointments:1.6.0
```

**Update the stack**, y verificar que sigue en pie:

```bash
docker ps --filter name=golden-agenda --format '{{.Names}}\t{{.Status}}\t{{.Image}}'
```

La VM corre **1.6.0**, la misma contra la que se leyó todo el plan: `slotInterval`,
`blocked_periods` y `unavailabilities` existen y los hallazgos de la API aplican
tal cual. La comprobación queda igual para el día que se suba de versión:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $EA_API_TOKEN" \
  http://localhost:8080/index.php/api/v1/blocked_periods
```

Subir de versión de EA después de esto es una decisión deliberada, con el ensayo
de restauración de respaldo repetido detrás.

---

## Paso 2 — El esquema y los usuarios en `mysql-transversal`

### Lo que el reconocimiento encontró (2026-08-31)

| Dato | Valor | Qué implica |
| --- | --- | --- |
| Versión | MySQL **8.0.46** | |
| Bases de datos | **solo `easyappointments`** (14 tablas, **0,4 MB**) | El nombre dice "transversal", pero hoy no hay nada más ahí. El respaldo nocturno es trivial y 30 días de retención no pesan nada |
| Colación de `easyappointments` | `utf8mb4` / **`utf8mb4_unicode_ci`** | Nuestras tablas se alinearon a ésa (venían en `0900_ai_ci`) |
| `@@system_time_zone` | **UTC** | Es el hallazgo que obligó al `SET time_zone = '-05:00'` por conexión |
| `sql_mode` | incluye `STRICT_TRANS_TABLES`, `NO_ZERO_DATE` | Un insert malo falla en vez de truncar en silencio. En el libro de caja, eso es lo que se quiere |
| `max_connections` | **151** (por defecto) | El pool del panel se queda en 10, y el migrador en 5 |
| Usuarios | `easyappointments`@`%`, `root`@`%`, `root`@`localhost` | **Ningún `gbs_admin` ni `gbs_ea_ro`: no hay colisión de nombres** |
| Privilegios globales | solo `root`. `easyappointments`@`%` tiene **`USAGE`** global y todo lo demás acotado a su esquema | El servidor ya está bien higienizado: nadie salvo root manda fuera de su base |
| Plugin de autenticación | todos los usuarios en `mysql_native_password` | Ver la nota de abajo: los nuevos se crean con `caching_sha2_password` |

**Corrección al plan:** este documento venía diciendo que `mysql-transversal` está
"compartido con otras aplicaciones". Hoy **no lo está** — solo vive EA ahí. El
nombre sugiere que esa es la intención, así que la disciplina de grants por
esquema se mantiene igual: es barata ahora y es lo que evita el desastre el día
que llegue la segunda aplicación.

Los grants van por esquema y **nunca globales**: un `GRANT ALL ON *.*` acá le
daría al panel poder sobre bases de terceros que hoy no existen pero mañana sí.

### Paso 2a — Reconocimiento, antes de crear nada

**No se ejecuta un solo `CREATE` sobre este servidor sin haberlo mirado.** El
`CREATE USER` de más abajo falla —o peor, pisa algo— si el nombre ya existe, y la
colación de nuestras tablas depende de la que use EA. Todo lo de este paso es de
solo lectura. Los resultados de la corrida del 2026-08-31 están en la tabla de
arriba; se vuelve a correr si el servidor cambia.

```bash
docker exec -it mysql-transversal mysql -u root -p -t -e "
SELECT VERSION() AS version,
       @@global.time_zone AS tz_global,
       @@system_time_zone AS tz_system,
       @@max_connections  AS max_conn,
       @@sql_mode         AS sql_mode;

SHOW DATABASES;

SELECT schema_name, default_character_set_name AS charset, default_collation_name AS collation
  FROM information_schema.schemata
 WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys');

SELECT table_schema AS db, COUNT(*) AS tablas,
       ROUND(SUM(data_length+index_length)/1024/1024, 1) AS mb
  FROM information_schema.tables
 WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
 GROUP BY table_schema ORDER BY mb DESC;

SELECT user, host, plugin, account_locked AS locked
  FROM mysql.user ORDER BY user, host;

SELECT grantee, privilege_type AS privilegio_GLOBAL
  FROM information_schema.user_privileges ORDER BY grantee;

SELECT grantee, table_schema, privilege_type
  FROM information_schema.schema_privileges ORDER BY grantee, table_schema;

SELECT COUNT(*) AS ya_existe_gbs_admin
  FROM information_schema.schemata WHERE schema_name = 'gbs_admin';

SELECT user, host FROM mysql.user WHERE user IN ('gbs_admin','gbs_ea_ro');
"
```

Qué se está buscando en cada bloque, y qué cambiaría el plan:

| Resultado | Qué significa |
| --- | --- |
| `tz_global` / `tz_system` distintos de `-05:00` o `America/Bogota` | EA guarda `DATETIME` sin zona, así que **no** convierte y el desfase no aparece ahí — pero cualquier `NOW()` o columna `TIMESTAMP` sí. Si el servidor está en UTC, hay que anotarlo antes de escribir la primera consulta de reportes |
| Un `grantee` con privilegios **globales** que no sea `root` | Alguien ya tiene poder sobre todos los esquemas del servidor. No es nuestro problema resolverlo, pero sí saberlo antes de agregar usuarios |
| El `collation` de `easyappointments` | Nuestro esquema debería usar el mismo, no el del servidor por defecto: `utf8mb4_unicode_ci` y `utf8mb4_0900_ai_ci` ordenan y comparan distinto |
| `ya_existe_gbs_admin` ≠ 0, o filas en la última consulta | **Parar.** Algo ya ocupa esos nombres; hay que entender qué antes de tocarlo |
| `max_conn` bajo (≤ 151, el valor por defecto) con varias apps colgando | El pool del panel tiene que ser modesto. Se dimensiona con ese número, no a ojo |
| `sql_mode` sin `STRICT_TRANS_TABLES` | Un insert malo se convierte en dato truncado en silencio, y esto es el libro de caja. Se compensa validando en la app |
| El tamaño de `easyappointments` en MB | Es lo que va a pesar el respaldo nocturno, y define si 30 días de retención caben en el disco de la VM |

Con eso a la vista, y solo entonces:

```bash
docker exec -it mysql-transversal mysql -u root -p
```

```sql
-- 1. El esquema del panel. Es el libro de caja: EA no guarda dinero, así que
--    esta base NO se puede reconstruir desde ninguna otra fuente.
CREATE DATABASE IF NOT EXISTS gbs_admin
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- 2. Usuario de lectura y escritura sobre gbs_admin, y NADA sobre nada más.
--    Es el de DATABASE_URL, y también el que respalda gbs_admin.
-- Los nombres de usuario salen del reconocimiento del paso 2a: si ya existe
-- algo llamado así, NO se pisa — se cambia el nombre acá y en las variables del
-- stack. `CREATE USER` sin `IF NOT EXISTS` es a propósito: que falle ruidoso es
-- mejor que reutilizar en silencio una cuenta ajena.
CREATE USER 'gbs_admin'@'%'
  IDENTIFIED WITH caching_sha2_password BY '<contraseña larga y aleatoria>';
GRANT ALL PRIVILEGES ON gbs_admin.* TO 'gbs_admin'@'%';

-- 3. Usuario de SOLO LECTURA sobre easyappointments. Es el único camino
--    permitido hacia las tablas de EA: las escrituras van siempre por su API
--    REST, porque es lo que dispara las notificaciones y el sync de Google
--    Calendar. SHOW VIEW es para que mysqldump pueda respaldarla; TRIGGER no se
--    otorga, porque permitiría escribir.
CREATE USER 'gbs_ea_ro'@'%'
  IDENTIFIED WITH caching_sha2_password BY '<otra contraseña larga y aleatoria>';
GRANT SELECT, SHOW VIEW ON easyappointments.* TO 'gbs_ea_ro'@'%';

FLUSH PRIVILEGES;
```

Comprobar que quedó como se quería —y en particular que el usuario de solo
lectura **no** puede escribir:

```sql
SHOW GRANTS FOR 'gbs_admin'@'%';
SHOW GRANTS FOR 'gbs_ea_ro'@'%';
```

```bash
# Tiene que fallar con "command denied". Si pasa, el grant está mal.
docker exec -it mysql-transversal \
  mysql -u gbs_ea_ro -p -e "CREATE TABLE easyappointments.zz_prueba (id INT);"
```

Si se prefiere apretar más, en vez de `'%'` se puede restringir el host al rango
de la red `data`:

```bash
docker network inspect data --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

y usar, por ejemplo, `'gbs_admin'@'172.20.%'`. Es opcional: el servidor no
publica puerto hacia afuera.

---

### Paso 2b — La primera fila de `allowed_user`

**Sin esto no entra nadie, ni siquiera para crear la allowlist.** La compuerta de
Workspace exige que el correo exista en `allowed_user`, así que la primera fila
es un `INSERT` a mano, una sola vez, **después** de que las migraciones hayan
corrido (Paso 4, cuando `admin-migrate` termine).

```sql
INSERT INTO gbs_admin.allowed_user (email, role, ea_provider_id)
VALUES ('<el correo de Workspace de la dueña>', 'owner', NULL);
```

De ahí en adelante la dueña administra el resto desde Equipo. Comprobar antes de
intentar entrar:

```sql
SELECT email, role FROM gbs_admin.allowed_user;
```

---

## Paso 3 — La primera imagen

El stack no puede arrancar antes de que exista una imagen: `deploy/compose/.env`
viene con `ADMIN_IMAGE=ghcr.io/mega61/gbs-admin:sha-bootstrap`, un tag que **no
existe a propósito**, para que el primer despliegue espere al primer build verde
en vez de traer una imagen sorpresa.

1. Hacer merge a `master` de cualquier cambio bajo `admin/` (o correr el
   workflow a mano desde **Actions → admin image → Run workflow**).
2. Ver que el job pase lint, typecheck y tests **antes** de construir. Si algo de
   eso falla, no hay imagen: es el punto de la compuerta.
3. Confirmar que CI commiteó el digest:

```bash
git pull
grep ADMIN_IMAGE deploy/compose/.env
# ADMIN_IMAGE=ghcr.io/mega61/gbs-admin@sha256:…
```

### La credencial de GHCR — probablemente no hace falta

**El repositorio `Mega61/golden-beauty-studio-landing` es público**, así que el
código del panel ya lo es. Un paquete privado no protegería nada que no esté
publicado, y a cambio mete en el sistema una credencial que caduca — y un PAT
vencido se manifiesta como "el despliegue dejó de actualizar", **sin error
visible**, que es de las peores formas de fallar.

**Recomendado: hacer público el paquete y no usar credencial.** Después del
primer build: **GitHub → Packages → `gbs-admin` → Package settings → Change
visibility → Public**. La imagen no contiene secretos: las variables las inyecta
el stack en Portainer.

Solo si se prefiere mantenerlo privado, Portainer necesita poder bajarlo:

1. En GitHub: **Settings → Developer settings → Personal access tokens** →
   token clásico con el alcance **`read:packages`** y nada más. Anotar su fecha
   de vencimiento en el calendario, o emitirlo sin expiración: **un PAT vencido
   se manifiesta como "el despliegue dejó de actualizar", sin error visible.**
2. En Portainer: **Registries → Add registry → Custom registry**
   - Name: `ghcr`
   - Registry URL: `ghcr.io`
   - Authentication: encendido, usuario de GitHub y el PAT como contraseña.
3. Probar la credencial **a mano, una vez**, antes de depender de ella:

```bash
echo "<el PAT>" | docker login ghcr.io -u <usuario-github> --password-stdin
docker pull "$(grep ADMIN_IMAGE deploy/compose/.env | cut -d= -f2-)"
```

Con el paquete público, este paso entero se salta y no queda ninguna credencial
que renovar.

---

## Paso 4 — Crear el stack `gbs-admin` en Portainer

**Stacks → Add stack → Repository.**

| Campo | Valor |
| --- | --- |
| Name | `gbs-admin` |
| Build method | **Repository** |
| Repository URL | `https://github.com/Mega61/golden-beauty-studio-landing` |
| Repository reference | `refs/heads/master` |
| Compose path | `deploy/compose/gbs-stack.yml` |
| Authentication | **apagado** — el repo es público, Portainer clona sin credencial |
| GitOps updates | **encendido**, mecanismo **Polling**, intervalo **5m** |
| Force redeployment | apagado (el digest ya cambia solo cuando hay que redesplegar) |

El intervalo de polling **es** la latencia de despliegue. Cuando urge, el botón
**Update the stack** lo aplica ya.

### Variables de entorno del stack

En la misma pantalla, **Environment variables**. Ninguna de estas entra al repo;
`deploy/compose/.env` lleva una sola línea, el digest.

| Variable | Valor |
| --- | --- |
| `DATABASE_URL` | `mysql://gbs_admin:<pass>@mysql-transversal:3306/gbs_admin` |
| `DATABASE_URL_EA_RO` | `mysql://gbs_ea_ro:<pass>@mysql-transversal:3306/easyappointments` |
| `EA_API_URL` | `http://golden-agenda/index.php/api/v1` (sin `/index.php` si el rewriting está activo) |
| `EA_API_TOKEN` | el token de la API de EA |
| `EA_WEBHOOK_SECRET_HEADER` | `X-GBS-Webhook` |
| `EA_WEBHOOK_SECRET_TOKEN` | secreto aleatorio, el mismo que se configure en EA |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | `https://www.goldenbeautystudio.com.co/admin` — **con `www`**, ver abajo |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | consola de Google Cloud, pantalla **Internal** |
| `GOOGLE_WORKSPACE_DOMAIN` | `goldenbeautystudio.com.co` |
| `TOTP_ENC_KEY` | `openssl rand -base64 32` |
| `INGEST_URL` / `INGEST_SHARED_SECRET` | los del Strapi del CRM |
| `MYSQL_HOST` / `MYSQL_PORT` | `mysql-transversal` / `3306` (respaldo) |
| `BACKUP_GBS_USER` / `BACKUP_GBS_PASSWORD` | `gbs_admin` y su contraseña |
| `BACKUP_EA_USER` / `BACKUP_EA_PASSWORD` | `gbs_ea_ro` y su contraseña |
| `BACKUP_AT` | opcional, por defecto `03:15` (hora de Bogotá) |
| `BACKUP_KEEP_DAYS` | opcional, por defecto `30` |

`BETTER_AUTH_URL` va **fijada al dominio público a mano**: el panel vive detrás
del rewrite de Vercel y el `Host` que le llega es el del origen, no el que la
persona escribió. Derivarla del `Host` rompe los redirects de OAuth.

La explicación de cada variable está en `docs/DEV-LOCAL.md` § Paso 4.

### Lo primero que hay que mirar en el primer despliegue

`ADMIN_IMAGE` **no** se pone en las variables del stack: sale de
`deploy/compose/.env`, que es lo que CI reescribe. Portainer también escribe las
variables del stack en un archivo de entorno dentro de la carpeta del clon, y en
algunas versiones ese archivo se llama `.env` — o sea, el mismo nombre. Si eso
pasa acá, el primer despliegue falla con algo del estilo:

```text
service "admin" refers to undefined variable ADMIN_IMAGE
# o bien
no image specified for service "admin"
```

**No es un error de este archivo ni del workflow: es Portainer pisando el `.env`
del repositorio.** El arreglo, si aparece, es mover el digest del `.env` al
propio compose y hacer que CI reescriba esa línea en vez de la del `.env`:

```yaml
    image: ghcr.io/mega61/gbs-admin@sha256:…    # ← lo escribe CI
```

cambiando en `.github/workflows/admin-image.yml` el `sed` de
`deploy/compose/.env` por el mismo `sed` sobre `deploy/compose/gbs-stack.yml`.
El resto del diseño no cambia: sigue siendo un commit que Portainer recoge por
polling, y el rollback sigue siendo `git revert`.

Si el primer despliegue levanta con el digest correcto, esta nota no aplica y no
hay nada que hacer.

### Qué tiene que pasar al desplegar

```bash
docker ps -a --filter name=gbs-admin --format '{{.Names}}\t{{.Status}}'
# gbs-admin           Up X minutes (healthy)
# gbs-admin-backup    Up X minutes
# gbs-admin-migrate   Exited (0) X minutes ago     ← correcto: corre y muere

docker logs gbs-admin-migrate        # las migraciones aplicadas, o "al día"
docker exec gbs-admin date           # hora de Bogotá, no UTC
docker exec gbs-admin whoami         # node, nunca root
docker inspect gbs-admin --format '{{.Config.Image}}'   # el digest esperado
```

`admin-migrate` sale con 0 o el servicio `admin` **no arranca**
(`service_completed_successfully`). Es deliberado: levantar el panel contra un
esquema a medias es peor falla que no levantarlo.

---

## Paso 5 — DNS y Caddy

### El subdominio

`panel.goldenbeautystudio.com.co` → un registro **A** al IP de la VM.

Sigue la familia que el estudio ya usa: `booking.` es la agenda de EA, el apex es
la vitrina, y `panel.` es la herramienta de trabajo. Es también como se llama en
todo este plan — "el panel" —, así que el nombre en el DNS y el nombre en la
conversación son el mismo.

Las personas entran siempre por `goldenbeautystudio.com.co/admin`; este
subdominio existe para que el rewrite de Vercel tenga a dónde apuntar. **Entrar
directo por él no va a funcionar para iniciar sesión**, y eso es deseable: ver
más abajo.

### El bloque de Caddy

En el Caddyfile del stack de Caddy (que ya está en la red `web`):

```caddyfile
panel.goldenbeautystudio.com.co {
    encode zstd gzip

    # Todo lo que no cuelgue de /admin no existe. El origen no es un sitio: es
    # el destino de un rewrite. Un 404 acá es la respuesta correcta.
    @notadmin not path /admin*
    respond @notadmin 404

    # El webhook de EA NO se atiende desde afuera.
    #
    # Su única defensa es un header estático —EA no firma el cuerpo— y el plan
    # decía que el endpoint "solo se alcanza desde la red interna". Con el
    # rewrite de Vercel mandando `/admin/:path*` entero, eso era falso: llegaba
    # desde internet por dos caminos (el dominio público y este subdominio), y
    # los dos pasan por acá.
    #
    # EA le pega al contenedor **directo por la red de Docker**
    # (`http://gbs-admin:3000/admin/api/webhooks/ea`), sin tocar Caddy, así que
    # cerrarlo acá lo cierra por fuera y lo deja abierto por dentro — que es
    # exactamente lo que se quería.
    @webhook path /admin/api/webhooks/*
    respond @webhook 404

    reverse_proxy admin:3000
}
```

Recargar Caddy sin bajarlo:

```bash
docker exec <contenedor-de-caddy> caddy reload --config /etc/caddy/Caddyfile
```

`admin` resuelve por DNS interno de Docker en la red `web` (es el nombre del
servicio). Si en esa red ya hubiera otro contenedor llamado `admin`, usar
`gbs-admin:3000`, que es el `container_name` y también resuelve.

Comprobar desde la propia VM antes de tocar Vercel:

```bash
curl -s https://panel.goldenbeautystudio.com.co/admin/api/health
# {"status":"ok", … "timezone":"America/Bogota" …}
curl -s -o /dev/null -w "%{http_code}\n" https://panel.goldenbeautystudio.com.co/
# 404  ← correcto
```

### Por qué entrar directo por el subdominio no va a funcionar (y está bien)

Si alguien abre `https://panel.goldenbeautystudio.com.co/admin` en el
navegador, va a ver la aplicación pero **no va a poder iniciar sesión**:

- `BETTER_AUTH_URL` está fijada a `https://www.goldenbeautystudio.com.co/admin`, así
  que el flujo de OAuth arranca y vuelve al dominio público, no al subdominio.
- La cookie de sesión queda asociada al dominio público. Desde el subdominio no
  se envía, y la sesión no existe.

**Es una propiedad deseable, no un bug:** hay una sola URL por la que se entra
al panel, una sola en las URIs de redirección de Google, y una sola en la
cabeza de la gente. Que el origen sea inservible a mano reduce la superficie en
vez de ampliarla. Por eso también Caddy responde 404 a todo lo que no sea
`/admin*`.

---

## Paso 6 — Vercel

En el proyecto de la landing, **Settings → Environment Variables**:

```
ADMIN_ORIGIN = https://panel.goldenbeautystudio.com.co
```

en **Production** y en **Preview** (en Preview es donde se prueba el rewrite sin
arriesgar la landing en vivo). Redesplegar la landing para que la variable entre:
`next.config.ts` la lee en build.

Verificar:

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://goldenbeautystudio.com.co/admin
# 200 y sin redirect. Si sale 307 hacia /es/admin, falta excluir `admin` del
# matcher de src/proxy.ts — Next 16 corre proxy ANTES de los rewrites.

curl -s https://goldenbeautystudio.com.co/admin/api/health
curl -s -o /dev/null -w "%{http_code}\n" https://goldenbeautystudio.com.co/es
```

Y con los ojos: el panel tiene que cargar **con estilos**. Sin estilos y con 404
en `/admin/_next/*` significa que la imagen no copió `public/` y `.next/static`
—`output: "standalone"` no los copia solo— o que se perdió el `basePath`.

### Que un push del panel no redespliegue la landing

- Un push que solo toca `admin/`, `deploy/`, `docs/` o `.github/` **no** crea
  deployment en Vercel (`ignoreCommand` en `vercel.json`).
- Un push que solo toca `src/` **no** construye imagen (el workflow filtra por
  `paths: admin/**`).
- Un push que toca las dos cosas despliega las dos. Ningún pipeline puede
  corromper el artefacto del otro.

Se verifica mirando, después del primer merge de cada tipo, que el deployment
correspondiente exista o no exista.

---

## Ensayo de rollback

**Un rollback que nunca se ejecutó no existe.** Se hace una vez, a propósito,
antes de que el panel tenga plata adentro.

1. Anotar el digest que está corriendo:

   ```bash
   docker inspect gbs-admin --format '{{.Config.Image}}'
   ```

2. Encontrar el commit de despliegue que lo puso ahí:

   ```bash
   git log --oneline -- deploy/compose/.env
   # a1b2c3d [skip ci] deploy: admin 9f8e7d6
   ```

3. Revertirlo y empujar:

   ```bash
   git revert --no-edit a1b2c3d
   git push origin master
   ```

   El commit de revert vuelve a poner el digest anterior. No dispara CI: toca
   `deploy/`, que no está en `paths`, y el mensaje arrastra el `[skip ci]` del
   commit revertido.

4. Esperar un ciclo de polling (≤5 min), o pulsar **Update the stack** en
   Portainer.

5. Confirmar que volvió **exactamente** el binario anterior:

   ```bash
   docker inspect gbs-admin --format '{{.Config.Image}}'   # el digest viejo
   curl -s https://goldenbeautystudio.com.co/admin/api/health
   ```

6. Volver adelante: `git revert` del revert, o esperar al próximo merge.

Esto es lo que compra el digest. Con `:latest` o con un tag móvil, el paso 5 no
tiene cómo verificarse: no hay rollback, hay esperanza.

---

## Ensayo de restauración de respaldo

**Un backup que nunca se restauró no es un backup.** Se ensaya antes de
producción y se repite después de cada upgrade de EA.

Se restaura **a un esquema limpio y con otro nombre**, nunca encima de
`gbs_admin`: un ensayo que exige pisar la base viva no se hace nunca.

1. Ver qué hay y qué tan fresco es:

   ```bash
   docker exec gbs-admin-backup ls -la /backups
   docker exec gbs-admin-backup cat /backups/last-run.txt      # fecha de la última corrida
   docker exec gbs-admin-backup cat /backups/last-status.txt   # 0 = las dos bases OK
   ```

2. Crear el esquema del ensayo:

   ```bash
   docker exec -it mysql-transversal mysql -u root -p -e \
     "CREATE DATABASE gbs_admin_drill CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      GRANT ALL PRIVILEGES ON gbs_admin_drill.* TO 'gbs_admin'@'%';
      FLUSH PRIVILEGES;"
   ```

3. Restaurar el dump más reciente. Se hace **desde el contenedor de respaldo**,
   que ya tiene el cliente de MySQL y ya está en la red `data`:

   ```bash
   docker exec gbs-admin-backup sh -c \
     'gunzip -c /backups/gbs_admin-20260831-031500.sql.gz \
      | MYSQL_PWD="$BACKUP_GBS_PASSWORD" mysql --host="$MYSQL_HOST" --user="$BACKUP_GBS_USER" gbs_admin_drill'
   ```

   (Los dumps se toman **sin** `--databases` justamente para que esto sea
   posible: no traen `CREATE DATABASE` ni `USE`, así que entran en el esquema
   que se les diga.)

4. Verificar que la copia es la base y no un archivo con forma de base:

   ```bash
   docker exec -it mysql-transversal mysql -u root -p -e "
     SELECT COUNT(*) AS tablas FROM information_schema.tables
       WHERE table_schema='gbs_admin_drill';
     SELECT COUNT(*) AS migraciones FROM gbs_admin_drill.schema_migration;
     SELECT COUNT(*) AS cuentas FROM gbs_admin_drill.appointment_finance;
     SELECT COUNT(*) AS renglones FROM gbs_admin_drill.appointment_finance_item;"
   ```

   Tienen que salir **19 tablas** (18 del esquema + el libro `schema_migration`)
   y **15 migraciones**. Los conteos de `appointment_finance` se comparan contra
   la base viva: si el respaldo tiene menos filas de las que había al momento del
   dump, el dump está truncado.

5. Repetir con el dump de `easyappointments` en otro esquema de ensayo, si se
   quiere cubrir también la agenda.

6. Borrar el esquema del ensayo:

   ```bash
   docker exec -it mysql-transversal mysql -u root -p -e "DROP DATABASE gbs_admin_drill;"
   ```

### Sacar los respaldos de la VM

Hoy **no hay bucket configurado**: `BACKUP_OFFSITE_URI` está vacía, el servicio
funciona igual y avisa en cada corrida que el respaldo queda solo en la VM. Un
respaldo que vive en la misma máquina que la base no cubre el modo de falla que
importa — que es perder la máquina.

Cuando exista el bucket (GCS, el mismo proyecto que ya sirve la media):

1. Crear una cuenta de servicio con permiso **solo de escritura** sobre ese
   bucket, y bajar su llave JSON a la VM, fuera del árbol clonado
   (`/opt/gbs/secrets/backup-sa.json`, `chmod 400`).
2. Agregar a las variables del stack:
   - `BACKUP_OFFSITE_URI=gs://<bucket>/gbs-admin/`
   - `BACKUP_GCP_SA_FILE=/opt/gbs/secrets/backup-sa.json`
   - `COMPOSE_PROFILES=offsite`
3. **Update the stack.** Arranca `db-backup-offsite`, que sincroniza el volumen
   de respaldos al bucket una vez al día.

El servicio ya está escrito y apagado detrás de un perfil, y no comentado, para
que ese día sea encender algo y no escribirlo bajo presión.

---

## Verificación de infraestructura

Lo que hay que poder responder que sí antes de dar el despliegue por hecho. Lo
que no se pueda ejecutar todavía se anota como **no ejecutado**, nunca como que
pasa: es lo único que hace que la lista signifique algo.

- [ ] `docker exec golden-agenda …` dio la versión de EA y el stack quedó pineado.
- [ ] `SHOW GRANTS` de los dos usuarios: por esquema, ninguno global.
- [ ] El usuario RO **no puede** escribir en `easyappointments` (probado, no supuesto).
- [ ] `docker pull` de la imagen privada de GHCR funcionó a mano en la VM.
- [ ] `gbs-admin` está `healthy`; `gbs-admin-migrate` salió con 0.
- [ ] `docker exec gbs-admin date` da hora de Bogotá y `/admin/api/health` reporta
      `"timezone":"America/Bogota"`.
- [ ] `docker exec gbs-admin whoami` → `node`.
- [ ] `goldenbeautystudio.com.co/admin` sirve el panel **con estilos**; `/es` y
      `/bio` intactas.
- [ ] Un merge que solo toca `admin/` **no** crea deployment en Vercel.
- [ ] Un merge que solo toca `src/` **no** construye imagen.
- [ ] Un merge a `master` aparece corriendo en la VM dentro del intervalo de
      polling, sin que nadie entre por SSH, y `docker inspect` muestra el digest
      esperado.
- [ ] **Ensayo de rollback ejecutado.**
- [ ] **Ensayo de restauración ejecutado.**
- [ ] Aislamiento: parar `gbs-admin` no afecta a EA; la agenda sigue atendiendo.

---

## Fallas comunes

| Síntoma | Causa |
| --- | --- |
| `/admin` se va a `/es/admin` | `src/proxy.ts` no excluye `admin` del matcher. Next 16 corre `proxy` antes de los rewrites |
| El panel carga sin estilos, 404 en `/admin/_next/*` | La imagen no copió `public/` y `.next/static`, o se perdió el `basePath` |
| `/admin` da 404 en Vercel | Falta `ADMIN_ORIGIN`, o la landing no se redesplegó después de agregarla |
| `gbs-admin` no arranca y `gbs-admin-migrate` salió con 1 | Migraciones fallidas: `docker logs gbs-admin-migrate`. Casi siempre credenciales o grants |
| El migrador reintenta y se rinde | `mysql-transversal` no responde desde la red `data`, o el host del `DATABASE_URL` está mal |
| Las horas están corridas 5 h | `TZ` sin llegar al proceso. `/admin/api/health` dice la zona efectiva |
| "El despliegue dejó de actualizar" | El PAT de GHCR o el del repo venció. No hay error visible: hay que ir a mirarlo |
| Un cambio en `next.config.ts` del panel no se ve | Se serializa en el build: hay que reconstruir la imagen, no reiniciar el contenedor |
| Un cambio hecho a mano en la VM desapareció | Es el modo Git funcionando. Todo cambio va por commit a `deploy/compose/` |
| El respaldo tiene más de 48 h | `docker logs gbs-admin-backup`. Diagnóstico lo pinta en rojo por esto mismo |

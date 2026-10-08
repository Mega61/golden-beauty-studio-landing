#!/usr/bin/env bash
# Escribe el `.env.local` que la suite E2E necesita para hablar con el stack de
# CI, **sin pisar el de desarrollo**.
#
# Sale a `.env.ci.local` y no a `.env.local` a propósito: quien reproduce un
# fallo de CI en su máquina no puede perder su configuración de desarrollo por
# ejecutar un script. El comando que arranca el panel lo pasa con `--env-file`.
#
# Ningún valor de acá es un secreto. Son credenciales de un entorno que se crea
# y se destruye en la misma corrida, y escribirlas en claro es lo correcto: un
# secreto de CI que en realidad no lo es enseña a tratar los de verdad igual.
set -euo pipefail

SALIDA="${1:-.env.ci.local}"
EA_PORT="${CI_EA_PORT:-18080}"
MYSQL_PORT="${CI_MYSQL_PORT:-33307}"
PANEL_PORT="${CI_PANEL_PORT:-13001}"
TOKEN="${EA_CI_TOKEN:-ci-token-no-secreto-para-pruebas-0000}"

# El heredoc interpola a propósito (los puertos), así que **nada de comillas
# invertidas acá adentro**: bash las ejecuta como comando y el script muere con
# un "syntax error" que no señala la línea culpable.
cat > "$SALIDA" <<EOF
# Generado por scripts/ci-env.sh. No se commitea y no lleva nada secreto.
DATABASE_URL="mysql://gbs_admin:gbs_admin_dev@127.0.0.1:${MYSQL_PORT}/gbs_admin"
DATABASE_URL_EA_RO="mysql://gbs_ea_ro:gbs_ea_ro_dev@127.0.0.1:${MYSQL_PORT}/easyappointments"

# La vitrina, en ruta absoluta.
#
# El panel corre desde .next/standalone, así que las rutas que intenta por
# defecto servicios/pricing-source.ts —relativas al cwd— no alcanzan
# src/data/pricing.ts. Sin esto la pantalla de Servicios entra en su estado de
# "no pude leer la vitrina" y no se puede crear ni vincular ningún servicio,
# que es justo lo que la suite necesita hacer para probar los combos.
#
# No es una comodidad de CI: espeja lo que hay que montar en la VM, donde la
# imagen del panel tampoco contiene la landing (ver docs/DEPLOY.md). Lo que NO
# depende de esto es componer un combo en la agenda: esa composición va
# horneada en la imagen, en admin/src/data/combo-composition.ts.
#
# Sin comillas invertidas en este comentario: está dentro del heredoc que
# interpola, y bash las ejecutaría como comando (lo dice la nota de arriba).
PRICING_SOURCE_PATH="$(cd ../src/data && pwd)/pricing.ts"

EA_API_URL="http://localhost:${EA_PORT}/index.php/api/v1"
EA_API_TOKEN="${TOKEN}"
EA_PUBLIC_URL="http://localhost:${EA_PORT}"
EA_WEBHOOK_SECRET_HEADER="X-GBS-Webhook"
EA_WEBHOOK_SECRET_TOKEN="ci-webhook"

# Fijos, no aleatorios: una corrida que falla se tiene que poder repetir igual.
#
# Son base64 de **exactamente 32 bytes**, y no una cadena que lo parezca:
# requireTotpEncKey() mide la llave decodificada y rechaza cualquier otra
# longitud —"no se estira"— con un error que no dice nada sobre CI. Se
# escribieron a ojo la primera vez y medían 31.
BETTER_AUTH_SECRET="Z2JzLWNpLWJldHRlci1hdXRoLXNlY3JldC0wMDAwMDA="
BETTER_AUTH_URL="http://localhost:${PANEL_PORT}/admin"
TOTP_ENC_KEY="Z2JzLWNpLXRvdHAta2V5LTAxMjM0NTY3ODlhYmNkZWY="

# El dominio de la allowlist. La cuenta de la suite vive en él.
GOOGLE_WORKSPACE_DOMAIN="goldenbeautystudio.com.co"
# Tienen que existir —la app se niega a arrancar sin ellas— y no se usan: en CI
# se entra por TOTP, como en cualquier máquina de desarrollo.
GOOGLE_CLIENT_ID="ci-no-se-usa"
GOOGLE_CLIENT_SECRET="ci-no-se-usa"

# Vacía: el push a Strapi queda apagado y el cierre diario registra que no
# salió, que es el comportamiento que la suite espera.
INGEST_URL=""
INGEST_SHARED_SECRET="ci"

TZ="America/Bogota"
TICKET_STAFF_COBRA="true"
NODE_ENV="development"
EOF

echo "✓ ${SALIDA} escrito (EA:${EA_PORT} · MySQL:${MYSQL_PORT} · panel:${PANEL_PORT})"

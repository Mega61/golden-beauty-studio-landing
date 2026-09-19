#!/usr/bin/env bash
# Deja Easy!Appointments listo para la suite E2E, sin navegador.
#
# Es la pieza que hace posible correr los E2E en CI. El instalador de EA es un
# asistente web, y automatizarlo con un navegador habría sido un test frágil
# guardando la puerta de todos los demás. Su consola sí sabe hacerlo:
# `php index.php console install` migra en limpio y siembra.
#
# Lo que hace, en orden, y por qué cada paso:
#
#   1. Instala EA (migrate fresh + seed).
#   2. Le fija el token de API, que el asistente deja vacío. Sin esto el panel
#      no puede autenticarse y **todas** las pantallas caen a solo lectura: la
#      suite fallaría entera con "no encuentro el botón" cuando lo que pasa es
#      que no hay credencial.
#   3. Le da al provider sembrado un plan de trabajo que cubra el día. El seed
#      de EA deja un horario que no siempre incluye la franja que la agenda
#      ofrece por defecto, y sin plan la grilla sale vacía — otra vez, veinte
#      fallos que no hablan de lo que se rompió.
#
# Idempotente: correrlo dos veces reinstala EA desde cero. En CI es lo que se
# quiere; en local, cuidado — **se lleva por delante los datos de esa EA**, y
# por eso exige un nombre de proyecto de Compose explícito en vez de adivinarlo.
set -euo pipefail

PROYECTO="${1:-gbs-ci}"
COMPOSE="${2:-../deploy/compose/ci-stack.yml}"
TOKEN="${EA_CI_TOKEN:-ci-token-no-secreto-para-pruebas-0000}"

dc() { docker compose -p "$PROYECTO" -f "$COMPOSE" "$@"; }

echo "▸ esperando a MySQL…"
for _ in $(seq 1 60); do
  if dc exec -T mysql mysqladmin ping -h 127.0.0.1 -psecret >/dev/null 2>&1; then break; fi
  sleep 2
done
dc exec -T mysql mysqladmin ping -h 127.0.0.1 -psecret >/dev/null

echo "▸ instalando Easy!Appointments (migrate fresh + seed)…"
# `cd` explícito: el front controller de CodeIgniter resuelve sus rutas
# relativas al directorio de trabajo, y sin esto responde "Not Found".
dc exec -T -w /var/www/html easyappointments php index.php console install

echo "▸ fijando el token de API…"
# Por SQL y no por la interfaz: el ajuste existe desde la migración 017 de EA y
# su única forma de escritura por HTTP es la pantalla de ajustes.
#
# ⚠ **Borrar y volver a insertar, no `ON DUPLICATE KEY UPDATE`.** `ea_settings`
# no tiene índice único sobre `name`, así que el upsert no choca con nada:
# inserta una **segunda** fila `api_token` y EA lee la primera, que el seed dejó
# vacía. El síntoma es un 401 en toda la API con el token correcto escrito en la
# base — costó un rato entender que había dos filas.
dc exec -T mysql mysql -uroot -psecret easyappointments -e \
  "DELETE FROM ea_settings WHERE name = 'api_token';
   INSERT INTO ea_settings (name, value) VALUES ('api_token', '${TOKEN}');"

echo "▸ dejando el correo como opcional…"
# ⚠ **Esto espeja una configuración de producción, no es una comodidad de CI.**
#
# `require_email` viene en **1** en una instalación nueva de EA, y con eso su
# API rechaza con un 500 cualquier clienta sin correo. El estudio trabaja al
# revés: la mayoría de sus clientas no tiene correo, y el panel se niega a
# inventar uno —un correo falso viaja como invitado del evento de Google,
# rebota, y ensucia la ficha para siempre (ver `clientes/identity.ts`).
#
# Si la EA del estudio tuviera este ajuste en 1, el alta de clientas estaría
# rota allá igual que acá. Está en el runbook de `docs/DEPLOY.md`.
dc exec -T mysql mysql -uroot -psecret easyappointments -e \
  "UPDATE ea_settings SET value = '0' WHERE name = 'require_email';"

echo "▸ dándole jornada completa al provider sembrado…"
# Un plan que cubre de 8 a 20 todos los días. La suite agenda en la franja que
# la grilla ofrece por defecto, y con el plan del seed esa franja puede quedar
# fuera del horario: la cita se crea igual (el panel pide confirmar el
# conflicto) pero el test dejaría de probar el camino normal.
PLAN='{"monday":{"start":"08:00","end":"20:00","breaks":[]},"tuesday":{"start":"08:00","end":"20:00","breaks":[]},"wednesday":{"start":"08:00","end":"20:00","breaks":[]},"thursday":{"start":"08:00","end":"20:00","breaks":[]},"friday":{"start":"08:00","end":"20:00","breaks":[]},"saturday":{"start":"08:00","end":"20:00","breaks":[]},"sunday":{"start":"08:00","end":"20:00","breaks":[]}}'
dc exec -T mysql mysql -uroot -psecret easyappointments -e \
  "UPDATE ea_user_settings us
      JOIN ea_users u ON u.id = us.id_users
      JOIN ea_roles r ON r.id = u.id_roles
     SET us.working_plan = '${PLAN}'
   WHERE r.slug = 'provider';"

echo "▸ comprobando que la API responde…"
PUERTO="${CI_EA_PORT:-18080}"
for _ in $(seq 1 30); do
  CODIGO=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${TOKEN}" \
    "http://localhost:${PUERTO}/index.php/api/v1/services" || true)
  [ "$CODIGO" = "200" ] && break
  sleep 2
done

if [ "${CODIGO:-}" != "200" ]; then
  echo "✗ la API de EA respondió ${CODIGO:-sin respuesta} en el puerto ${PUERTO}." >&2
  echo "  Los logs del contenedor:" >&2
  dc logs --tail 40 easyappointments >&2
  exit 1
fi

# Lo que la suite necesita que exista. Si el seed de EA cambiara y dejara de
# crear servicios o técnicas, los tests fallarían con "no hay opciones" y
# nadie miraría acá: mejor decirlo ahora.
SERVICIOS=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  "http://localhost:${PUERTO}/index.php/api/v1/services" | grep -o '"id"' | wc -l)
PROVEEDORES=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
  "http://localhost:${PUERTO}/index.php/api/v1/providers" | grep -o '"id"' | wc -l)

echo "✓ EA lista: ${SERVICIOS} servicio(s), ${PROVEEDORES} técnica(s)."

if [ "$SERVICIOS" -lt 1 ] || [ "$PROVEEDORES" -lt 1 ]; then
  echo "✗ el seed de EA no dejó servicios o técnicas; la suite no tendría con qué agendar." >&2
  exit 1
fi

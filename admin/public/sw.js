/*
 * Service worker del panel. Se sirve en /admin/sw.js con alcance /admin/.
 *
 * Hace DOS cosas y nada más: mostrar el aviso de push y abrir el panel al
 * tocarlo.
 *
 * ## Por qué no hay manejador de `fetch` (ni caché, ni página offline)
 *
 * A propósito. El panel es la agenda y la caja del estudio en vivo: una
 * agenda servida de caché le muestra a recepción un hueco que ya se ocupó, y
 * una decisión tomada sobre eso es una clienta con dos citas a la misma hora.
 * Todo lo que el panel pinta es HTML autenticado o una respuesta de API, y
 * ninguna de las dos cosas puede salir de una caché del navegador.
 *
 * Sin manejador de `fetch`, el navegador va a la red exactamente como si este
 * archivo no existiera: no hay forma de que una regla de caché mal escrita
 * sirva datos viejos, porque no hay regla. Lo que se pierde es una página
 * propia de "sin conexión"; sin red se ve el error del navegador, que dice la
 * verdad. Chrome ya no exige `fetch` para instalar la app, y iOS nunca lo
 * exigió.
 *
 * Si algún día se agrega una página offline, tiene que ser un archivo
 * estático precacheado y servido SOLO para navegaciones que fallan por red —
 * nunca una respuesta cacheada de una ruta del panel.
 */

const BASE = "/admin";
const ICON = `${BASE}/icons/icon-192.png`;
// La insignia de la barra de estado de Android: solo cuenta la silueta, así
// que es un destello blanco sobre transparente. Sin ella, Android pinta un
// cuadrado gris donde iba la marca.
const BADGE = `${BASE}/icons/badge-96.png`;

self.addEventListener("install", () => {
  // Una versión nueva toma el control sin esperar a que se cierren todas las
  // pestañas: no hay caché que migrar, así que no hay nada que romper.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    // Un push que no es JSON no es nuestro. Igual hay que mostrar algo: iOS
    // y Chrome castigan un push "silencioso" revocando el permiso.
    data = { title: "Golden · Panel", body: event.data.text() };
  }

  const inPanel = (value) => typeof value === "string" && value.startsWith(`${BASE}/`);
  const url = inPanel(data.url) ? data.url : `${BASE}/agenda`;
  const confirmUrl = inPanel(data.confirmUrl) ? data.confirmUrl : null;

  event.waitUntil(
    Promise.all([
      // Con el panel abierto, la agenda se vuelve a pedir ya (`AgendaClient`
      // escucha "gbs:push"): el aviso dice que algo cambió, y la grilla en
      // pantalla no puede quedarse 30 s diciendo lo contrario.
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((windows) => {
          for (const client of windows) client.postMessage({ type: "gbs:push", tag: data.tag || null });
        }),
      self.registration.showNotification(data.title || "Golden · Panel", {
        body: data.body || "",
        icon: ICON,
        badge: BADGE,
        tag: data.tag || undefined,
        // Si llega otra con la misma etiqueta, que vuelva a sonar.
        renotify: Boolean(data.tag),
        // Corto y doble: se nota en el bolsillo sin parecer una llamada.
        vibrate: [90, 60, 90],
        timestamp: Date.now(),
        // Android y escritorio muestran los botones; iOS los ignora y tocar el
        // aviso sigue abriendo la agenda del día.
        actions: confirmUrl
          ? [
              { action: "confirmar", title: "Escribirle por WhatsApp" },
              { action: "agenda", title: "Ver en la agenda" },
            ]
          : [],
        data: { url, confirmUrl },
      }),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  // "Escribirle por WhatsApp": la ruta del panel resuelve el teléfono y
  // redirige a wa.me. Va en ventana nueva —sale de la app hacia WhatsApp— en
  // vez de reusar la del panel, que quedaría parada en una redirección.
  if (event.action === "confirmar" && data.confirmUrl) {
    event.waitUntil(self.clients.openWindow(new URL(data.confirmUrl, self.location.origin).href));
    return;
  }

  const target = new URL(data.url || `${BASE}/agenda`, self.location.origin);

  event.waitUntil(
    (async () => {
      // Si el panel ya está abierto, se reutiliza esa ventana en vez de abrir
      // otra: en un celular, cada aviso tocado sería una pestaña más.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        const url = new URL(client.url);
        if (url.origin === target.origin && url.pathname.startsWith(`${BASE}/`)) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target.href);
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});

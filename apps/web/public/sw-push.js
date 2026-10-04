/* Avisos push de Wabid (módulo `avisos`).
 *
 * Lo carga el service worker que genera vite-plugin-pwa (vite.config.ts -> workbox.importScripts), así que
 * convive con el precache y el runtime caching sin tocarlos. Es un script clásico servido tal cual desde /public:
 * no pasa por el bundler, por eso no usa imports ni TypeScript.
 *
 * Formato del mensaje (lo arma supabase/functions/_shared/webpush-core.ts, buildPushPayload):
 *   { v: 1, id, kind, title, body, url, ts }
 */
(function () {
  'use strict';

  var DEFAULT_URL = '/avisos';
  var ICON = '/icons/icon-192.png';
  var BADGE = '/icons/badge-96.png'; // silueta blanca sobre transparente: es la que Android pinta en la barra de estado

  function text(value) {
    return typeof value === 'string' ? value : '';
  }

  // Solo rutas de esta misma app. Cualquier otra cosa cae en la bandeja.
  function appUrl(raw) {
    try {
      var url = new URL(text(raw) || DEFAULT_URL, self.location.origin);
      return url.origin === self.location.origin ? url.href : new URL(DEFAULT_URL, self.location.origin).href;
    } catch (e) {
      return new URL(DEFAULT_URL, self.location.origin).href;
    }
  }

  // Un mensaje ilegible igual debe mostrar algo: con userVisibleOnly, Chrome exige una notificación por cada push
  // y, si no la hay, muestra la suya ("este sitio se actualizó en segundo plano").
  function readPush(event) {
    var data = {};
    if (event.data) {
      try {
        data = event.data.json() || {};
      } catch (e) {
        try {
          data = { body: event.data.text() };
        } catch (e2) {
          data = {};
        }
      }
    }
    return {
      id: text(data.id),
      kind: text(data.kind),
      title: text(data.title) || 'Wabid',
      body: text(data.body),
      url: appUrl(data.url),
      ts: typeof data.ts === 'number' ? data.ts : Date.now(),
    };
  }

  // Si la app está abierta, que refresque su bandeja sin esperar a que el usuario vuelva a entrar.
  function tellOpenWindows(notice) {
    return self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (windows) {
        windows.forEach(function (w) {
          w.postMessage({ type: 'wabid:aviso', id: notice.id, kind: notice.kind });
        });
      })
      .catch(function () {});
  }

  self.addEventListener('push', function (event) {
    var notice = readPush(event);
    // Siempre se muestra, aunque la app esté en primer plano: es la prueba de que el push llegó.
    var shown = self.registration.showNotification(notice.title, {
      body: notice.body,
      icon: ICON,
      badge: BADGE,
      lang: 'es',
      tag: notice.id || undefined,
      timestamp: notice.ts,
      data: { url: notice.url, id: notice.id, kind: notice.kind },
    });
    event.waitUntil(Promise.all([shown, tellOpenWindows(notice)]));
  });

  // Abre la app en la ruta del aviso: enfoca la ventana que ya exista (instalada o en pestaña) o abre una.
  function openApp(target) {
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
      var win = windows.filter(function (w) { return w.focused; })[0] || windows[0];
      if (!win) return self.clients.openWindow(target);
      if (win.url === target) return win.focus();
      return win
        .navigate(target)
        .then(function (navigated) { return (navigated || win).focus(); })
        .catch(function () { return self.clients.openWindow(target); });
    });
  }

  self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    var data = event.notification.data || {};
    event.waitUntil(openApp(appUrl(data.url)));
  });
})();

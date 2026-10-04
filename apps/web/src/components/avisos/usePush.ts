// Estado y acciones de los avisos push en ESTE dispositivo: permiso, suscripción del navegador y aviso de prueba.
import { useCallback, useEffect, useRef, useState } from 'react';
import { pushApi } from './api';
import {
  base64UrlToBytes,
  describeTest,
  devicePhase,
  sameKey,
  type DeviceBusy,
  type DevicePhase,
  type Permission,
  type TestOutcome,
} from './logic';

const WORKER_WAIT_MS = 3000;

const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// El service worker de la app (el que genera vite-plugin-pwa). Sin él no hay push; con `vite dev` no existe.
function workerRegistration(): Promise<ServiceWorkerRegistration | null> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), WORKER_WAIT_MS)),
  ]);
}

// La clave que pide el servidor es la que firma los envíos: así nunca se desfasa al rotar el par. La de la
// compilación (VITE_VAPID_PUBLIC_KEY) solo sirve de respaldo si la función no responde.
async function vapidKey(): Promise<string> {
  try {
    return await pushApi.vapidKey();
  } catch (e) {
    const fromBuild = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
    if (fromBuild) return fromBuild;
    throw e;
  }
}

function explain(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'El navegador no pudo registrarse en el servicio de notificaciones. Revisa tu conexión e inténtalo de nuevo.';
  }
  return error instanceof Error ? error.message : 'No se pudo completar la acción. Inténtalo de nuevo.';
}

export function usePush() {
  const canPush = pushSupported();
  const [checking, setChecking] = useState(canPush);
  const [hasWorker, setHasWorker] = useState(false);
  const [permission, setPermission] = useState<Permission>(() => (canPush ? Notification.permission : 'default'));
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState<DeviceBusy>('idle');
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null);
  const alive = useRef(true);
  const synced = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!canPush) return;
    setPermission(Notification.permission);
    const reg = await workerRegistration();
    if (!alive.current) return;
    setHasWorker(reg !== null);
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!alive.current) return;
    setSubscribed(sub !== null);
    setChecking(false);
    // Si el navegador tiene la suscripción, el servidor también debe tenerla (se pudo perder tras un 404/410).
    if (sub && Notification.permission === 'granted' && !synced.current) {
      synced.current = true;
      pushApi.subscribe(sub.toJSON()).catch(() => {
        synced.current = false;
      });
    }
  }, [canPush]);

  // Al abrir la pantalla, al volver a la app (p. ej. desde los ajustes de Android) y cuando cambia el permiso.
  useEffect(() => {
    if (!canPush) return;
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    let cancelled = false;
    let status: PermissionStatus | null = null;
    const onPermissionChange = () => void refresh();
    navigator.permissions
      ?.query({ name: 'notifications' })
      .then((s) => {
        if (cancelled) return;
        status = s;
        s.addEventListener('change', onPermissionChange);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      status?.removeEventListener('change', onPermissionChange);
    };
  }, [canPush, refresh]);

  const enable = useCallback(async () => {
    setError(null);
    setTestOutcome(null);
    setBusy('enabling');
    try {
      // El permiso va primero y sin esperas antes: el navegador lo concede mejor dentro del toque del usuario.
      let current: Permission = Notification.permission;
      if (current === 'default') current = await Notification.requestPermission();
      if (alive.current) setPermission(current);
      if (current === 'denied') return; // la pantalla ya explica cómo desbloquearlo
      if (current !== 'granted') {
        setError('No diste el permiso. Toca el interruptor de nuevo cuando quieras activar los avisos.');
        return;
      }

      const reg = await workerRegistration();
      if (!reg) throw new Error('El service worker de la app no está activo. Recarga la página e inténtalo de nuevo.');
      const key = await vapidKey();

      let sub = await reg.pushManager.getSubscription();
      // Una suscripción hecha con otra clave VAPID ya no sirve (el push service rechazaría los envíos).
      if (sub && !sameKey(sub.options.applicationServerKey, key)) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key) });
      try {
        await pushApi.subscribe(sub.toJSON());
      } catch (e) {
        await sub.unsubscribe().catch(() => {}); // sin registro en el servidor no llegaría nada: no se deja a medias
        throw e;
      }
      synced.current = true;
      if (alive.current) setSubscribed(true);
    } catch (e) {
      if (alive.current) setError(explain(e));
    } finally {
      if (alive.current) setBusy('idle');
    }
  }, []);

  const disable = useCallback(async () => {
    setError(null);
    setTestOutcome(null);
    setBusy('disabling');
    try {
      const reg = await workerRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        // Si el servidor no se entera, el push service responderá 404/410 al próximo envío y la suscripción se borra sola.
        await pushApi.unsubscribe(endpoint).catch(() => {});
      }
      synced.current = false;
      if (alive.current) setSubscribed(false);
    } catch (e) {
      if (alive.current) setError(explain(e));
    } finally {
      if (alive.current) setBusy('idle');
    }
  }, []);

  const sendTest = useCallback(async () => {
    setTesting(true);
    setTestOutcome(null);
    try {
      const result = await pushApi.test();
      if (alive.current) setTestOutcome(describeTest(result));
    } catch (e) {
      if (alive.current) setTestOutcome({ tone: 'error', message: explain(e) });
    } finally {
      if (alive.current) setTesting(false);
    }
  }, []);

  const phase: DevicePhase = devicePhase({ checking, supported: canPush, hasWorker, permission, subscribed });
  const toggle = useCallback(() => void (phase === 'on' ? disable() : enable()), [phase, disable, enable]);

  return { phase, busy, error, toggle, testing, testOutcome, sendTest };
}

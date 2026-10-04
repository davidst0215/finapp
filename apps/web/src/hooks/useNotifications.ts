import { localDateKey } from '@/lib/utils';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { isAppPath } from '@/components/avisos/logic';

// Notificación desde el service worker: `new Notification()` no existe en Android.
async function show(title: string, options: NotificationOptions) {
  const reg = await navigator.serviceWorker?.getRegistration();
  await reg?.showNotification(title, { icon: '/icons/icon-192.png', ...options });
}

// Montado en AppShell. Hace dos cosas:
//  1. Cuando se toca un aviso push con la app visible, el service worker (public/sw-push.js) manda
//     { type: 'navigate', url } y aquí se navega sin recargar.
//  2. Avisos locales de alertas y pagos con la app en segundo plano. NO pide permiso: eso se hace solo desde
//     la pantalla Avisos, con un toque del usuario.
export function useNotifications() {
  const checkedRef = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'navigate' && isAppPath(event.data.url)) navigate(event.data.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    if (!('Notification' in window)) return;

    // Check for unread alerts every 60s
    const check = async () => {
      if (Notification.permission !== 'granted') return;
      if (document.visibilityState !== 'hidden') return;

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const { data: alerts } = await supabase
        .from('alerts')
        .select('title, message, alert_type')
        .eq('is_read', false)
        .eq('is_dismissed', false)
        .order('triggered_at', { ascending: false })
        .limit(3);

      const today = localDateKey(new Date());
      const { data: dueTodayRecs } = await supabase
        .from('recurring_transactions')
        .select('description, amount')
        .eq('is_active', true)
        .lte('next_due_date', today);

      for (const alert of alerts ?? []) {
        await show(`Wabid: ${alert.title}`, { body: alert.message ?? '', tag: alert.alert_type });
      }
      if (dueTodayRecs && dueTodayRecs.length > 0) {
        const names = dueTodayRecs.map(r => r.description).join(', ');
        await show('Wabid: Pagos pendientes', { body: `Hoy vence: ${names}`, tag: 'recurring_due' });
      }
    };

    setTimeout(check, 5000);
    const interval = setInterval(check, 60000);
    return () => clearInterval(interval);
  }, []);
}

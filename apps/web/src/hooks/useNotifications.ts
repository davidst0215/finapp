import { localDateKey } from '@/lib/utils';
import { useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';

export function useNotifications() {
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;

    // Request permission
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }

    // Check for unread alerts every 60s
    const check = async () => {
      if (Notification.permission !== 'granted') return;

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      // Check alerts
      const { data: alerts } = await supabase
        .from('alerts')
        .select('title, message, alert_type')
        .eq('is_read', false)
        .eq('is_dismissed', false)
        .order('triggered_at', { ascending: false })
        .limit(3);

      // Check recurring due today
      const today = localDateKey(new Date());
      const { data: dueTodayRecs } = await supabase
        .from('recurring_transactions')
        .select('description, amount')
        .eq('is_active', true)
        .lte('next_due_date', today);

      if (document.visibilityState === 'hidden') {
        // Alert notifications
        if (alerts) {
          for (const alert of alerts) {
            new Notification(`Wabid: ${alert.title}`, {
              body: alert.message ?? '',
              icon: '/icons/icon-192.png',
              tag: alert.alert_type,
            });
          }
        }

        // Recurring due notifications
        if (dueTodayRecs && dueTodayRecs.length > 0) {
          const names = dueTodayRecs.map(r => r.description).join(', ');
          new Notification('Wabid: Pagos pendientes', {
            body: `Hoy vence: ${names}`,
            icon: '/icons/icon-192.png',
            tag: 'recurring_due',
          });
        }
      }
    };

    // Check on load and every 60s
    setTimeout(check, 5000);
    const interval = setInterval(check, 60000);
    return () => clearInterval(interval);
  }, []);
}

import { useEffect, useState } from 'react';
import { Bell, BellOff, Check, AlertTriangle, CreditCard, Target, RefreshCw, TrendingDown } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { cn, localDateKey } from '@/lib/utils';
import { Spinner } from '@/components/ui/Spinner';
import { GlassCard } from '@/components/ui/GlassCard';
import type { Alert, AlertType } from '@/types/database';

const alertConfig: Record<AlertType, { icon: typeof Bell; color: string; label: string }> = {
  budget_threshold: { icon: AlertTriangle, color: 'text-slate-100', label: 'Presupuesto' },
  budget_exceeded: { icon: TrendingDown, color: 'text-expense', label: 'Presupuesto excedido' },
  recurring_due: { icon: RefreshCw, color: 'text-primary-400', label: 'Pago recurrente' },
  goal_milestone: { icon: Target, color: 'text-income', label: 'Meta de ahorro' },
  unusual_spending: { icon: AlertTriangle, color: 'text-expense', label: 'Gasto inusual' },
  credit_card_due: { icon: CreditCard, color: 'text-expense', label: 'Tarjeta de crédito' },
  low_balance: { icon: TrendingDown, color: 'text-expense', label: 'Saldo bajo' },
};

export function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAlerts = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('alerts')
      .select('*')
      .eq('is_dismissed', false)
      .order('triggered_at', { ascending: false })
      .limit(50);
    if (data) setAlerts(data);
    setLoading(false);
  };

  useEffect(() => {
    fetchAlerts();
    checkAndGenerateAlerts();
  }, []);

  // Generar alertas automáticamente al entrar
  async function checkAndGenerateAlerts() {
    // 1. Presupuestos al threshold
    const { data: budgetData } = await supabase.rpc('fn_get_budget_status');
    if (budgetData) {
      for (const b of budgetData as Array<{ budget_id: string; category_name: string; percentage_used: number; amount_limit: number; amount_spent: number }>) {
        if (b.percentage_used >= 80) {
          const alertType: AlertType = b.percentage_used >= 100 ? 'budget_exceeded' : 'budget_threshold';
          const title = b.percentage_used >= 100
            ? `Presupuesto de ${b.category_name} excedido`
            : `${b.category_name}: ${b.percentage_used.toFixed(0)}% del presupuesto usado`;
          const message = b.percentage_used >= 100
            ? `Gastaste S/${b.amount_spent.toFixed(2)} de S/${b.amount_limit.toFixed(2)} presupuestados.`
            : `Llevas S/${b.amount_spent.toFixed(2)} de S/${b.amount_limit.toFixed(2)}. Controla tus gastos.`;

          // Solo crear si no existe una alerta similar reciente (hoy)
          const today = localDateKey(new Date());
          const { data: existing } = await supabase
            .from('alerts')
            .select('alert_id')
            .eq('reference_id', b.budget_id)
            .eq('alert_type', alertType)
            .gte('triggered_at', today)
            .limit(1);

          if (!existing || existing.length === 0) {
            await supabase.from('alerts').insert({
              alert_type: alertType,
              reference_id: b.budget_id,
              title,
              message,
              is_read: false,
              is_dismissed: false,
            });
          }
        }
      }
    }

    // 2. Recurrentes próximas a vencer (3 días)
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);
    const { data: recurringData } = await supabase
      .from('recurring_transactions')
      .select('*')
      .eq('is_active', true)
      .lte('next_due_date', threeDaysFromNow.toISOString().slice(0, 10));

    if (recurringData) {
      for (const r of recurringData) {
        const today = localDateKey(new Date());
        const { data: existing } = await supabase
          .from('alerts')
          .select('alert_id')
          .eq('reference_id', r.recurring_id)
          .eq('alert_type', 'recurring_due')
          .gte('triggered_at', today)
          .limit(1);

        if (!existing || existing.length === 0) {
          await supabase.from('alerts').insert({
            alert_type: 'recurring_due' as AlertType,
            reference_id: r.recurring_id,
            title: `${r.description} próximo a vencer`,
            message: `Pago de S/${r.amount.toFixed(2)} vence el ${r.next_due_date}.`,
            is_read: false,
            is_dismissed: false,
          });
        }
      }
    }

    // Refrescar alertas después de generar
    fetchAlerts();
  }

  const handleMarkRead = async (alertId: string) => {
    await supabase.from('alerts').update({ is_read: true }).eq('alert_id', alertId);
    setAlerts(prev => prev.map(a => a.alert_id === alertId ? { ...a, is_read: true } : a));
  };

  const handleDismiss = async (alertId: string) => {
    await supabase.from('alerts').update({ is_dismissed: true }).eq('alert_id', alertId);
    setAlerts(prev => prev.filter(a => a.alert_id !== alertId));
  };

  const handleDismissAll = async () => {
    await supabase.from('alerts').update({ is_dismissed: true }).eq('is_dismissed', false);
    setAlerts([]);
  };

  const unreadCount = alerts.filter(a => !a.is_read).length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">Alertas</h1>
          {unreadCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-expense text-slate-950 text-xs font-bold">
              {unreadCount}
            </span>
          )}
        </div>
        {alerts.length > 0 && (
          <button onClick={handleDismissAll} className="text-xs text-slate-500 active:text-slate-300">
            Limpiar todo
          </button>
        )}
      </div>

      {loading ? (
        <Spinner />
      ) : alerts.length === 0 ? (
        <div className="card text-center py-10">
          <BellOff size={28} className="mx-auto text-slate-700 mb-3" />
          <p className="text-slate-500 text-sm">No tienes alertas pendientes</p>
          <p className="text-xs text-slate-600 mt-1">Las alertas se generan automáticamente</p>
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map(alert => {
            const config = alertConfig[alert.alert_type as AlertType] ?? alertConfig.budget_threshold;
            const Icon = config.icon;
            const timeAgo = getTimeAgo(alert.triggered_at);

            return (
              <GlassCard
                key={alert.alert_id}
                variant={!alert.is_read ? 'accent' : 'default'}
                className={cn('py-3 transition-all cursor-pointer',
                  !alert.is_read && 'border-l-2 border-l-primary-500'
                )}
                onClick={() => !alert.is_read && handleMarkRead(alert.alert_id)}
              >
                <div className="flex items-start gap-3">
                  <div className={cn('w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 bg-slate-800')}>
                    <Icon size={16} className={config.color} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className={cn('text-sm font-medium', !alert.is_read && 'text-slate-100')}>
                        {alert.title}
                      </p>
                      <button
                        onClick={e => { e.stopPropagation(); handleDismiss(alert.alert_id); }}
                        className="text-slate-700 hover:text-slate-400 flex-shrink-0 p-0.5"
                      >
                        <Check size={14} />
                      </button>
                    </div>
                    {alert.message && (
                      <p className="text-xs text-slate-500 mt-0.5">{alert.message}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      <span className={cn('text-[10px] px-1.5 py-0.5 rounded', `${config.color} bg-slate-800`)}>
                        {config.label}
                      </span>
                      <span className="text-[10px] text-slate-600">{timeAgo}</span>
                    </div>
                  </div>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}
    </div>
  );
}

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Ahora';
  if (minutes < 60) return `Hace ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Hace ${hours}h`;
  const days = Math.floor(hours / 24);
  return `Hace ${days}d`;
}

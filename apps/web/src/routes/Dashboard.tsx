import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, TrendingDown, ArrowRight, CalendarDays } from 'lucide-react';
import { AccountCard } from '@/components/ui/AccountCard';
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import { CategoryIcon } from '@/components/ui/CategoryIcon';
import { useAuthStore } from '@/stores/authStore';
import { formatCurrency } from '@/lib/utils';
import { Spinner } from '@/components/ui/Spinner';

interface MonthlySummary {
  total_income: number;
  total_expenses: number;
  net_balance: number;
  transaction_count: number;
  top_category_name: string;
  top_category_amount: number;
}

export function DashboardPage() {
  const profile = useAuthStore(s => s.profile);
  const { transactions, accounts, fetchTransactions, fetchAccounts, loadingTransactions } = useAppStore();
  const [summary, setSummary] = useState<MonthlySummary | null>(null);

  useEffect(() => {
    fetchTransactions(10);
    fetchAccounts();

    const now = new Date();
    supabase
      .rpc('fn_get_monthly_summary', { p_year: now.getFullYear(), p_month: now.getMonth() + 1 })
      .then(({ data }) => {
        if (data && data.length > 0) setSummary(data[0] as MonthlySummary);
      });
  }, [fetchTransactions, fetchAccounts]);

  const totalBalance = accounts.reduce((sum, acc) => {
    if (acc.account_type === 'credit_card') return sum - acc.current_balance;
    return sum + acc.current_balance;
  }, 0);

  const greeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Buenos días';
    if (hour < 18) return 'Buenas tardes';
    return 'Buenas noches';
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <p className="text-slate-400 text-sm">{greeting()}</p>
        <h1 className="text-xl font-bold">{profile?.display_name ?? 'Usuario'}</h1>
      </div>

      {/* Balance total + calendar link */}
      <div className="card flex items-center justify-between">
        <div>
          <p className="text-slate-400 text-xs mb-0.5">Balance total</p>
          <p className={`text-2xl font-bold ${totalBalance >= 0 ? 'text-income' : 'text-expense'}`}>
            {formatCurrency(totalBalance)}
          </p>
        </div>
        <Link to="/calendar" className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-slate-400 active:bg-slate-700">
          <CalendarDays size={18} />
        </Link>
      </div>

      {/* Resumen mensual */}
      {summary && (
        <div className="grid grid-cols-2 gap-3">
          <div className="card">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp size={16} className="text-income" />
              <span className="text-xs text-slate-400">Ingresos</span>
            </div>
            <p className="text-lg font-bold text-income">{formatCurrency(summary.total_income)}</p>
          </div>
          <div className="card">
            <div className="flex items-center gap-2 mb-1">
              <TrendingDown size={16} className="text-expense" />
              <span className="text-xs text-slate-400">Gastos</span>
            </div>
            <p className="text-lg font-bold text-expense">{formatCurrency(summary.total_expenses)}</p>
          </div>
        </div>
      )}

      {/* Cuentas rápidas */}
      {accounts.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Mis cuentas</h2>
            <Link to="/accounts" className="text-primary-500 text-sm flex items-center gap-1">
              Ver todas <ArrowRight size={14} />
            </Link>
          </div>
          <div className="flex gap-3 overflow-x-auto no-scrollbar pb-1">
            {accounts.slice(0, 4).map(acc => (
              <AccountCard
                key={acc.account_id}
                name={acc.account_name}
                balance={acc.current_balance}
                type={acc.account_type}
                className="min-w-[220px] flex-shrink-0"
              />
            ))}
          </div>
        </div>
      )}

      {/* Últimos movimientos */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Últimos movimientos</h2>
          <Link to="/transactions" className="text-primary-500 text-sm flex items-center gap-1">
            Ver todos <ArrowRight size={14} />
          </Link>
        </div>
        {loadingTransactions ? (
          <Spinner />
        ) : transactions.length === 0 ? (
          <div className="card text-center py-8">
            <p className="text-slate-500">No hay movimientos aún</p>
            <Link to="/" className="text-primary-500 text-sm mt-2 inline-block">
              Registrar tu primer gasto
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {transactions.slice(0, 5).map(tx => (
              <div key={tx.transaction_id} className="card flex items-center justify-between py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <CategoryIcon name={tx.category?.category_name} emoji={tx.category?.icon} color={tx.category?.color} size={16} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{tx.description ?? tx.category?.category_name ?? 'Sin categoría'}</p>
                    <p className="text-xs text-slate-500">{tx.account?.account_name}</p>
                  </div>
                </div>
                <p className={`font-semibold text-sm flex-shrink-0 ${tx.transaction_type === 'income' ? 'text-income' : 'text-expense'}`}>
                  {tx.transaction_type === 'income' ? '+' : '-'}{formatCurrency(tx.amount, tx.currency_code)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

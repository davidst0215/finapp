import { useEffect, useState } from 'react';
import { Plus, CreditCard, Wallet, PiggyBank, TrendingUp, X, Check } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/Spinner';
import type { AccountType } from '@/types/database';

const accountTypeConfig: Record<string, { icon: typeof Wallet; label: string; color: string }> = {
  checking: { icon: Wallet, label: 'Cuenta corriente', color: '#3b82f6' },
  savings: { icon: PiggyBank, label: 'Ahorro', color: '#10b981' },
  credit_card: { icon: CreditCard, label: 'Tarjeta de crédito', color: '#ef4444' },
  cash: { icon: Wallet, label: 'Efectivo', color: '#f59e0b' },
  investment: { icon: TrendingUp, label: 'Inversión', color: '#8b5cf6' },
};

export function AccountsPage() {
  const { accounts, fetchAccounts, loadingAccounts } = useAppStore();
  const addToast = useToastStore(s => s.addToast);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('checking');
  const [balance, setBalance] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const handleAdd = async () => {
    if (!name) return;
    setSaving(true);

    await supabase.from('accounts').insert({
      account_name: name,
      account_type: type,
      currency_code: 'PEN',
      current_balance: parseFloat(balance) || 0,
      color: accountTypeConfig[type]?.color ?? '#3b82f6',
      is_active: true,
    });

    setName('');
    setBalance('');
    setShowForm(false);
    setSaving(false);
    fetchAccounts();
    addToast('Cuenta creada');
  };

  const totalBalance = accounts.reduce((sum, acc) => {
    if (acc.account_type === 'credit_card') return sum - acc.current_balance;
    return sum + acc.current_balance;
  }, 0);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Cuentas</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="w-9 h-9 rounded-full bg-primary-600 flex items-center justify-center"
        >
          {showForm ? <X size={18} /> : <Plus size={18} />}
        </button>
      </div>

      {/* Balance total */}
      <div className="card text-center">
        <p className="text-slate-400 text-sm">Patrimonio neto</p>
        <p className={cn('text-2xl font-bold', totalBalance >= 0 ? 'text-income' : 'text-expense')}>
          {formatCurrency(totalBalance)}
        </p>
      </div>

      {/* Formulario nueva cuenta */}
      {showForm && (
        <div className="card space-y-3">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Nombre de la cuenta"
            className="input"
            autoFocus
          />
          <div className="flex gap-2 flex-wrap">
            {Object.entries(accountTypeConfig).map(([key, { label }]) => (
              <button
                key={key}
                onClick={() => setType(key as AccountType)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium',
                  type === key ? 'bg-primary-600 text-white' : 'bg-slate-800 text-slate-400'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            type="number"
            value={balance}
            onChange={e => setBalance(e.target.value)}
            placeholder="Saldo inicial (S/)"
            className="input"
            inputMode="decimal"
          />
          <button onClick={handleAdd} disabled={!name || saving} className="btn-primary w-full flex items-center justify-center gap-2">
            <Check size={16} /> {saving ? 'Guardando...' : 'Crear cuenta'}
          </button>
        </div>
      )}

      {/* Lista de cuentas */}
      <div className="space-y-2">
        {accounts.map(acc => {
          const config = accountTypeConfig[acc.account_type];
          const Icon = config?.icon ?? Wallet;
          return (
            <div
              key={acc.account_id}
              className="card flex items-center justify-between"
              style={{ borderLeftColor: acc.color ?? '#3b82f6', borderLeftWidth: 3 }}
            >
              <div className="flex items-center gap-3">
                <Icon size={20} style={{ color: acc.color ?? '#3b82f6' }} />
                <div>
                  <p className="font-medium text-sm">{acc.account_name}</p>
                  <p className="text-xs text-slate-500">{config?.label ?? acc.account_type}</p>
                </div>
              </div>
              <div className="text-right">
                <p className={cn('font-bold', acc.account_type === 'credit_card' ? 'text-expense' : 'text-white')}>
                  {formatCurrency(acc.current_balance)}
                </p>
                {acc.account_type === 'credit_card' && acc.credit_limit && (
                  <p className="text-[10px] text-slate-500">Límite: {formatCurrency(acc.credit_limit)}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {loadingAccounts ? (
        <Spinner />
      ) : accounts.length === 0 && !showForm ? (
        <div className="text-center py-10">
          <Wallet size={32} className="mx-auto text-slate-700 mb-3" />
          <p className="text-slate-500">No tienes cuentas configuradas</p>
          <button onClick={() => setShowForm(true)} className="text-primary-500 text-sm mt-2">
            Agregar tu primera cuenta
          </button>
        </div>
      ) : null}
    </div>
  );
}

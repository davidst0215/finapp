import { useEffect, useState } from 'react';
import { Plus, CreditCard, Wallet, PiggyBank, TrendingUp, X, Check } from 'lucide-react';
import { AccountCard } from '@/components/ui/AccountCard';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/Spinner';
import { NotaCambio } from '@/components/ui/NotaCambio';
import { conversionDePatrimonio, diaLima, equivalenteEnSoles, notaConversion, patrimonio } from '@/lib/fx';
import { useTipoCambio } from '@/stores/fxStore';
import type { AccountType } from '@/types/database';

type Moneda = 'PEN' | 'USD';
const MONEDAS: { code: Moneda; label: string }[] = [
  { code: 'PEN', label: 'S/ Soles' },
  { code: 'USD', label: 'US$ Dólares' },
];

const accountTypeConfig: Record<string, { icon: typeof Wallet; label: string; color: string }> = {
  checking: { icon: Wallet, label: 'Cuenta corriente', color: '#f0f0f2' },
  savings: { icon: PiggyBank, label: 'Ahorro', color: '#c8ccd4' },
  credit_card: { icon: CreditCard, label: 'Tarjeta de crédito', color: '#c8ccd4' },
  cash: { icon: Wallet, label: 'Efectivo', color: '#c8ccd4' },
  investment: { icon: TrendingUp, label: 'Inversión', color: '#9a9aa6' },
};

export function AccountsPage() {
  const { accounts, fetchAccounts, loadingAccounts } = useAppStore();
  const addToast = useToastStore(s => s.addToast);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('checking');
  const [currency, setCurrency] = useState<Moneda>('PEN');
  const [balance, setBalance] = useState('');
  const [saving, setSaving] = useState(false);
  const { tc, listo } = useTipoCambio();

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const handleAdd = async () => {
    if (!name) return;
    setSaving(true);

    const { error } = await supabase.from('accounts').insert({
      account_name: name,
      account_type: type,
      currency_code: currency,
      current_balance: parseFloat(balance) || 0,
      color: accountTypeConfig[type]?.color ?? '#c8ccd4',
      is_active: true,
    });
    setSaving(false);
    if (error) {
      addToast('No pude crear la cuenta. Inténtalo de nuevo.', 'warning');
      return;
    }

    setName('');
    setBalance('');
    setCurrency('PEN');
    setShowForm(false);
    fetchAccounts();
    addToast('Cuenta creada');
  };

  // Patrimonio en soles: las cuentas en dólares se convierten con el tipo de cambio vigente; la tarjeta resta (su saldo es deuda).
  const patri = patrimonio(accounts, tc);
  const hoy = diaLima(new Date());
  const totalBalance = patri.soles;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Cuentas</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="w-9 h-9 rounded-full bg-primary-600 flex items-center justify-center text-slate-950"
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
        {/* Primera carga (sin tipo de cambio ni lectura terminada): sin nota, para no decir «falta» cuando solo está llegando */}
        <NotaCambio texto={!tc && !listo ? null : notaConversion(conversionDePatrimonio(patri, tc), hoy)} className="mt-1" />
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
                  'px-3 min-h-11 rounded-lg text-xs font-medium',
                  type === key ? 'bg-primary-600 text-slate-950' : 'bg-slate-800 text-slate-400'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Moneda: no se puede cambiar después de registrar movimientos, por eso se elige al crear */}
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Moneda de la cuenta">
            {MONEDAS.map(({ code, label }) => (
              <button
                key={code}
                role="radio"
                aria-checked={currency === code}
                onClick={() => setCurrency(code)}
                className={cn(
                  'min-h-11 rounded-lg text-sm font-medium',
                  currency === code ? 'bg-primary-600 text-slate-950' : 'bg-slate-800 text-slate-400'
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
            placeholder={`Saldo inicial (${currency === 'USD' ? 'US$' : 'S/'})`}
            className="input"
            inputMode="decimal"
          />
          <button onClick={handleAdd} disabled={!name || saving} className="btn-primary w-full flex items-center justify-center gap-2">
            <Check size={16} /> {saving ? 'Guardando...' : 'Crear cuenta'}
          </button>
        </div>
      )}

      {/* Lista de cuentas */}
      <div className="space-y-3">
        {accounts.map(acc => (
          <AccountCard
            key={acc.account_id}
            name={acc.account_name}
            balance={acc.current_balance}
            currency={acc.currency_code}
            equivalent={equivalenteEnSoles(acc.current_balance, acc.currency_code, tc, hoy)}
            type={acc.account_type}
          />
        ))}
      </div>

      {loadingAccounts && accounts.length === 0 ? (
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

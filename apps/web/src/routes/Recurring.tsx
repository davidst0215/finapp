import { useEffect, useState } from 'react';
import { Plus, X, Check, Trash2, Calendar, RefreshCw } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import { formatCurrency, formatDate } from '@/lib/utils';
import { cn } from '@/lib/utils';
import type { RecurringTransaction, Frequency, TransactionType } from '@/types/database';

const frequencyLabels: Record<Frequency, string> = {
  daily: 'Diario',
  weekly: 'Semanal',
  biweekly: 'Quincenal',
  monthly: 'Mensual',
  quarterly: 'Trimestral',
  semiannual: 'Semestral',
  annual: 'Anual',
};

export function RecurringPage() {
  const { accounts, categories, fetchAccounts, fetchCategories } = useAppStore();
  const [recurrings, setRecurrings] = useState<RecurringTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<TransactionType>('expense');
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchRecurrings = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('recurring_transactions')
      .select('*')
      .eq('is_active', true)
      .order('next_due_date');
    if (data) setRecurrings(data);
    setLoading(false);
  };

  useEffect(() => {
    fetchRecurrings();
    fetchAccounts();
    fetchCategories();
  }, [fetchAccounts, fetchCategories]);

  useEffect(() => {
    if (accounts.length > 0 && !accountId) setAccountId(accounts[0]!.account_id);
  }, [accounts, accountId]);

  const filteredCategories = categories.filter(c => c.category_type === type);

  const handleAdd = async () => {
    if (!description || !amount || !accountId) return;
    setSaving(true);

    const day = parseInt(dayOfMonth) || 1;
    const now = new Date();
    let nextDue = new Date(now.getFullYear(), now.getMonth(), day);
    if (nextDue <= now) nextDue.setMonth(nextDue.getMonth() + 1);

    await supabase.from('recurring_transactions').insert({
      description,
      amount: parseFloat(amount),
      transaction_type: type,
      frequency,
      day_of_month: day,
      account_id: accountId,
      category_id: categoryId || null,
      currency_code: 'PEN',
      start_date: new Date().toISOString().slice(0, 10),
      next_due_date: nextDue.toISOString().slice(0, 10),
      is_active: true,
      auto_register: false,
    });

    resetForm();
    setSaving(false);
    fetchRecurrings();
  };

  const handleDelete = async (id: string) => {
    await supabase.from('recurring_transactions').update({ is_active: false }).eq('recurring_id', id);
    fetchRecurrings();
  };

  const resetForm = () => {
    setDescription('');
    setAmount('');
    setCategoryId('');
    setShowForm(false);
  };

  const totalMonthly = recurrings
    .filter(r => r.frequency === 'monthly')
    .reduce((s, r) => r.transaction_type === 'expense' ? s + r.amount : s - r.amount, 0);

  const getDaysUntilDue = (dateStr: string) => {
    const due = new Date(dateStr);
    const now = new Date();
    const diff = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return diff;
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Recurrentes</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="w-9 h-9 rounded-full bg-primary-600 flex items-center justify-center"
        >
          {showForm ? <X size={18} /> : <Plus size={18} />}
        </button>
      </div>

      {/* Resumen */}
      {recurrings.length > 0 && (
        <div className="card text-center">
          <p className="text-slate-400 text-xs">Gasto fijo mensual</p>
          <p className="text-2xl font-bold text-expense">{formatCurrency(totalMonthly)}</p>
          <p className="text-[10px] text-slate-500 mt-1">{recurrings.length} pagos configurados</p>
        </div>
      )}

      {/* Formulario */}
      {showForm && (
        <div className="card space-y-3">
          <p className="text-sm font-medium">Nuevo pago recurrente</p>

          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Ej: Netflix, Gym, Alquiler..."
            className="input"
            autoFocus
          />

          <div className="flex gap-2">
            {(['expense', 'income'] as TransactionType[]).map(t => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={cn('flex-1 py-2 rounded-xl text-sm font-semibold',
                  type === t
                    ? t === 'expense' ? 'bg-expense text-white' : 'bg-income text-white'
                    : 'bg-slate-800 text-slate-400'
                )}
              >
                {t === 'expense' ? 'Gasto' : 'Ingreso'}
              </button>
            ))}
          </div>

          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">S/</span>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="Monto"
              className="input pl-10"
              inputMode="decimal"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Frecuencia</label>
              <select
                value={frequency}
                onChange={e => setFrequency(e.target.value as Frequency)}
                className="input text-sm"
              >
                {Object.entries(frequencyLabels).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Día del mes</label>
              <input
                type="number"
                value={dayOfMonth}
                onChange={e => setDayOfMonth(e.target.value)}
                min="1"
                max="31"
                className="input text-sm"
              />
            </div>
          </div>

          {/* Cuenta */}
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Cuenta</label>
            <div className="flex gap-2 overflow-x-auto no-scrollbar">
              {accounts.map(acc => (
                <button
                  key={acc.account_id}
                  onClick={() => setAccountId(acc.account_id)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-xs whitespace-nowrap flex-shrink-0',
                    accountId === acc.account_id ? 'bg-primary-600 text-white' : 'bg-slate-800 text-slate-400'
                  )}
                >
                  {acc.account_name}
                </button>
              ))}
            </div>
          </div>

          {/* Categoría */}
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Categoría</label>
            <div className="grid grid-cols-3 gap-1.5">
              {filteredCategories.slice(0, 9).map(cat => (
                <button
                  key={cat.category_id}
                  onClick={() => setCategoryId(cat.category_id)}
                  className={cn(
                    'px-2 py-1.5 rounded-lg text-[11px] font-medium text-center',
                    categoryId === cat.category_id ? 'bg-primary-600 text-white' : 'bg-slate-800 text-slate-400'
                  )}
                >
                  {cat.icon} {cat.category_name}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleAdd}
            disabled={!description || !amount || saving}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            <Check size={16} /> {saving ? 'Guardando...' : 'Crear recurrente'}
          </button>
        </div>
      )}

      {/* Lista */}
      {loading ? (
        <div className="text-center py-10 text-slate-500">Cargando...</div>
      ) : recurrings.length === 0 && !showForm ? (
        <div className="card text-center py-10">
          <RefreshCw size={28} className="mx-auto text-slate-700 mb-3" />
          <p className="text-slate-500 text-sm">No tienes pagos recurrentes</p>
          <button onClick={() => setShowForm(true)} className="text-primary-500 text-sm mt-2">
            Agregar suscripción o pago fijo
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {recurrings.map(r => {
            const daysUntil = getDaysUntilDue(r.next_due_date);
            const isUrgent = daysUntil <= 3;
            const isSoon = daysUntil <= 7 && !isUrgent;

            return (
              <div key={r.recurring_id} className="card flex items-center justify-between py-3 group">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={cn(
                    'w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0',
                    r.transaction_type === 'expense' ? 'bg-expense/10' : 'bg-income/10'
                  )}>
                    <RefreshCw size={16} className={r.transaction_type === 'expense' ? 'text-expense' : 'text-income'} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{r.description}</p>
                    <div className="flex items-center gap-2 text-[11px] text-slate-500">
                      <span>{frequencyLabels[r.frequency as Frequency]}</span>
                      <span>·</span>
                      <span className="flex items-center gap-0.5">
                        <Calendar size={10} />
                        {isUrgent ? (
                          <span className="text-expense font-medium">
                            {daysUntil <= 0 ? 'Vencido' : `En ${daysUntil}d`}
                          </span>
                        ) : isSoon ? (
                          <span className="text-yellow-400">En {daysUntil}d</span>
                        ) : (
                          <span>{formatDate(r.next_due_date)}</span>
                        )}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <p className={cn('font-semibold text-sm',
                    r.transaction_type === 'expense' ? 'text-expense' : 'text-income'
                  )}>
                    {formatCurrency(r.amount)}
                  </p>
                  <button
                    onClick={() => handleDelete(r.recurring_id)}
                    className="text-slate-700 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

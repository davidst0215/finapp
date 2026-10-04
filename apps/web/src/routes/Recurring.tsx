import { useEffect, useState } from 'react';
import { Plus, X, Check, Trash2, Calendar, RefreshCw, CircleCheck, Circle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import { CategoryIcon } from '@/components/ui/CategoryIcon';
import { useToastStore } from '@/stores/toastStore';
import { formatCurrency, formatDate, localDateKey } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { GlassCard } from '@/components/ui/GlassCard';
import { Spinner } from '@/components/ui/Spinner';
import type { RecurringTransaction, Frequency, TransactionType } from '@/types/database';

const frequencyLabels: Record<Frequency, string> = {
  daily: 'Diario', weekly: 'Semanal', biweekly: 'Quincenal',
  monthly: 'Mensual', quarterly: 'Trimestral', semiannual: 'Semestral', annual: 'Anual',
};

interface RecurringWithStatus extends RecurringTransaction {
  isPaidThisMonth: boolean;
}

export function RecurringPage() {
  const { accounts, categories, fetchAccounts, fetchCategories } = useAppStore();
  const [recurrings, setRecurrings] = useState<RecurringWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [type] = useState<TransactionType>('expense');
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [saving, setSaving] = useState(false);
  const addToast = useToastStore(s => s.addToast);

  const fetchRecurrings = async () => {
    setLoading(true);

    // Fetch recurrings
    const { data: recs } = await supabase
      .from('recurring_transactions')
      .select('*')
      .eq('is_active', true)
      .order('next_due_date');

    if (!recs) { setLoading(false); return; }

    // Check which ones have been paid this month
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

    const { data: paidTxs } = await supabase
      .from('transactions')
      .select('recurring_id')
      .eq('is_recurring', true)
      .gte('transaction_date', monthStart)
      .lte('transaction_date', monthEnd + 'T23:59:59');

    const paidIds = new Set((paidTxs ?? []).map(t => t.recurring_id).filter(Boolean));

    setRecurrings(recs.map(r => ({
      ...r,
      isPaidThisMonth: paidIds.has(r.recurring_id),
    })));
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
      description, amount: parseFloat(amount), transaction_type: type,
      frequency, day_of_month: day, account_id: accountId,
      category_id: categoryId || null, currency_code: 'PEN',
      start_date: localDateKey(new Date()),
      next_due_date: nextDue.toISOString().slice(0, 10),
      is_active: true, auto_register: false,
    });

    resetForm();
    setSaving(false);
    fetchRecurrings();
    addToast('Recurrente creado');
  };

  const handleDelete = async (id: string) => {
    await supabase.from('recurring_transactions').delete().eq('recurring_id', id);
    fetchRecurrings();
    addToast('Pago recurrente eliminado');
  };

  const getNextDueDate = (currentDue: string, freq: string): string => {
    const d = new Date(currentDue);
    switch (freq) {
      case 'daily': d.setDate(d.getDate() + 1); break;
      case 'weekly': d.setDate(d.getDate() + 7); break;
      case 'biweekly': d.setDate(d.getDate() + 14); break;
      case 'monthly': d.setMonth(d.getMonth() + 1); break;
      case 'quarterly': d.setMonth(d.getMonth() + 3); break;
      case 'semiannual': d.setMonth(d.getMonth() + 6); break;
      case 'annual': d.setFullYear(d.getFullYear() + 1); break;
    }
    return d.toISOString().slice(0, 10);
  };

  const handleTogglePaid = async (r: RecurringWithStatus) => {
    if (r.isPaidThisMonth) {
      // Unmark: delete the transaction for this month
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

      await supabase.from('transactions')
        .delete()
        .eq('recurring_id', r.recurring_id)
        .gte('transaction_date', monthStart)
        .lte('transaction_date', monthEnd + 'T23:59:59');

      addToast(`${r.description} desmarcado`);
    } else {
      // Mark as paid: create transaction + advance date
      await supabase.from('transactions').insert({
        transaction_type: r.transaction_type, amount: r.amount,
        currency_code: 'PEN', description: r.description,
        account_id: r.account_id, category_id: r.category_id,
        transaction_date: new Date().toISOString(), input_method: 'recurring',
        raw_voice_text: null, is_recurring: true, recurring_id: r.recurring_id,
        transfer_to_account_id: null, notes: null, tags: null,
      });

      const nextDue = getNextDueDate(r.next_due_date, r.frequency);
      await supabase.from('recurring_transactions')
        .update({ next_due_date: nextDue })
        .eq('recurring_id', r.recurring_id);

      addToast(`${r.description} pagado`);
    }

    fetchRecurrings();
  };

  const resetForm = () => {
    setDescription(''); setAmount(''); setCategoryId(''); setShowForm(false);
  };

  const totalMonthly = recurrings
    .filter(r => r.frequency === 'monthly')
    .reduce((s, r) => r.transaction_type === 'expense' ? s + r.amount : s - r.amount, 0);

  const paidCount = recurrings.filter(r => r.isPaidThisMonth).length;
  const pendingCount = recurrings.length - paidCount;

  const getDaysUntilDue = (dateStr: string) => {
    const due = new Date(dateStr);
    const now = new Date();
    return Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Recurrentes</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="w-9 h-9 rounded-full bg-primary-600 flex items-center justify-center text-slate-950"
        >
          {showForm ? <X size={18} /> : <Plus size={18} />}
        </button>
      </div>

      {/* Summary */}
      {recurrings.length > 0 && (
        <div className="card text-center">
          <p className="text-slate-400 text-xs mb-1">Gasto fijo mensual</p>
          <p className="text-2xl font-bold text-expense">{formatCurrency(totalMonthly)}</p>
          <div className="flex items-center justify-center gap-4 mt-2">
            <span className="text-xs text-primary-400">{paidCount} pagados</span>
            <span className="text-[10px] text-slate-600">·</span>
            <span className="text-xs text-slate-400">{pendingCount} pendientes</span>
          </div>
        </div>
      )}

      {/* Form */}
      {showForm && (
        <div className="card space-y-3">
          <p className="text-sm font-medium">Nuevo recurrente</p>
          <input type="text" value={description} onChange={e => setDescription(e.target.value)} placeholder="Nombre (ej: Netflix, Alquiler)" className="input" />
          <div className="flex gap-2">
            <div className="relative flex-1">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">S/</span>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" className="input pl-10" inputMode="decimal" />
            </div>
            <select value={frequency} onChange={e => setFrequency(e.target.value as Frequency)} className="input w-28">
              {Object.entries(frequencyLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <input type="number" value={dayOfMonth} onChange={e => setDayOfMonth(e.target.value)} placeholder="Día" className="input w-20" min={1} max={31} />
            <p className="text-xs text-slate-500 self-center">del mes</p>
          </div>
          {/* Categories */}
          <div className="flex flex-wrap gap-1.5">
            {filteredCategories.map(cat => (
              <button key={cat.category_id} onClick={() => setCategoryId(cat.category_id)}
                className={cn('px-2 py-1.5 rounded-lg text-[11px] font-medium text-center',
                  categoryId === cat.category_id ? 'bg-primary-600 text-slate-950' : 'bg-slate-800 text-slate-400')}>
                <CategoryIcon name={cat.category_name} emoji={cat.icon} size={12} showBackground={false} className="inline-flex mr-1" />
                {cat.category_name}
              </button>
            ))}
          </div>
          <button onClick={handleAdd} disabled={!description || !amount || saving}
            className="btn-primary w-full flex items-center justify-center gap-2">
            <Check size={16} /> {saving ? 'Guardando...' : 'Crear recurrente'}
          </button>
        </div>
      )}

      {/* List */}
      {loading ? (
        <Spinner />
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
          {/* Pending first, then paid */}
          {[...recurrings].sort((a, b) => Number(a.isPaidThisMonth) - Number(b.isPaidThisMonth)).map(r => {
            const daysUntil = getDaysUntilDue(r.next_due_date);
            const isUrgent = daysUntil <= 3 && !r.isPaidThisMonth;
            const isSoon = daysUntil <= 7 && !isUrgent && !r.isPaidThisMonth;

            return (
              <GlassCard
                key={r.recurring_id}
                variant={r.isPaidThisMonth ? 'default' : isUrgent ? 'alert' : isSoon ? 'accent' : 'default'}
                className={cn('py-3', r.isPaidThisMonth && 'opacity-60')}
              >
                <div className="flex items-center gap-3">
                  {/* Checkbox */}
                  <button
                    onClick={() => handleTogglePaid(r)}
                    className="flex-shrink-0 p-0.5"
                  >
                    {r.isPaidThisMonth ? (
                      <CircleCheck size={22} className="text-primary-400" />
                    ) : (
                      <Circle size={22} className="text-slate-600" />
                    )}
                  </button>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className={cn('text-sm font-medium truncate', r.isPaidThisMonth && 'line-through text-slate-500')}>
                      {r.description}
                    </p>
                    <div className="flex items-center gap-2 text-[11px] text-slate-500">
                      <span>{frequencyLabels[r.frequency as Frequency]}</span>
                      <span>·</span>
                      {r.isPaidThisMonth ? (
                        <span className="text-primary-400">Pagado</span>
                      ) : (
                        <span className="flex items-center gap-0.5">
                          <Calendar size={10} />
                          {isUrgent ? (
                            <span className="text-expense font-medium">
                              {daysUntil <= 0 ? 'Vencido' : `En ${daysUntil}d`}
                            </span>
                          ) : isSoon ? (
                            <span className="text-primary-400">En {daysUntil}d</span>
                          ) : (
                            <span>{formatDate(r.next_due_date)}</span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Amount + delete */}
                  <div className="flex items-center gap-2">
                    <p className={cn('font-semibold text-sm',
                      r.isPaidThisMonth ? 'text-slate-500' :
                      r.transaction_type === 'expense' ? 'text-expense' : 'text-income'
                    )}>
                      {formatCurrency(r.amount)}
                    </p>
                    <button onClick={() => handleDelete(r.recurring_id)}
                      className="text-slate-700 opacity-0 group-hover:opacity-100 transition-opacity p-1">
                      <Trash2 size={12} />
                    </button>
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

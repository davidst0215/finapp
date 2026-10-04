import { useEffect, useState, useMemo } from 'react';
import { ArrowLeft, CalendarRange, CalendarDays } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { formatCurrency } from '@/lib/utils';
import { Calendar } from '@/components/ui/Calendar';
import { CategoryIcon } from '@/components/ui/CategoryIcon';
import { cn } from '@/lib/utils';

function toKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function inRange(date: Date, start: Date | null, end: Date | null) {
  if (!start || !end) return false;
  const t = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
  return t >= s && t <= e;
}

function formatShortDate(d: Date) {
  return d.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' });
}

export function CalendarPage() {
  const navigate = useNavigate();
  const { transactions, fetchTransactions } = useAppStore();

  const [mode, setMode] = useState<'day' | 'range'>('day');
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [rangeStart, setRangeStart] = useState<Date | null>(null);
  const [rangeEnd, setRangeEnd] = useState<Date | null>(null);

  useEffect(() => {
    fetchTransactions(200);
  }, [fetchTransactions]);

  // Markers
  const markers = useMemo(() => {
    const m: Record<string, { color: string; count: number }> = {};
    for (const tx of transactions) {
      const key = toKey(new Date(tx.transaction_date));
      if (!m[key]) {
        m[key] = { color: tx.transaction_type === 'income' ? 'rgb(var(--slate-100))' : 'rgb(var(--expense))', count: 0 };
      }
      m[key].count++;
      if (tx.transaction_type === 'income' && m[key].color === 'rgb(var(--expense))') {
        m[key].color = 'rgb(var(--slate-400))';
      }
    }
    return m;
  }, [transactions]);

  // Handle date selection
  const handleSelect = (date: Date) => {
    if (mode === 'day') {
      setSelectedDate(date);
      setRangeStart(null);
      setRangeEnd(null);
    } else {
      // Range mode: first tap = start, second tap = end
      if (!rangeStart || (rangeStart && rangeEnd)) {
        // Start new range
        setRangeStart(date);
        setRangeEnd(null);
      } else {
        // Set end (ensure start < end)
        if (date.getTime() < rangeStart.getTime()) {
          setRangeEnd(rangeStart);
          setRangeStart(date);
        } else {
          setRangeEnd(date);
        }
      }
    }
  };

  // Filtered transactions
  const filteredTransactions = useMemo(() => {
    if (mode === 'day') {
      const key = toKey(selectedDate);
      return transactions.filter(tx => toKey(new Date(tx.transaction_date)) === key);
    } else if (rangeStart && rangeEnd) {
      return transactions.filter(tx => inRange(new Date(tx.transaction_date), rangeStart, rangeEnd));
    } else if (rangeStart) {
      const key = toKey(rangeStart);
      return transactions.filter(tx => toKey(new Date(tx.transaction_date)) === key);
    }
    return [];
  }, [transactions, mode, selectedDate, rangeStart, rangeEnd]);

  const totalIncome = filteredTransactions.filter(t => t.transaction_type === 'income').reduce((s, t) => s + t.amount, 0);
  const totalExpense = filteredTransactions.filter(t => t.transaction_type === 'expense').reduce((s, t) => s + t.amount, 0);
  const netTotal = totalIncome - totalExpense;

  // Period label
  const periodLabel = () => {
    if (mode === 'day') {
      const today = new Date();
      if (toKey(selectedDate) === toKey(today)) return 'Hoy';
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      if (toKey(selectedDate) === toKey(yesterday)) return 'Ayer';
      return selectedDate.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'short' });
    }
    if (rangeStart && rangeEnd) {
      return `${formatShortDate(rangeStart)} — ${formatShortDate(rangeEnd)}`;
    }
    if (rangeStart) return `Desde ${formatShortDate(rangeStart)}...`;
    return 'Selecciona rango';
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 active:bg-slate-800">
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-lg font-bold">Calendario</h1>
        </div>

        {/* Mode toggle */}
        <div className="flex bg-slate-800 rounded-lg p-0.5">
          <button
            onClick={() => { setMode('day'); setRangeStart(null); setRangeEnd(null); }}
            className={cn(
              'px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors',
              mode === 'day' ? 'bg-primary-600 text-slate-950' : 'text-slate-400',
            )}
          >
            <CalendarDays size={14} />
          </button>
          <button
            onClick={() => { setMode('range'); }}
            className={cn(
              'px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors',
              mode === 'range' ? 'bg-primary-600 text-slate-950' : 'text-slate-400',
            )}
          >
            <CalendarRange size={14} />
          </button>
        </div>
      </div>

      {/* Calendar */}
      <div className="card">
        <Calendar
          selected={mode === 'day' ? selectedDate : null}
          rangeStart={mode === 'range' ? rangeStart : null}
          rangeEnd={mode === 'range' ? rangeEnd : null}
          onSelect={handleSelect}
          markers={markers}
        />

        {/* Range hint */}
        {mode === 'range' && !rangeEnd && (
          <p className="text-xs text-slate-500 text-center mt-2">
            {rangeStart ? 'Toca la fecha final' : 'Toca la fecha inicial'}
          </p>
        )}
      </div>

      {/* Period summary */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-200 capitalize">{periodLabel()}</p>
        <span className="text-xs text-slate-500">{filteredTransactions.length} mov.</span>
      </div>

      {/* Summary cards (range mode) */}
      {filteredTransactions.length > 0 && (mode === 'range' && rangeEnd) && (
        <div className="flex gap-2">
          <div className="card flex-1 py-2.5 text-center">
            <p className="text-[10px] text-slate-500 uppercase">Ingresos</p>
            <p className="text-sm font-bold text-income">{formatCurrency(totalIncome)}</p>
          </div>
          <div className="card flex-1 py-2.5 text-center">
            <p className="text-[10px] text-slate-500 uppercase">Gastos</p>
            <p className="text-sm font-bold text-expense">{formatCurrency(totalExpense)}</p>
          </div>
          <div className="card flex-1 py-2.5 text-center">
            <p className="text-[10px] text-slate-500 uppercase">Neto</p>
            <p className={cn('text-sm font-bold', netTotal >= 0 ? 'text-income' : 'text-expense')}>
              {formatCurrency(Math.abs(netTotal))}
            </p>
          </div>
        </div>
      )}

      {/* Transactions list */}
      {filteredTransactions.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-slate-500 text-sm">Sin movimientos en este período</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {filteredTransactions.map(tx => (
            <div key={tx.transaction_id} className="card flex items-center justify-between py-3">
              <div className="flex items-center gap-3 min-w-0">
                <CategoryIcon name={tx.category?.category_name} emoji={tx.category?.icon} color={tx.category?.color} size={16} />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{tx.description ?? tx.category?.category_name ?? 'Sin categoría'}</p>
                  <p className="text-xs text-slate-500">{tx.account?.account_name}</p>
                </div>
              </div>
              <p className={cn('font-semibold text-sm flex-shrink-0', tx.transaction_type === 'income' ? 'text-income' : 'text-expense')}>
                {tx.transaction_type === 'income' ? '+' : '-'}{formatCurrency(tx.amount, tx.currency_code)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

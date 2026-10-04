import { useEffect, useState } from 'react';
import { Plus, X, Check, Trash2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import { CategoryIcon } from '@/components/ui/CategoryIcon';
import { GlassCard } from '@/components/ui/GlassCard';
import { useToastStore } from '@/stores/toastStore';
import { formatCurrency } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

interface BudgetStatus {
  budget_id: string;
  category_name: string;
  category_icon: string | null;
  category_color: string | null;
  amount_limit: number;
  amount_spent: number;
  percentage_used: number;
  remaining: number;
}

export function BudgetsPage() {
  const { categories, fetchCategories } = useAppStore();
  const [budgets, setBudgets] = useState<BudgetStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const [amountLimit, setAmountLimit] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const addToast = useToastStore(s => s.addToast);

  const fetchBudgets = async () => {
    setLoading(true);
    const { data } = await supabase.rpc('fn_get_budget_status');
    if (data) setBudgets(data as BudgetStatus[]);
    setLoading(false);
  };

  useEffect(() => {
    fetchBudgets();
    fetchCategories();
  }, [fetchCategories]);

  const expenseCategories = categories.filter(c => c.category_type === 'expense');
  const usedCategoryNames = new Set(budgets.map(b => b.category_name));
  const availableCategories = expenseCategories.filter(c => !usedCategoryNames.has(c.category_name));

  const handleAdd = async () => {
    if (!categoryId || !amountLimit) return;
    setSaving(true);

    await supabase.from('budgets').insert({
      category_id: categoryId,
      amount_limit: parseFloat(amountLimit),
      period_type: 'monthly',
      alert_threshold: 0.80,
      is_active: true,
    });

    setCategoryId('');
    setAmountLimit('');
    setShowForm(false);
    setSaving(false);
    fetchBudgets();
    addToast('Presupuesto creado');
  };

  const handleDelete = async (budgetId: string) => {
    await supabase.from('budgets').delete().eq('budget_id', budgetId);
    setConfirmDeleteId(null);
    fetchBudgets();
    addToast('Presupuesto eliminado');
  };

  const totalLimit = budgets.reduce((s, b) => s + b.amount_limit, 0);
  const totalSpent = budgets.reduce((s, b) => s + b.amount_spent, 0);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Presupuestos</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="w-9 h-9 rounded-full bg-primary-600 flex items-center justify-center text-slate-950"
        >
          {showForm ? <X size={18} /> : <Plus size={18} />}
        </button>
      </div>

      {/* Resumen */}
      {budgets.length > 0 && (
        <div className="card text-center">
          <p className="text-slate-400 text-xs mb-1">Gastado del presupuesto total</p>
          <p className="text-2xl font-bold">
            <span className={totalSpent > totalLimit ? 'text-expense' : 'text-slate-100'}>
              {formatCurrency(totalSpent)}
            </span>
            <span className="text-slate-500 text-base"> / {formatCurrency(totalLimit)}</span>
          </p>
          <div className="h-2 bg-slate-800 rounded-full overflow-hidden mt-3">
            <div
              className={cn('h-full rounded-full transition-all',
                totalSpent > totalLimit ? 'bg-expense' : totalSpent / totalLimit > 0.8 ? 'bg-slate-200' : 'bg-slate-500'
              )}
              style={{ width: `${Math.min((totalSpent / totalLimit) * 100, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Formulario */}
      {showForm && (
        <div className="card space-y-3">
          <p className="text-sm font-medium">Nuevo presupuesto mensual</p>

          <div>
            <label className="text-xs text-slate-400 mb-2 block">Categoría</label>
            <div className="grid grid-cols-3 gap-2">
              {availableCategories.map(cat => (
                <button
                  key={cat.category_id}
                  onClick={() => setCategoryId(cat.category_id)}
                  className={cn(
                    'px-2 py-2 rounded-xl text-xs font-medium transition-all text-center',
                    categoryId === cat.category_id
                      ? 'bg-primary-600 text-slate-950'
                      : 'bg-slate-800 text-slate-400'
                  )}
                >
                  <CategoryIcon name={cat.category_name} emoji={cat.icon} size={14} showBackground={false} className="mx-auto mb-0.5" />
                  {cat.category_name}
                </button>
              ))}
            </div>
            {availableCategories.length === 0 && (
              <p className="text-xs text-slate-500 text-center py-3">Todas las categorías ya tienen presupuesto</p>
            )}
          </div>

          <div>
            <label className="text-xs text-slate-400 mb-1 block">Límite mensual</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">S/</span>
              <input
                type="number"
                value={amountLimit}
                onChange={e => setAmountLimit(e.target.value)}
                placeholder="0.00"
                className="input pl-10"
                inputMode="decimal"
              />
            </div>
          </div>

          <button
            onClick={handleAdd}
            disabled={!categoryId || !amountLimit || saving}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            <Check size={16} /> {saving ? 'Guardando...' : 'Crear presupuesto'}
          </button>
        </div>
      )}

      {/* Lista de presupuestos */}
      {loading ? (
        <Spinner />
      ) : budgets.length === 0 && !showForm ? (
        <div className="card text-center py-10">
          <p className="text-slate-500 text-sm">No tienes presupuestos configurados</p>
          <button onClick={() => setShowForm(true)} className="text-primary-500 text-sm mt-2">
            Crear tu primer presupuesto
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {budgets.map(b => {
            const pct = Math.min(b.percentage_used, 100);
            const isOver = b.percentage_used > 100;
            const isWarning = b.percentage_used >= 80 && !isOver;

            return (
              <GlassCard key={b.budget_id} variant={isOver ? 'alert' : isWarning ? 'accent' : 'default'} className="group">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <CategoryIcon name={b.category_name} size={14} showBackground={false} />
                    <span className="text-sm font-medium">{b.category_name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn('text-sm font-bold',
                      isOver ? 'text-expense' : isWarning ? 'text-slate-100 font-bold' : 'text-slate-100'
                    )}>
                      {formatCurrency(b.amount_spent)}
                    </span>
                    <span className="text-xs text-slate-500">/ {formatCurrency(b.amount_limit)}</span>
                    <button
                      onClick={() => setConfirmDeleteId(b.budget_id)}
                      className="text-slate-700 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                <div className="h-2.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={cn('h-full rounded-full transition-all',
                      isOver ? 'bg-expense' : isWarning ? 'bg-slate-200' : 'bg-slate-500'
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex justify-between mt-1">
                  <span className={cn('text-[10px]',
                    isOver ? 'text-expense' : isWarning ? 'text-slate-200' : 'text-slate-400'
                  )}>
                    {isOver
                      ? `Excedido por ${formatCurrency(Math.abs(b.remaining))}`
                      : `${b.percentage_used.toFixed(0)}% usado`
                    }
                  </span>
                  <span className="text-[10px] text-slate-500">
                    Quedan {formatCurrency(Math.max(b.remaining, 0))}
                  </span>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDeleteId}
        title="Eliminar presupuesto"
        message="¿Eliminar este presupuesto? Se perderá el seguimiento de gastos de esta categoría."
        onConfirm={() => confirmDeleteId && handleDelete(confirmDeleteId)}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Plus, X, Check, Trash2, Target, TrendingUp } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useToastStore } from '@/stores/toastStore';
import { formatCurrency } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { SavingsGoal } from '@/types/database';

export function SavingsGoalsPage() {
  const [goals, setGoals] = useState<SavingsGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showContribute, setShowContribute] = useState<string | null>(null);

  // Form state
  const [goalName, setGoalName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [contributeAmount, setContributeAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const addToast = useToastStore(s => s.addToast);

  const fetchGoals = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('savings_goals')
      .select('*')
      .order('is_completed', { ascending: true })
      .order('created_at', { ascending: false });
    if (data) setGoals(data);
    setLoading(false);
  };

  useEffect(() => { fetchGoals(); }, []);

  const handleAdd = async () => {
    if (!goalName || !targetAmount) return;
    setSaving(true);

    await supabase.from('savings_goals').insert({
      goal_name: goalName,
      target_amount: parseFloat(targetAmount),
      current_amount: 0,
      currency_code: 'PEN',
      target_date: targetDate || null,
      is_completed: false,
    });

    setGoalName('');
    setTargetAmount('');
    setTargetDate('');
    setShowForm(false);
    setSaving(false);
    fetchGoals();
    addToast('Meta creada');
  };

  const handleContribute = async (goalId: string) => {
    if (!contributeAmount) return;
    setSaving(true);

    const goal = goals.find(g => g.goal_id === goalId);
    if (!goal) return;

    const newAmount = goal.current_amount + parseFloat(contributeAmount);
    const isCompleted = newAmount >= goal.target_amount;

    await supabase
      .from('savings_goals')
      .update({
        current_amount: newAmount,
        is_completed: isCompleted,
      })
      .eq('goal_id', goalId);

    // Registrar contribución
    await supabase.from('savings_contributions').insert({
      goal_id: goalId,
      amount: parseFloat(contributeAmount),
    });

    setContributeAmount('');
    setShowContribute(null);
    setSaving(false);
    fetchGoals();
    addToast(isCompleted ? 'Meta completada!' : 'Aporte registrado');
  };

  const handleDelete = async (goalId: string) => {
    await supabase.from('savings_goals').delete().eq('goal_id', goalId);
    setConfirmDeleteId(null);
    fetchGoals();
    addToast('Meta eliminada');
  };

  const activeGoals = goals.filter(g => !g.is_completed);
  const completedGoals = goals.filter(g => g.is_completed);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Metas de ahorro</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="w-9 h-9 rounded-full bg-primary-600 flex items-center justify-center text-slate-950"
        >
          {showForm ? <X size={18} /> : <Plus size={18} />}
        </button>
      </div>

      {/* Formulario */}
      {showForm && (
        <div className="card space-y-3">
          <p className="text-sm font-medium">Nueva meta</p>
          <input
            type="text"
            value={goalName}
            onChange={e => setGoalName(e.target.value)}
            placeholder="Ej: Viaje a Europa, Fondo de emergencia..."
            className="input"
            autoFocus
          />
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">S/</span>
            <input
              type="number"
              value={targetAmount}
              onChange={e => setTargetAmount(e.target.value)}
              placeholder="Monto objetivo"
              className="input pl-10"
              inputMode="decimal"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Fecha objetivo (opcional)</label>
            <input
              type="date"
              value={targetDate}
              onChange={e => setTargetDate(e.target.value)}
              className="input"
            />
          </div>
          <button
            onClick={handleAdd}
            disabled={!goalName || !targetAmount || saving}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            <Check size={16} /> {saving ? 'Guardando...' : 'Crear meta'}
          </button>
        </div>
      )}

      {/* Metas activas */}
      {loading ? (
        <Spinner />
      ) : activeGoals.length === 0 && !showForm ? (
        <div className="card text-center py-10">
          <Target size={28} className="mx-auto text-slate-700 mb-3" />
          <p className="text-slate-500 text-sm">No tienes metas de ahorro</p>
          <button onClick={() => setShowForm(true)} className="text-primary-500 text-sm mt-2">
            Crear tu primera meta
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {activeGoals.map(g => {
            const pct = Math.min((g.current_amount / g.target_amount) * 100, 100);
            const daysLeft = g.target_date
              ? Math.ceil((new Date(g.target_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
              : null;

            return (
              <div key={g.goal_id} className="card group">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-medium text-sm">{g.goal_name}</p>
                  <button
                    onClick={() => setConfirmDeleteId(g.goal_id)}
                    className="text-slate-700 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>

                <div className="flex items-end justify-between mb-2">
                  <div>
                    <p className="text-xl font-bold text-primary-400">{formatCurrency(g.current_amount)}</p>
                    <p className="text-xs text-slate-500">de {formatCurrency(g.target_amount)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-slate-100">{pct.toFixed(0)}%</p>
                    {daysLeft !== null && (
                      <p className={cn('text-[10px]',
                        daysLeft < 0 ? 'text-expense' : daysLeft < 30 ? 'text-slate-100 font-semibold' : 'text-slate-400'
                      )}>
                        {daysLeft < 0 ? 'Vencida' : `${daysLeft} días restantes`}
                      </p>
                    )}
                  </div>
                </div>

                <div className="h-3 bg-slate-800 rounded-full overflow-hidden mb-3">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-primary-600 to-primary-400 transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>

                {/* Contribuir */}
                {showContribute === g.goal_id ? (
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs">S/</span>
                      <input
                        type="number"
                        value={contributeAmount}
                        onChange={e => setContributeAmount(e.target.value)}
                        placeholder="Monto"
                        className="input pl-8 py-2 text-sm"
                        inputMode="decimal"
                        autoFocus
                      />
                    </div>
                    <button
                      onClick={() => setShowContribute(null)}
                      className="btn-secondary px-3 py-2 text-xs"
                    >
                      <X size={14} />
                    </button>
                    <button
                      onClick={() => handleContribute(g.goal_id)}
                      disabled={!contributeAmount || saving}
                      className="btn-primary px-3 py-2 text-xs"
                    >
                      <Check size={14} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setShowContribute(g.goal_id); setContributeAmount(''); }}
                    className="w-full btn-secondary text-xs flex items-center justify-center gap-1.5 py-2"
                  >
                    <TrendingUp size={14} /> Agregar aporte
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Metas completadas */}
      <ConfirmDialog
        open={!!confirmDeleteId}
        title="Eliminar meta"
        message="¿Eliminar esta meta de ahorro? Se perderá todo el progreso registrado."
        onConfirm={() => confirmDeleteId && handleDelete(confirmDeleteId)}
        onCancel={() => setConfirmDeleteId(null)}
      />

      {completedGoals.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-400 mb-2">Completadas</h2>
          <div className="space-y-2">
            {completedGoals.map(g => (
              <div key={g.goal_id} className="card py-3 opacity-60">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Check size={16} className="text-income" />
                    <span className="text-sm">{g.goal_name}</span>
                  </div>
                  <span className="text-sm font-medium text-income">{formatCurrency(g.target_amount)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

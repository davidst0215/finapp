import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Filter, Trash2, Plus, Mic, Pencil, Check, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { CategoryIcon } from '@/components/ui/CategoryIcon';
import { useToastStore } from '@/stores/toastStore';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDateShort, localDateKey } from '@/lib/utils';
import type { TransactionType } from '@/types/database';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

type FilterType = 'all' | TransactionType;

export function TransactionsPage() {
  const { transactions, fetchTransactions, deleteTransaction, loadingTransactions } = useAppStore();
  const addToast = useToastStore(s => s.addToast);
  const [filter, setFilter] = useState<FilterType>('all');
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editDesc, setEditDesc] = useState('');

  const startEdit = (txId: string, amount: number, desc: string | null) => {
    setEditingId(txId);
    setEditAmount(String(amount));
    setEditDesc(desc ?? '');
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const amt = parseFloat(editAmount);
    if (!amt || amt <= 0) { addToast('Monto inválido', 'warning'); return; }
    await supabase.from('transactions').update({
      amount: amt,
      description: editDesc || null,
    }).eq('transaction_id', editingId);
    setEditingId(null);
    fetchTransactions(100);
    addToast('Transacción actualizada');
  };

  useEffect(() => {
    fetchTransactions(100);
  }, [fetchTransactions]);

  const filtered = transactions.filter(tx => {
    if (filter !== 'all' && tx.transaction_type !== filter) return false;
    if (search) {
      const s = search.toLowerCase();
      return (
        tx.description?.toLowerCase().includes(s) ||
        tx.category?.category_name.toLowerCase().includes(s) ||
        tx.account?.account_name.toLowerCase().includes(s)
      );
    }
    return true;
  });

  // Agrupar por fecha
  const grouped = filtered.reduce<Record<string, typeof filtered>>((acc, tx) => {
    const dateKey = localDateKey(tx.transaction_date);
    if (!acc[dateKey]) acc[dateKey] = [];
    acc[dateKey]!.push(tx);
    return acc;
  }, {});

  const handleDelete = async (id: string) => {
    await deleteTransaction(id);
    setConfirmDelete(null);
    addToast('Movimiento eliminado');
  };

  const deletingTx = confirmDelete ? transactions.find(t => t.transaction_id === confirmDelete) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Movimientos</h1>
        <Link to="/" className="w-9 h-9 rounded-full bg-primary-600 flex items-center justify-center text-slate-950">
          <Plus size={18} />
        </Link>
      </div>

      {/* Búsqueda */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar movimiento..."
          className="input pl-10"
        />
      </div>

      {/* Filtros */}
      <div className="flex gap-2">
        {([['all', 'Todos'], ['expense', 'Gastos'], ['income', 'Ingresos'], ['transfer', 'Transf.']] as [FilterType, string][]).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
              filter === value ? 'bg-primary-600 text-slate-950' : 'bg-slate-800 text-slate-400'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Lista */}
      {loadingTransactions && transactions.length === 0 ? (
        <Spinner />
      ) : Object.keys(grouped).length === 0 ? (
        <div className="text-center py-10">
          <Filter size={32} className="mx-auto text-slate-700 mb-3" />
          <p className="text-slate-500">No hay movimientos</p>
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped)
            .sort(([a], [b]) => b.localeCompare(a))
            .map(([dateKey, txs]) => {
              const dayTotal = txs.reduce((sum, tx) => {
                if (tx.transaction_type === 'income') return sum + tx.amount;
                if (tx.transaction_type === 'expense') return sum - tx.amount;
                return sum;
              }, 0);

              return (
                <div key={dateKey}>
                  <div className="flex items-center justify-between mb-2 px-1">
                    <p className="text-xs text-slate-500 font-medium uppercase">{formatDateShort(dateKey)}</p>
                    <p className={cn('text-xs font-medium', dayTotal >= 0 ? 'text-income' : 'text-expense')}>
                      {dayTotal >= 0 ? '+' : ''}{formatCurrency(dayTotal)}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    {txs.map(tx => {
                      const isEditing = editingId === tx.transaction_id;
                      return (
                        <div key={tx.transaction_id} className="card py-3 group">
                          {isEditing ? (
                            <div className="space-y-2">
                              <input value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="Descripción" className="input py-2 text-sm" />
                              <div className="flex items-center gap-2">
                                <div className="relative flex-1">
                                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">S/</span>
                                  <input type="number" value={editAmount} onChange={e => setEditAmount(e.target.value)} className="input py-2 pl-9 text-sm" inputMode="decimal" />
                                </div>
                                <button onClick={saveEdit} className="w-9 h-9 rounded-xl bg-primary-600 flex items-center justify-center text-slate-950">
                                  <Check size={16} />
                                </button>
                                <button onClick={() => setEditingId(null)} className="w-9 h-9 rounded-xl bg-slate-800 flex items-center justify-center text-slate-400">
                                  <X size={16} />
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3 min-w-0">
                                <CategoryIcon name={tx.category?.category_name} emoji={tx.category?.icon} color={tx.category?.color} size={17} />
                                <div className="min-w-0">
                                  <p className="text-sm font-medium truncate">{tx.description ?? tx.category?.category_name ?? 'Sin categoría'}</p>
                                  <p className="text-[11px] text-slate-500">
                                    {tx.account?.account_name}
                                    {tx.input_method === 'voice' && <Mic size={10} className="inline ml-1 text-slate-500" />}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <p className={cn('font-semibold text-sm', tx.transaction_type === 'income' ? 'text-income' : 'text-expense')}>
                                  {tx.transaction_type === 'income' ? '+' : '-'}{formatCurrency(tx.amount, tx.currency_code)}
                                </p>
                                <button onClick={() => startEdit(tx.transaction_id, tx.amount, tx.description)} className="text-slate-700 opacity-0 group-hover:opacity-100 p-1">
                                  <Pencil size={12} />
                                </button>
                                <button onClick={() => setConfirmDelete(tx.transaction_id)} className="text-slate-700 opacity-0 group-hover:opacity-100 p-1">
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Eliminar movimiento"
        message={deletingTx
          ? `¿Eliminar "${deletingTx.description ?? deletingTx.category?.category_name ?? 'movimiento'}" por ${formatCurrency(deletingTx.amount)}? Esta acción no se puede deshacer.`
          : '¿Eliminar este movimiento?'
        }
        onConfirm={() => confirmDelete && handleDelete(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

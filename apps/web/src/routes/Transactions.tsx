import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Filter, Trash2, Plus } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import { formatCurrency, formatDateShort } from '@/lib/utils';
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
    const dateKey = new Date(tx.transaction_date).toISOString().slice(0, 10);
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
        <Link to="/add" className="w-9 h-9 rounded-full bg-primary-600 flex items-center justify-center">
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
              filter === value ? 'bg-primary-600 text-white' : 'bg-slate-800 text-slate-400'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Lista */}
      {loadingTransactions ? (
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
                    {txs.map(tx => (
                      <div
                        key={tx.transaction_id}
                        className="card flex items-center justify-between py-3 group"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className="w-9 h-9 rounded-full flex items-center justify-center text-sm flex-shrink-0"
                            style={{ backgroundColor: tx.category?.color ? `${tx.category.color}20` : '#1e293b' }}
                          >
                            {tx.category?.icon ?? '💰'}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {tx.description ?? tx.category?.category_name ?? 'Sin categoría'}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              {tx.account?.account_name}
                              {tx.input_method === 'voice' && ' · 🎤'}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <p className={cn(
                            'font-semibold text-sm',
                            tx.transaction_type === 'income' ? 'text-income' : 'text-expense'
                          )}>
                            {tx.transaction_type === 'income' ? '+' : '-'}{formatCurrency(tx.amount)}
                          </p>
                          <button
                            onClick={() => setConfirmDelete(tx.transaction_id)}
                            className="text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
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

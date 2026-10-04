import { Camera, Check } from 'lucide-react';
import { formatDateShort } from '@/lib/utils';
import type { Transaction } from '@/types/database';
import { formatMoney, type Currency } from './reciboLogic.ts';

interface Props {
  /** La fila tal como quedó en la base de datos. */
  tx: Transaction;
  onAnother: () => void;
  onViewList: () => void;
}

/** Confirmación: muestra lo que realmente quedó guardado, no lo que se tecleó. */
export function DonePanel({ tx, onAnother, onViewList }: Props) {
  const currency: Currency = tx.currency_code === 'USD' ? 'USD' : 'PEN';
  const cents = Math.round(Number(tx.amount) * 100);
  const detail = [tx.category?.category_name, tx.account?.account_name, formatDateShort(tx.transaction_date)]
    .filter(Boolean)
    .join(' · ');

  return (
    <section aria-labelledby="recibo-done-title" className="space-y-4">
      <div className="card flex flex-col items-center gap-3 px-6 py-8 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-600 text-slate-950">
          <Check size={24} strokeWidth={2.4} aria-hidden="true" />
        </span>
        <h2 id="recibo-done-title" className="text-lg font-bold text-slate-100">
          Gasto registrado
        </h2>
        <p className="whitespace-nowrap text-3xl font-bold tabular-nums text-expense">
          {`−${formatMoney(cents, currency)}`}
        </p>
        <div className="min-w-0 max-w-full">
          <p className="truncate text-base font-semibold text-slate-100">{tx.description ?? 'Boleta'}</p>
          <p className="mt-0.5 text-sm text-slate-400">{detail}</p>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onAnother}
          className="btn-secondary flex flex-1 items-center justify-center gap-2 whitespace-nowrap"
        >
          <Camera size={18} strokeWidth={1.8} aria-hidden="true" />
          Otra boleta
        </button>
        <button type="button" onClick={onViewList} className="btn-primary flex-1 whitespace-nowrap">
          Ver movimientos
        </button>
      </div>
    </section>
  );
}

import { useRef } from 'react';
import { CreditCard, Wallet, PiggyBank, TrendingUp, type LucideIcon } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';

const typeIcons: Record<string, LucideIcon> = {
  checking: Wallet,
  savings: PiggyBank,
  credit_card: CreditCard,
  cash: Wallet,
  investment: TrendingUp,
};

const typeLabels: Record<string, string> = {
  checking: 'Cuenta corriente',
  savings: 'Ahorro',
  credit_card: 'Tarjeta de crédito',
  cash: 'Efectivo',
  investment: 'Inversión',
};

interface AccountCardProps {
  name: string;
  balance: number;
  type: string;
  className?: string;
}

export function AccountCard({ name, balance, type, className = '' }: AccountCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Touch/mouse tilt
  const handleMove = (clientX: number, clientY: number) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = ((clientY - rect.top - rect.height / 2) / (rect.height / 2)) * 8;
    const y = -((clientX - rect.left - rect.width / 2) / (rect.width / 2)) * 8;
    cardRef.current.style.transform = `perspective(800px) rotateX(${x}deg) rotateY(${y}deg)`;
  };

  const handleLeave = () => {
    if (cardRef.current) {
      cardRef.current.style.transform = 'perspective(800px) rotateX(0) rotateY(0)';
    }
  };

  const Icon = typeIcons[type] || Wallet;
  const isDebt = type === 'credit_card';

  return (
    <div className={`${className}`} style={{ perspective: '800px' }}>
      <div
        ref={cardRef}
        className="relative w-full rounded-2xl overflow-hidden border border-slate-700 bg-slate-900"
        style={{
          aspectRatio: '1.6',
          transition: 'transform 0.15s ease-out',
          transformStyle: 'preserve-3d',
        }}
        onMouseMove={e => handleMove(e.clientX, e.clientY)}
        onMouseLeave={handleLeave}
        onTouchMove={e => {
          const t = e.touches[0];
          if (t) handleMove(t.clientX, t.clientY);
        }}
        onTouchEnd={handleLeave}
      >
        {/* Content */}
        <div className="absolute inset-0 p-4 flex flex-col justify-between" style={{ transform: 'translateZ(1px)' }}>
          {/* Top: type + icon */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Icon size={16} className="text-slate-400" strokeWidth={1.5} />
              <span className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">
                {typeLabels[type] || type}
              </span>
            </div>
            {/* Chip */}
            <div
              className="w-8 h-5 rounded-[3px]"
              style={{
                background: 'rgb(var(--slate-600))',
              }}
            />
          </div>

          {/* Bottom: name + balance */}
          <div>
            <p className={`text-xl font-bold ${isDebt ? 'text-expense' : 'text-slate-100'}`}>
              {formatCurrency(balance)}
            </p>
            <p className="text-xs text-slate-400 mt-0.5 uppercase tracking-wider">{name}</p>
          </div>
        </div>
      </div>

    </div>
  );
}

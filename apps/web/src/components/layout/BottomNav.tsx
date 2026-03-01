import { NavLink } from 'react-router-dom';
import { LayoutDashboard, ArrowLeftRight, Plus, Wallet, MoreHorizontal } from 'lucide-react';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Inicio' },
  { to: '/transactions', icon: ArrowLeftRight, label: 'Movimientos' },
  { to: '/add', icon: Plus, label: 'Agregar', isCenter: true },
  { to: '/accounts', icon: Wallet, label: 'Cuentas' },
  { to: '/more', icon: MoreHorizontal, label: 'Más' },
];

export function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-slate-900 border-t border-slate-800 pb-safe">
      <div className="flex items-center justify-around h-16 max-w-lg mx-auto">
        {navItems.map(({ to, icon: Icon, label, isCenter }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 px-3 py-1 transition-colors ${
                isCenter
                  ? ''
                  : isActive
                  ? 'text-primary-500'
                  : 'text-slate-500 active:text-slate-300'
              }`
            }
          >
            {isCenter ? (
              <div className="flex items-center justify-center w-12 h-12 -mt-4 rounded-full bg-primary-600 text-white shadow-lg shadow-primary-600/30 active:bg-primary-700">
                <Icon size={24} />
              </div>
            ) : (
              <>
                <Icon size={20} />
                <span className="text-[10px] font-medium">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

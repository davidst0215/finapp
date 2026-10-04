import { NavLink } from 'react-router-dom';
import { Mic, ArrowLeftRight, PieChart, User } from 'lucide-react';

const navItems = [
  { to: '/', icon: Mic, label: 'Inicio' },
  { to: '/transactions', icon: ArrowLeftRight, label: 'Movimientos' },
  { to: '/dashboard', icon: PieChart, label: 'Resumen' },
  { to: '/more', icon: User, label: 'Perfil' },
];

export function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-slate-950/90 backdrop-blur-lg border-t border-slate-800/50 pb-safe">
      <div className="flex items-center justify-around h-14 max-w-lg mx-auto">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 px-4 py-1.5 transition-colors ${
                isActive
                  ? 'text-primary-500'
                  : 'text-slate-500 active:text-slate-300'
              }`
            }
          >
            <Icon size={20} strokeWidth={1.8} />
            <span className="text-[10px] font-medium">{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

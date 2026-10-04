import { NavLink, useLocation } from 'react-router-dom';
import { CheckSquare, CalendarDays, Wallet, LayoutGrid, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tab = { to: string; label: string; icon?: LucideIcon; matches: string[] };

// Rutas de cada pestaña: así una sub-página (p. ej. /budgets) mantiene activa su pestaña.
const TABS: Tab[] = [
  { to: '/', label: 'Wabid', matches: ['/'] },
  { to: '/tareas', label: 'Tareas', icon: CheckSquare, matches: ['/tareas'] },
  { to: '/agenda', label: 'Agenda', icon: CalendarDays, matches: ['/agenda'] },
  {
    to: '/dashboard', label: 'Finanzas', icon: Wallet,
    matches: ['/dashboard', '/transactions', '/accounts', '/budgets', '/goals', '/recurring', '/reports', '/calendar', '/alerts', '/recibo'],
  },
  {
    to: '/more', label: 'Más', icon: LayoutGrid,
    matches: ['/more', '/reuniones', '/correo', '/buscar', '/claude', '/brief', '/ai-chat', '/avisos'],
  },
];

const isActive = (tab: Tab, path: string) =>
  tab.to === '/' ? path === '/' : tab.matches.some((m) => path === m || path.startsWith(`${m}/`));

export function TabBar() {
  const { pathname } = useLocation();
  return (
    <nav
      aria-label="Secciones"
      className="fixed bottom-0 inset-x-0 z-40 border-t border-slate-700 bg-slate-950"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="max-w-lg mx-auto flex justify-around">
        {TABS.map((tab) => {
          const active = isActive(tab, pathname);
          const Icon = tab.icon;
          return (
            <li key={tab.to} className="flex-1">
              <NavLink
                to={tab.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex flex-col items-center gap-1 pt-2.5 pb-2 min-h-[56px] text-[11.5px] font-semibold transition-colors',
                  active ? 'text-slate-100' : 'text-slate-500 active:text-slate-300',
                )}
              >
                {Icon ? <Icon size={23} strokeWidth={1.7} /> : <span className={cn('orb-mini', active && 'orb-mini-on')} />}
                {tab.label}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

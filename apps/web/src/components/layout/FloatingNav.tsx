import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Menu, X, ArrowLeftRight, PieChart, User, Home } from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/', icon: Home, label: 'Inicio' },
  { to: '/transactions', icon: ArrowLeftRight, label: 'Movimientos' },
  { to: '/dashboard', icon: PieChart, label: 'Resumen' },
  { to: '/more', icon: User, label: 'Mi espacio' },
];

export function FloatingNav() {
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const handleNav = (to: string) => {
    setIsOpen(false);
    navigate(to);
  };

  // Broadcast state
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('floating-nav', { detail: { open: isOpen } }));
  }, [isOpen]);

  // Close on route change
  useEffect(() => {
    setIsOpen(false);
  }, [location.pathname]);

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm transition-opacity"
          onClick={() => setIsOpen(false)}
        />
      )}

      <div className="fixed bottom-6 right-5 z-50">
        {/* Expanded menu */}
        <div
          className={cn(
            'absolute bottom-14 right-0 w-48 rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden transition-all duration-300',
            isOpen
              ? 'opacity-100 translate-y-0 scale-100'
              : 'opacity-0 translate-y-3 scale-95 pointer-events-none',
          )}
          style={{ transformOrigin: 'bottom right' }}
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.to;
            return (
              <button
                key={item.to}
                onClick={() => handleNav(item.to)}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-3.5 transition-colors text-left',
                  isActive
                    ? 'text-primary-400 bg-primary-600/10'
                    : 'text-slate-400 active:bg-slate-800',
                )}
              >
                <Icon size={18} strokeWidth={1.6} />
                <span className="text-sm font-medium">{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Trigger button */}
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            'w-11 h-11 rounded-full flex items-center justify-center transition-all duration-300',
            'bg-slate-900 border border-slate-700/60 shadow-md shadow-slate-950/40',
            isOpen && 'border-slate-600 bg-slate-800',
          )}
        >
          <div className="relative w-5 h-5">
            <div className={cn(
              'absolute inset-0 transition-all duration-300',
              isOpen ? 'opacity-0 scale-0 rotate-180' : 'opacity-100 scale-100 rotate-0',
            )}>
              <Menu size={20} className="text-slate-400" strokeWidth={1.6} />
            </div>
            <div className={cn(
              'absolute inset-0 transition-all duration-300',
              isOpen ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-0 -rotate-180',
            )}>
              <X size={20} className="text-slate-400" strokeWidth={1.6} />
            </div>
          </div>
        </button>
      </div>
    </>
  );
}

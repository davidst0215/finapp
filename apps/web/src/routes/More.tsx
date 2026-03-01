import { useAuthStore } from '@/stores/authStore';
import { LogOut, PieChart, Target, Bell, MessageSquare, Settings, CreditCard } from 'lucide-react';
import { Link } from 'react-router-dom';

const menuItems = [
  { to: '/budgets', icon: PieChart, label: 'Presupuestos', desc: 'Control de gastos por categoría' },
  { to: '/goals', icon: Target, label: 'Metas de ahorro', desc: 'Alcanza tus objetivos financieros' },
  { to: '/recurring', icon: CreditCard, label: 'Recurrentes', desc: 'Suscripciones y pagos fijos' },
  { to: '/alerts', icon: Bell, label: 'Alertas', desc: 'Notificaciones y recordatorios' },
  { to: '/ai-chat', icon: MessageSquare, label: 'Asistente IA', desc: 'Pregunta sobre tus finanzas', soon: true },
  { to: '/settings', icon: Settings, label: 'Configuración', desc: 'Cuenta y preferencias', soon: true },
];

export function MorePage() {
  const { profile, signOut } = useAuthStore();

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">Más</h1>

      {/* Perfil */}
      <div className="card flex items-center gap-3">
        <div className="w-12 h-12 rounded-full bg-primary-600 flex items-center justify-center text-lg font-bold">
          {profile?.display_name?.charAt(0).toUpperCase() ?? 'U'}
        </div>
        <div>
          <p className="font-semibold">{profile?.display_name}</p>
          <p className="text-xs text-slate-500">Plan gratuito</p>
        </div>
      </div>

      {/* Menu */}
      <div className="space-y-1.5">
        {menuItems.map(({ to, icon: Icon, label, desc, soon }) => (
          <Link
            key={to}
            to={soon ? '#' : to}
            className="card flex items-center gap-3 py-3 active:bg-slate-800 transition-colors"
          >
            <Icon size={20} className="text-slate-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{label}</p>
              <p className="text-xs text-slate-500">{desc}</p>
            </div>
            {soon && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-500">Próximamente</span>
            )}
          </Link>
        ))}
      </div>

      {/* Cerrar sesión */}
      <button
        onClick={signOut}
        className="w-full flex items-center justify-center gap-2 py-3 text-expense text-sm font-medium"
      >
        <LogOut size={16} /> Cerrar sesión
      </button>
    </div>
  );
}

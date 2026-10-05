import { useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { readTheme, setTheme, type ThemeMode } from '@/lib/theme';
import { guardarEscucharAlAbrir, leerEscucharAlAbrir } from '@/lib/conversacion';
import { Switch } from '@/components/claude/Switch';
import { LogOut, Sun, Moon, SunMoon, Wallet, Target, PiggyBank, CreditCard, Bell, BellRing, ChevronRight, CalendarDays, BarChart3, Video, Mail, Search, Terminal, MessageSquare } from 'lucide-react';
import { Link } from 'react-router-dom';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { GlassCard } from '@/components/ui/GlassCard';

export function MorePage() {
  const { profile, user, signOut } = useAuthStore();
  const [theme, setThemeState] = useState<ThemeMode>(readTheme);
  const chooseTheme = (mode: ThemeMode) => { setTheme(mode); setThemeState(mode); };
  const [escucharAlAbrir, setEscucharAlAbrir] = useState(leerEscucharAlAbrir);
  const cambiarEscucharAlAbrir = (activo: boolean) => { guardarEscucharAlAbrir(activo); setEscucharAlAbrir(activo); };
  const avatarUrl = user?.user_metadata?.['avatar_url'] as string | undefined;

  return (
    <div className="space-y-6">
      {/* Header */}
      <GlassCard variant="accent" className="flex items-center gap-4 py-5">
        <UserAvatar name={profile?.display_name} imageUrl={avatarUrl} size="lg" verified />
        <div className="flex-1 min-w-0">
          <p className="font-bold text-lg text-slate-100 truncate">{profile?.display_name}</p>
          <p className="text-xs text-slate-500 mt-0.5 truncate">{user?.email}</p>
        </div>
      </GlassCard>

      {/* Módulos del asistente */}
      <div>
        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2 px-1">
          Asistente
        </p>
        <GlassCard className="p-0 divide-y divide-slate-800/40">
          {[
            { to: '/brief', icon: Sun, label: 'Brief del día', desc: 'Agenda, vencidas, pagos y esperas' },
            { to: '/reuniones', icon: Video, label: 'Reuniones', desc: 'Fathom y lo que esperas de otros' },
            { to: '/correo', icon: Mail, label: 'Correo', desc: 'Importantes y borradores para aprobar' },
            { to: '/buscar', icon: Search, label: 'Buscar en proyectos', desc: 'Pregunta con la fuente citada' },
            { to: '/claude', icon: Terminal, label: 'Claude Code', desc: 'Tus sesiones como chats' },
            { to: '/ai-chat', icon: MessageSquare, label: 'Chat con Wabid', desc: 'Conversación por texto' },
            { to: '/avisos', icon: BellRing, label: 'Avisos', desc: 'Notificaciones en este celular y bandeja' },
          ].map(({ to, icon: Icon, label, desc }) => (
            <Link key={to} to={to}
              className="flex items-center gap-3.5 px-4 py-3.5 active:bg-slate-800/30 transition-colors">
              <div className="w-9 h-9 rounded-xl bg-slate-800/60 flex items-center justify-center flex-shrink-0">
                <Icon size={17} className="text-primary-400" strokeWidth={1.6} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-200">{label}</p>
                <p className="text-[11px] text-slate-500">{desc}</p>
              </div>
              <ChevronRight size={15} className="text-slate-500 flex-shrink-0" />
            </Link>
          ))}
        </GlassCard>
      </div>

      {/* Quick actions — most used */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { to: '/accounts', icon: Wallet, label: 'Cuentas' },
          { to: '/recurring', icon: CreditCard, label: 'Pagos' },
          { to: '/calendar', icon: CalendarDays, label: 'Calendario' },
          { to: '/alerts', icon: Bell, label: 'Alertas' },
        ].map(({ to, icon: Icon, label }) => (
          <Link key={to} to={to} className="flex flex-col items-center gap-1.5 py-3 rounded-xl active:bg-slate-800/30 transition-colors">
            <div className="w-10 h-10 rounded-xl bg-slate-800/60 flex items-center justify-center">
              <Icon size={18} className="text-primary-400" strokeWidth={1.5} />
            </div>
            <span className="text-[10px] text-slate-400 font-medium">{label}</span>
          </Link>
        ))}
      </div>

      {/* Planning */}
      <div>
        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2 px-1">
          Planificación
        </p>
        <GlassCard className="p-0 divide-y divide-slate-800/40">
          {[
            { to: '/budgets', icon: Target, label: 'Presupuestos', desc: 'Límites mensuales por categoría' },
            { to: '/goals', icon: PiggyBank, label: 'Metas de ahorro', desc: 'Objetivos y progreso' },
            { to: '/reports', icon: BarChart3, label: 'Reportes', desc: 'Análisis y gráficos' },
          ].map(({ to, icon: Icon, label, desc }) => (
            <Link key={to} to={to}
              className="flex items-center gap-3.5 px-4 py-3.5 active:bg-slate-800/30 transition-colors">
              <div className="w-9 h-9 rounded-xl bg-slate-800/60 flex items-center justify-center flex-shrink-0">
                <Icon size={17} className="text-primary-400" strokeWidth={1.6} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-200">{label}</p>
                <p className="text-[11px] text-slate-500">{desc}</p>
              </div>
              <ChevronRight size={15} className="text-slate-600 flex-shrink-0" />
            </Link>
          ))}
        </GlassCard>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2 px-1">
          Voz
        </p>
        <div className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900 py-1.5 pl-4 pr-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-slate-100">Escuchar al abrir Wabid</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Configura el doble toque atrás del celular para abrir Wabid y háblale sin tocar la pantalla.
            </p>
          </div>
          <Switch checked={escucharAlAbrir} onChange={cambiarEscucharAlAbrir} label="Escuchar al abrir Wabid" />
        </div>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2 px-1">
          Apariencia
        </p>
        <div role="radiogroup" aria-label="Tema" className="flex gap-1 rounded-xl border border-slate-700 bg-slate-900 p-1">
          {([
            { mode: 'light', label: 'Claro', icon: Sun },
            { mode: 'dark', label: 'Oscuro', icon: Moon },
            { mode: 'auto', label: 'Automático', icon: SunMoon },
          ] as const).map(({ mode, label, icon: Icon }) => (
            <button key={mode} type="button" role="radio" aria-checked={theme === mode}
              onClick={() => chooseTheme(mode)}
              className={theme === mode
                ? 'flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-semibold bg-primary-600 text-slate-950'
                : 'flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-medium text-slate-400 active:bg-slate-800'}>
              <Icon size={15} strokeWidth={1.8} /> {label}
            </button>
          ))}
        </div>
      </div>

      {/* Sign out */}
      <button onClick={signOut}
        className="w-full flex items-center justify-center gap-2 py-3 text-slate-500 text-sm active:text-expense transition-colors">
        <LogOut size={15} /> Cerrar sesión
      </button>
    </div>
  );
}

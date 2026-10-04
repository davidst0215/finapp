import type { LucideIcon } from 'lucide-react';

// Pantalla provisoria de un módulo de Wabid mientras se construye.
export function ModulePlaceholder({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{title}</h1>
      <div className="card flex flex-col items-center text-center gap-3 py-10">
        <div className="w-12 h-12 rounded-2xl bg-slate-800 flex items-center justify-center">
          <Icon size={22} className="text-slate-200" strokeWidth={1.6} />
        </div>
        <p className="text-slate-200 font-semibold">En construcción</p>
        <p className="text-sm text-slate-400 max-w-[30ch]">{description}</p>
      </div>
    </div>
  );
}

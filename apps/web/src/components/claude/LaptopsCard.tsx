import { useState } from 'react';
import { Laptop, Plus, Unplug } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { timeAgo } from './format';
import { Switch } from './Switch';
import type { DeviceView } from './types';

interface Props {
  devices: DeviceView[];
  /** Date.now() para los textos relativos. */
  now: number;
  onToggleApprovals: (deviceId: string, enabled: boolean) => void;
  onRevoke: (deviceId: string) => void;
  onConnect: () => void;
}

export function LaptopsCard({ devices, now, onToggleApprovals, onRevoke, onConnect }: Props) {
  const [revoking, setRevoking] = useState<DeviceView | null>(null);

  return (
    <section className="divide-y divide-slate-700 rounded-2xl border border-slate-700 bg-slate-800/40 p-0" aria-label="Laptops conectadas">
      {devices.map((d) => (
        <div key={d.id} className="space-y-3 px-4 py-3.5">
          <div className="flex items-center gap-3">
            <Laptop size={20} strokeWidth={1.7} className="flex-shrink-0 text-slate-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold text-slate-100">{d.name}</p>
              <p className="text-[13px] text-slate-400">
                {d.last_seen_at ? `Última señal ${timeAgo(d.last_seen_at, now)}` : 'Aún no envía nada. Termina la instalación en la laptop.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setRevoking(d)}
              aria-label={`Desconectar ${d.name}`}
              className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-slate-400 active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              <Unplug size={18} strokeWidth={1.7} aria-hidden="true" />
            </button>
          </div>

          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-slate-100">Modo ausente</p>
              <p className="text-[13px] text-slate-400">
                {d.approvals_enabled
                  ? 'Activado: los permisos te llegan al chat y la laptop espera tus mensajes unos 2 min tras cada turno. Sin respuesta, se pregunta en la terminal.'
                  : 'Apagado: los permisos se contestan en la terminal. Actívalo cuando te alejes.'}
              </p>
            </div>
            <Switch
              checked={d.approvals_enabled}
              onChange={(next) => onToggleApprovals(d.id, next)}
              label={`Modo ausente en ${d.name}`}
            />
          </div>
        </div>
      ))}

      <div className="px-4 py-3">
        <button
          type="button"
          onClick={onConnect}
          className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-slate-300 active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
          Conectar otra laptop
        </button>
      </div>

      <ConfirmDialog
        open={revoking !== null}
        title={`Desconectar ${revoking?.name ?? ''}`}
        message="Dejará de enviar sus conversaciones y de pedir permisos al celular. Para volver a conectarla tendrás que generar un token nuevo."
        confirmLabel="Desconectar"
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking) onRevoke(revoking.id);
          setRevoking(null);
        }}
      />
    </section>
  );
}

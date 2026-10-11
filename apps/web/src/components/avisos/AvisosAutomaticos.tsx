import { AlertCircle } from 'lucide-react';
import { SwitchRow } from './SwitchRow';
import type { PrefKey, Prefs, ProgramadosStatus } from './useProgramados';

type Props = {
  prefs: Prefs;
  status: ProgramadosStatus;
  /** Preferencia que se está guardando (su interruptor queda quieto hasta que termine). */
  guardando: PrefKey | null;
  error: string | null;
  onChange: (key: PrefKey, value: boolean) => void;
};

// Los avisos que Wabid manda sola, sin que se los pidas. Apagar uno no borra nada: lo que ya estaba por salir y no caducó
// sale si lo vuelves a encender.
export function AvisosAutomaticos({ prefs, status, guardando, error, onChange }: Props) {
  // Mientras no hay preferencias leídas el interruptor no responde: un toque ahí podría pisar lo que aún no se vio.
  const quieto = (key: PrefKey) => status !== 'ready' || guardando === key;

  return (
    <section aria-labelledby="avisos-automaticos">
      <div className="mb-2 flex min-h-[44px] items-center">
        <h2 id="avisos-automaticos" className="text-lg font-bold text-slate-100">
          Avisos automáticos
        </h2>
      </div>
      <div className="card divide-y divide-slate-700 p-0">
        <SwitchRow
          title="Avisos de vencimientos"
          description="Un día antes, a las 9:00, de tus pagos fijos y del pago de tus tarjetas."
          checked={prefs.vencimientos}
          disabled={quieto('vencimientos')}
          onChange={() => onChange('vencimientos', !prefs.vencimientos)}
        />
        <SwitchRow
          title="Avisos de presupuesto"
          description="Cuando un gasto pasa el umbral de un presupuesto del mes (80 % por defecto) y cuando lo supera. Una vez por mes."
          checked={prefs.presupuestos}
          disabled={quieto('presupuestos')}
          onChange={() => onChange('presupuestos', !prefs.presupuestos)}
        />
      </div>
      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-base text-expense">
          <AlertCircle size={18} strokeWidth={1.8} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}

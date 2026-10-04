import { useState } from 'react';
import { GoogleUiError, googleCall } from './googleApi';

type Props = { email: string; onDisconnected: () => void };

/** Cuenta conectada y salida. Desconectar revoca el acceso en Google y borra los tokens; pide confirmación en línea. */
export function GoogleAccountFooter({ email, onDisconnected }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await googleCall('disconnect');
      onDisconnected();
    } catch (e) {
      setError(e instanceof GoogleUiError ? e.message : 'No pude desconectar. Intenta de nuevo.');
      setBusy(false);
    }
  };

  if (confirming) {
    return (
      <div className="space-y-3 rounded-xl border border-slate-700 p-3" role="group" aria-label="Confirmar desconexión">
        <p className="text-base text-slate-200">
          Wabid dejará de ver la agenda y el correo de <span className="font-semibold text-slate-100">{email}</span>.
        </p>
        {error && <p role="alert" className="text-sm text-expense">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="btn-secondary min-h-[44px] flex-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-100">
            Cancelar
          </button>
          <button type="button" onClick={disconnect} disabled={busy} className="btn-primary min-h-[44px] flex-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-100">
            {busy ? 'Desconectando…' : 'Desconectar'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 px-1 text-sm text-slate-400">
      <span className="min-w-0 truncate">Cuenta: {email}</span>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="min-h-[44px] flex-none rounded-lg px-2 font-semibold text-slate-200 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-100"
      >
        Desconectar
      </button>
    </div>
  );
}

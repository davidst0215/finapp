import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { ApiError } from './api';
import type { PairedDevice } from './types';

interface Props {
  onPair: (name: string) => Promise<PairedDevice>;
  onClose: () => void;
}

const DEFAULT_NAME = 'Mi laptop';

// Conectar una laptop sin modal: el token se muestra una sola vez en la propia pantalla y queda solo en memoria.
export function PairDevicePanel({ onPair, onClose }: Props) {
  const [name, setName] = useState(DEFAULT_NAME);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<PairedDevice | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInput.current?.select();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      setPaired(await onPair(name.trim() || DEFAULT_NAME));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo generar el token. Reintenta.');
    } finally {
      setCreating(false);
    }
  };

  if (!paired) {
    return (
      <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-700 bg-slate-800/40 p-4">
        <div className="space-y-2">
          <label htmlFor="claude-device-name" className="text-base font-bold text-slate-100">
            ¿Cómo se llama esta laptop?
          </label>
          <input
            id="claude-device-name"
            ref={nameInput}
            className="input"
            value={name}
            maxLength={60}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {error && <p role="alert" className="text-sm text-expense">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <button type="button" onClick={onClose} className="btn-secondary min-h-[48px]">
            Cancelar
          </button>
          <button type="submit" disabled={creating} className="btn-primary flex min-h-[48px] items-center justify-center gap-2">
            {creating && <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            Generar token
          </button>
        </div>
      </form>
    );
  }

  return (
    <section className="space-y-4 rounded-2xl border border-slate-700 bg-slate-800/40 p-4" aria-labelledby="claude-pair-title">
      <div className="space-y-1">
        <h2 id="claude-pair-title" className="text-base font-bold text-slate-100">
          {paired.device.name} está lista para conectarse
        </h2>
        <p className="text-sm text-slate-300">Copia el token ahora: no se vuelve a mostrar. Si lo pierdes, revoca la laptop y genera otro.</p>
      </div>

      <CopyField label="URL de Wabid" value={paired.url} />
      <CopyField label="Token del dispositivo" value={paired.token} />

      <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-300 marker:font-bold marker:text-slate-100">
        <li>
          En la laptop, desde la carpeta del repo, ejecuta{' '}
          <code className="break-all rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[13px] text-slate-100">node tools/claude-hooks/wabid-hook.mjs setup</code> y pega la URL y el token.
        </li>
        <li>
          Instala los hooks con{' '}
          <code className="break-all rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[13px] text-slate-100">node tools/claude-hooks/instalar-hooks.mjs</code> y reinicia Claude Code.
        </li>
        <li>Vuelve aquí y activa el modo ausente cuando te alejes de la laptop.</li>
      </ol>

      <button type="button" onClick={onClose} className="btn-primary min-h-[48px] w-full">
        Listo, ya los copié
      </button>
    </section>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sin permiso del portapapeles: el texto queda seleccionable (mantén presionado).
      setCopied(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <p className="text-[13px] font-semibold text-slate-300">{label}</p>
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded-xl border border-slate-700 bg-slate-800 p-3 font-mono text-sm text-slate-100">
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copiar ${label.toLowerCase()}`}
          className="btn-secondary flex min-h-[44px] min-w-[44px] flex-shrink-0 items-center justify-center px-3"
        >
          {copied ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
          <span className="sr-only" aria-live="polite">
            {copied ? 'Copiado' : ''}
          </span>
        </button>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { CalendarDays, Loader2, Mail } from 'lucide-react';
import { GoogleUiError, startGoogleConnect } from './googleApi';

type Props = {
  /** connect: aún no conectado · reauth: Google cerró la conexión · permission: falta un permiso concreto */
  variant: 'connect' | 'reauth' | 'permission';
  email?: string;
  /** Qué permiso falta (solo con variant="permission") */
  need?: 'agenda' | 'correo';
  /** Mensaje de un intento anterior fallido (p. ej. al volver del consentimiento) */
  notice?: string | null;
};

const REGLAS = [
  'Ve y crea eventos. No invita a nadie ni manda avisos.',
  'Lee tu correo y deja borradores de respuesta.',
  'No envía nada sin que toques «Enviar».',
];

const COPY = {
  connect: { title: 'Conecta tu Google', button: 'Conectar Google' },
  reauth: { title: 'Reconecta tu Google', button: 'Reconectar Google' },
  permission: { title: 'Falta un permiso', button: 'Reconectar Google' },
} as const;

/** Tarjeta para conectar (o reconectar) la cuenta de Google. Vive en Agenda y en Correo. */
export function ConnectGoogle({ variant, email, need, notice }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await startGoogleConnect(); // navega a Google; si vuelve, es que falló
    } catch (e) {
      setError(e instanceof GoogleUiError ? e.message : 'No pude abrir Google. Intenta de nuevo.');
      setBusy(false);
    }
  };

  const copy = COPY[variant];
  const intro =
    variant === 'connect'
      ? 'Wabid usa tu cuenta de trabajo para mostrarte el día y dejarte listos los borradores.'
      : variant === 'reauth'
        ? `Google cerró la conexión${email ? ` con ${email}` : ''}. Vuelve a conectarla para seguir viendo tu agenda y tu correo.`
        : `Conectaste Google, pero no diste permiso para ${need === 'correo' ? 'leer el correo' : 'ver la agenda'}. Reconecta y deja marcadas todas las casillas.`;

  return (
    <section className="card space-y-4" aria-labelledby="connect-title">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 flex-none items-center justify-center rounded-xl border border-slate-700 bg-slate-800" aria-hidden="true">
          {need === 'correo' ? <Mail size={20} strokeWidth={1.7} className="text-slate-200" /> : <CalendarDays size={20} strokeWidth={1.7} className="text-slate-200" />}
        </div>
        <h2 id="connect-title" className="text-xl font-bold text-slate-100">{copy.title}</h2>
      </div>

      {notice && (
        <p role="alert" className="rounded-xl border border-expense/50 px-3 py-2.5 text-sm text-expense">
          {notice}
        </p>
      )}

      <p className="text-base leading-relaxed text-slate-200">{intro}</p>

      {variant === 'connect' && (
        <ul className="space-y-2 text-base text-slate-200">
          {REGLAS.map((r) => (
            <li key={r} className="flex gap-2.5">
              <span aria-hidden="true" className="mt-[0.6em] h-1.5 w-1.5 flex-none rounded-full bg-slate-400" />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="text-sm text-expense">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={connect}
        disabled={busy}
        className="btn-primary inline-flex min-h-[48px] w-full items-center justify-center gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-100"
      >
        {busy ? (
          <>
            <Loader2 size={18} className="motion-safe:animate-spin" aria-hidden="true" /> Abriendo Google…
          </>
        ) : (
          copy.button
        )}
      </button>
    </section>
  );
}

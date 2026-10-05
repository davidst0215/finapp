import { useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import type { ConversationTone } from './conversations';
import { StateDot } from './StateDot';

// Con el teclado abierto el área visible es menor que la ventana: la pantalla sigue al viewport visual para que el
// compositor quede pegado al teclado (Android e iOS).
function useVisualViewport() {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setBox({ top: vv.offsetTop, height: vv.height });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return box;
}

interface Props {
  title: string;
  /** Segunda línea del encabezado (estado + laptop). Sin ella, el título va solo. */
  subtitle?: React.ReactNode;
  tone?: ConversationTone;
  onBack: () => void;
  backLabel?: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  footer: React.ReactNode;
}

// Pantalla completa de chat (conversación, nueva tarea): cubre también la barra de pestañas, como cualquier app de
// mensajes. El botón atrás del sistema vuelve a la lista (cada pantalla es una ruta).
export function ScreenShell({ title, subtitle, tone, onBack, backLabel = 'Volver a las conversaciones', headerRight, children, footer }: Props) {
  const viewport = useVisualViewport();
  return (
    <div className="fixed inset-x-0 z-50 bg-slate-950" style={viewport ? { top: viewport.top, height: viewport.height } : { top: 0, bottom: 0 }}>
      <div className="mx-auto flex h-full max-w-lg flex-col">
        <header className="flex items-center gap-1 border-b border-slate-700 bg-slate-950 pb-2 pl-1.5 pr-2" style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
          <button
            type="button"
            onClick={onBack}
            aria-label={backLabel}
            className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-full text-slate-100 active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <ChevronLeft size={26} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-bold leading-tight text-slate-100">{title}</h1>
            {subtitle && (
              <p className="mt-0.5 flex items-center gap-2 text-[13px] leading-tight text-slate-400">
                {tone && <StateDot tone={tone} />}
                <span className="min-w-0 truncate">{subtitle}</span>
              </p>
            )}
          </div>
          {headerRight}
        </header>
        {children}
        {footer}
      </div>
    </div>
  );
}
